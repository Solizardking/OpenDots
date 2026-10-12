import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateKeyPairSync,
  sign,
  randomBytes,
  createHmac,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import bs58 from 'bs58';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHybridAuth } from '../src/server/better-auth.js';
import { PrivyAuth } from '../src/server/privy-auth.js';
import { PostgresUserDatabase } from '../src/server/user-database.js';
import { SolanaAuth } from '../src/server/solana-auth.js';
import { UserWorkspaces } from '../src/server/user-workspaces.js';

const connection = process.env.HYBRID_TEST_POSTGRES_URL;
describe.skipIf(!connection)('hybrid identity with real PostgreSQL', () => {
  const origin = 'https://chatgptee.ai';
  const secret = randomBytes(40).toString('base64url');
  const proxySecret = randomBytes(40).toString('base64url');
  const directory = connection
    ? mkdtempSync(join(tmpdir(), 'chatgptee-hybrid-'))
    : '';
  const database = new PostgresUserDatabase(
    connection || 'postgresql://unused@127.0.0.1:1/unused',
  );
  const app = new Hono();
  const workspaces = new UserWorkspaces(
    join(directory, 'users'),
    {
      model: 'fixture',
      apiKey: 'fixture',
      baseUrl: 'https://invalid.example/v1',
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
    },
    [origin],
  );
  let hybrid: Awaited<ReturnType<typeof createHybridAuth>>;
  let issue: (
    address: string | undefined,
    subject?: string,
    audience?: string,
  ) => Promise<string>;
  const claims = new Map<string, string>();
  const socials = new Map<string, string>();
  let captureQueries = false;
  const capturedQueries: string[] = [];
  database.pool.on('connect', (client) => {
    const original = client.query;
    client.query = new Proxy(original, {
      apply(target, thisArg, args: unknown[]) {
        if (captureQueries) {
          const query = args[0];
          capturedQueries.push(
            typeof query === 'string'
              ? query
              : query &&
                  typeof query === 'object' &&
                  'text' in query &&
                  typeof query.text === 'string'
                ? query.text
                : '',
          );
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  beforeAll(async () => {
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(
      new URL(connection!).hostname,
    ); // This suite may create browser roles only in disposable local PostgreSQL.
    const tables = await database.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    );
    expect(tables.rows).toEqual([]); // Never run against a reused or production DB.
    // Generic PostgreSQL has no Supabase browser roles; initialization still works.
    await database.initialize();
    await database.pool.query(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC;
      GRANT ALL PRIVILEGES ON TABLE solana_dots_users, solana_dots_auth_challenges, solana_dots_sessions TO PUBLIC, anon, authenticated;
      CREATE TABLE unrelated_public_table(id integer);
    `);
    await database.initialize();
    const keys = await generateKeyPair('ES256');
    const publicKey = await exportJWK(keys.publicKey);
    issue = async (
      address,
      subject = 'did:privy:' + address,
      audience = 'fixture-app',
    ) => {
      if (address) claims.set(subject, address);
      return new SignJWT({ sid: 'fixture-session' })
        .setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
        .setSubject(subject)
        .setIssuer('privy.io')
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(keys.privateKey);
    };
    const privy = new PrivyAuth(
      { appId: 'fixture-app', appSecret: 'fixture-secret' },
      (async (input) => {
        const subject = decodeURIComponent(String(input).split('/').at(-1)!);
        return Response.json({
          id: subject,
          linked_accounts: socials.has(subject)
            ? [
                {
                  type: socials.get(subject) + '_oauth',
                  name: 'Social member',
                  email: 'shared@example.invalid',
                },
              ]
            : [
                {
                  type: 'wallet',
                  chain_type: 'solana',
                  address: claims.get(subject),
                },
              ],
        });
      }) as typeof fetch,
      createLocalJWKSet({
        keys: [{ ...publicKey, kid: 'fixture', alg: 'ES256' }],
      }),
    );
    hybrid = await createHybridAuth({
      users: database,
      privy,
      stateDir: directory,
      origin,
      env: {
        BETTER_AUTH_SECRET: secret,
        CHATGPTEE_PROXY_SECRET: proxySecret,
        GOOGLE_CLIENT_ID: 'fixture-google',
        GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
        GITHUB_CLIENT_ID: 'fixture-github',
        GITHUB_CLIENT_SECRET: 'fixture-github-secret',
        TWITTER_CLIENT_ID: 'fixture-x',
        TWITTER_CLIENT_SECRET: 'fixture-x-secret',
      },
    });
    app.route('/api/auth', hybrid.routes);
    app.all('/api/*', async (c) => {
      const user = await hybrid.user(c);
      return user
        ? workspaces.app(user).fetch(c.req.raw)
        : c.json({ error: 'Sign in.' }, 401);
    });
  });
  beforeEach(async () => {
    // Each isolated scenario starts with its own rate-limit window.
    await database.pool.query('DELETE FROM chatgptee_auth_rate_limit');
  });
  afterAll(async () => {
    workspaces.stopRunners();
    await workspaces.stop();
    await database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function wallet() {
    const keys = generateKeyPairSync('ed25519');
    const address = bs58.encode(
      keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    );
    return {
      address,
      sign: (text: string) =>
        bs58.encode(sign(null, Buffer.from(text), keys.privateKey)),
    };
  }
  function browser(ip = '203.0.113.17') {
    const jar = new Map<string, string>();
    const cookie = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
    const request = async (
      path: string,
      body?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const response = await app.request(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          Cookie: cookie(),
          'x-chatgptee-proxy-secret': proxySecret,
          'x-chatgptee-client-ip': ip,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(';')[0],
          index = pair.indexOf('=');
        if (pair.slice(index + 1))
          jar.set(pair.slice(0, index), pair.slice(index + 1));
        else jar.delete(pair.slice(0, index));
      }
      return response;
    };
    const login = async (
      key: ReturnType<typeof wallet>,
      purpose = 'sign-in',
    ) => {
      const nonce = await (
        await request('/api/auth/solana/nonce', {
          address: key.address,
          purpose,
        })
      ).json();
      const proof = {
        nonce: nonce.input.nonce,
        message: nonce.message,
        signature: key.sign(nonce.message),
      };
      return {
        response: await request('/api/auth/solana/verify', proof),
        proof,
      };
    };
    return { jar, cookie, request, login };
  }
  it('rejects origin bypass and malformed edge identities before any rate-limit write', async () => {
    for (const headers of [
      {},
      {
        'x-chatgptee-proxy-secret': 'wrong',
        'x-chatgptee-client-ip': '203.0.113.1',
      },
      {
        'x-chatgptee-proxy-secret': proxySecret,
        'x-chatgptee-client-ip': '203.0.113.1, 203.0.113.2',
      },
    ]) {
      const response = await app.request(origin + '/api/auth/config', {
        headers: headers as Record<string, string>,
      });
      expect(response.status).toBe(403);
    }
    expect(
      (
        await database.pool.query(
          'SELECT count(*) AS count FROM chatgptee_auth_rate_limit',
        )
      ).rows[0].count,
    ).toBe('0');
  });
  it('persists independent IP buckets and rejects attempts to rotate forwarding headers', async () => {
    const first = browser('203.0.113.71');
    const second = browser('203.0.113.72');
    const address = wallet().address;
    for (let n = 0; n < 10; n++)
      expect(
        (await first.request('/api/auth/solana/nonce', { address })).status,
      ).toBe(200);
    const limited = await first.request(
      '/api/auth/solana/nonce',
      { address },
      {
        'cf-connecting-ip': '198.51.100.80',
        'x-forwarded-for': '198.51.100.81',
        'x-real-ip': '198.51.100.82',
      },
    );
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('x-retry-after'))).toBeGreaterThan(0);
    expect(
      (await second.request('/api/auth/solana/nonce', { address })).status,
    ).toBe(200);
    const counters = await database.pool.query(
      'SELECT key,count FROM chatgptee_auth_rate_limit',
    );
    expect(
      counters.rows.filter((row) => row.key.includes('203.0.113.71')),
    ).toHaveLength(1);
    expect(
      counters.rows.filter((row) => row.key.includes('203.0.113.72')),
    ).toHaveLength(1);
    expect(counters.rows.some((row) => row.key.includes('198.51.100.'))).toBe(
      false,
    );
    expect(counters.rows.some((row) => row.key.includes('no-trusted-ip'))).toBe(
      false,
    );
  });
  it('keeps IPv6 addresses in the same /64 in one rate-limit bucket', async () => {
    const first = browser('2001:db8:abcd:1234::1'),
      sameSubnet = browser('2001:0db8:abcd:1234::2'),
      otherSubnet = browser('2001:db8:abcd:1235::1');
    const address = wallet().address;
    for (let n = 0; n < 10; n++)
      expect(
        (await first.request('/api/auth/solana/nonce', { address })).status,
      ).toBe(200);
    expect(
      (await sameSubnet.request('/api/auth/solana/nonce', { address })).status,
    ).toBe(429);
    expect(
      (await otherSubnet.request('/api/auth/solana/nonce', { address })).status,
    ).toBe(200);
  });
  it('fetches an uncached session and its user using one PostgreSQL join', async () => {
    const client = browser('203.0.113.90');
    const key = wallet();
    expect((await client.login(key)).response.status).toBe(200);
    capturedQueries.length = 0;
    captureQueries = true;
    let session;
    try {
      session = await hybrid.auth.api.getSession({
        headers: new Headers({ Cookie: client.cookie() }),
      });
    } finally {
      captureQueries = false;
    }
    expect(
      session?.user && 'solanaWallet' in session.user
        ? session.user.solanaWallet
        : undefined,
    ).toBe(key.address);
    const reads = capturedQueries.filter(
      (sql) =>
        /^select /i.test(sql) && /chatgptee_auth_(session|user)/.test(sql),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/left join "chatgptee_auth_user"/i);
    expect(hybrid.auth.options.advanced?.database?.joins).toBe(true);
  });
  it('keeps backend auth tables private while retaining owner access and unrelated table grants', async () => {
    const names = [
      'solana_dots_users',
      'solana_dots_auth_challenges',
      'solana_dots_sessions',
      'chatgptee_auth_user',
      'chatgptee_auth_account',
      'chatgptee_auth_session',
      'chatgptee_auth_verification',
      'chatgptee_auth_rate_limit',
    ];
    const result = await database.pool.query<{
      name: string;
      rls: boolean;
      forced: boolean;
      anon: boolean;
      authenticated: boolean;
      publicGrants: number;
      policies: number;
    }>(
      `SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
         has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS anon,
         has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS authenticated,
         (SELECT count(*)::integer FROM aclexplode(c.relacl) WHERE grantee=0) AS "publicGrants",
         (SELECT count(*)::integer FROM pg_policy WHERE polrelid=c.oid) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname=ANY($1) ORDER BY c.relname`,
      [names],
    );
    expect(result.rows.map((row) => row.name)).toEqual([...names].sort());
    for (const row of result.rows)
      expect(row).toEqual({
        name: row.name,
        rls: true,
        forced: false,
        anon: false,
        authenticated: false,
        publicGrants: 0,
        policies: 0,
      });
    expect(
      (
        await database.pool.query(
          "SELECT has_table_privilege('anon', 'public.unrelated_public_table', 'SELECT') AS allowed",
        )
      ).rows[0].allowed,
    ).toBe(true);
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE anon');
      await expect(
        client.query('SELECT * FROM public.chatgptee_auth_session'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // The backend owner still accesses the tables without a browser policy.
    await expect(
      database.pool.query('SELECT * FROM public.chatgptee_auth_session'),
    ).resolves.toHaveProperty('rows');
    // Re-running startup restrictions keeps the same privacy guarantees.
    await database.initialize();
    await database.protectBetterAuthTables();
  });
  it('preserves a legacy workspace UUID and its private conversations through Solana migration, reload and logout', async () => {
    const key = wallet();
    const old = await database.createSession(
      key.address,
      randomBytes(32).toString('hex'),
      new Date(Date.now() + 86400000),
    );
    const legacy = new SolanaAuth(database);
    const oldBrowser = browser();
    // Mint a real legacy session through the existing signed challenge flow.
    const legacyRoutes = legacy.routes();
    const challengeResponse = await legacyRoutes.request(
      origin + '/challenge',
      {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: key.address }),
      },
    );
    const challenge = await challengeResponse.json();
    const binding = challengeResponse.headers.getSetCookie()[0].split(';')[0];
    const verified = await legacyRoutes.request(origin + '/verify', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: binding,
      },
      body: JSON.stringify({
        id: challenge.id,
        address: key.address,
        message: challenge.message,
        signature: key.sign(challenge.message),
      }),
    });
    const sessionCookie = verified.headers
      .getSetCookie()
      .find((x) => x.startsWith('solana-dots-session='))!
      .split(';')[0];
    oldBrowser.jar.set('solana-dots-session', sessionCookie.split('=')[1]);
    const workspace = await (await oldBrowser.request('/api/workspace')).json();
    const thread = await (
      await oldBrowser.request('/api/conversations', {
        dotId: workspace.dots[0].id,
        title: 'Preserved private conversation',
      })
    ).json();
    const { response, proof } = await oldBrowser.login(key);
    expect(response.status).toBe(200);
    expect(oldBrowser.jar.has('solana-dots-session')).toBe(false);
    const migrated = await (
      await oldBrowser.request('/api/auth/session')
    ).json();
    expect(migrated.user.id).toBe(old.id);
    const privateThreads = await (
      await oldBrowser.request('/api/workspace')
    ).json();
    expect(JSON.stringify(privateThreads)).toContain(thread.id);
    const stranger = browser();
    expect((await stranger.login(wallet())).response.status).toBe(200);
    expect(
      JSON.stringify(await (await stranger.request('/api/workspace')).json()),
    ).not.toContain(thread.id);
    expect(
      (await stranger.request('/api/conversations/' + thread.id + '/capture'))
        .status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await oldBrowser.request('/api/auth/solana/verify', proof)).status,
    ).toBe(401);
    const saved = oldBrowser.cookie();
    expect((await oldBrowser.request('/api/auth/logout', {})).status).toBe(200);
    expect(
      (
        await app.request(origin + '/api/conversations', {
          headers: { Cookie: saved },
        })
      ).status,
    ).toBe(401);
  });
  it('opens the same workspace with Privy then a native signature and never leaks provider tokens', async () => {
    const key = wallet(),
      client = browser();
    const response = await client.request('/api/auth/privy', {
      address: key.address,
      accessToken: await issue(key.address),
    });
    expect(response.status).toBe(200);
    const privy = await response.json();
    expect(privy.user.walletAddress).toBe(key.address);
    expect(JSON.stringify(privy)).not.toContain('token');
    expect(
      response.headers
        .getSetCookie()
        .some((x) => x.includes('HttpOnly') && x.includes('Secure')),
    ).toBe(true);
    await client.request('/api/auth/logout', {});
    expect((await client.login(key)).response.status).toBe(200);
    expect(
      (await (await client.request('/api/auth/session')).json()).user.id,
    ).toBe(privy.user.id);
    const accounts = await (
      await client.request('/api/auth/list-accounts')
    ).json();
    expect(
      accounts.map((x: { providerId: string }) => x.providerId).sort(),
    ).toEqual(['privy', 'solana']);
  });
  it('rejects forged Privy proofs, a mismatched linked wallet and a wrong audience', async () => {
    const key = wallet(),
      other = wallet(),
      client = browser();
    const token = await issue(key.address);
    expect(
      (
        await client.request('/api/auth/privy', {
          address: other.address,
          accessToken: token,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await client.request('/api/auth/privy', {
          address: key.address,
          accessToken: await issue(key.address, undefined, 'other-app'),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await client.request('/api/auth/privy', {
          address: key.address,
          accessToken: token.slice(0, -8) + 'forgeddd',
        })
      ).status,
    ).toBe(401);
  });
  it('rejects cross-browser signatures, foreign origins and SIWE routes', async () => {
    const key = wallet(),
      client = browser(),
      other = browser();
    const nonce = await (
      await client.request('/api/auth/solana/nonce', { address: key.address })
    ).json();
    const point = new Uint8Array(32);
    point[0] = 1;
    const forged = new Uint8Array(64);
    forged[0] = 1;
    const weakKey = await (
      await client.request('/api/auth/solana/nonce', {
        address: bs58.encode(point),
      })
    ).json();
    expect(
      (
        await client.request('/api/auth/solana/verify', {
          nonce: weakKey.input.nonce,
          signature: bs58.encode(forged),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await other.request('/api/auth/solana/verify', {
          nonce: nonce.input.nonce,
          signature: key.sign(nonce.message),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await client.request(
          '/api/auth/solana/nonce',
          { address: key.address },
          { Origin: 'https://foreign.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await client.request(
          '/api/auth/challenge',
          { address: key.address },
          { Origin: 'https://foreign.example' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await client.request('/api/auth/privy', {
          accessToken: 'x'.repeat(9000),
          address: key.address,
        })
      ).status,
    ).toBe(413);
    expect((await client.request('/api/auth/siwe/nonce', {})).status).toBe(404);
  });
  it('keeps social-only workspace identities private and rejects claims of another existing workspace', async () => {
    const context = await hybrid.auth.$context;
    const identity = await context.internalAdapter.createUser(
      {
        name: 'Social user',
        email: 'social-fixture@example.invalid',
        emailVerified: true,
      },
      { method: 'google' },
    );
    await context.internalAdapter.createAccount({
      providerId: 'google',
      accountId: 'fixture-google-subject',
      userId: identity.id,
    });
    const session = await context.internalAdapter.createSession(identity.id);
    const value =
      session!.token +
      '.' +
      createHmac('sha256', secret).update(session!.token).digest('base64');
    const client = browser();
    client.jar.set(
      '__Secure-chatgptee.session_token',
      encodeURIComponent(value),
    );
    const account = await (await client.request('/api/auth/session')).json();
    expect(account.user.walletAddress).toBeNull();
    expect(account.user.id).toMatch(/^[0-9a-f-]{36}$/);
    const key = wallet();
    const old = await database.createSession(
      key.address,
      randomBytes(32).toString('hex'),
      new Date(Date.now() + 86400000),
    );
    expect((await client.login(key, 'link')).response.status).toBe(409);
    expect(
      (await (await client.request('/api/auth/session')).json()).user.id,
    ).toBe(account.user.id);
    expect((await database.walletIdentity(key.address))!.id).toBe(old.id);
    const fresh = wallet();
    expect((await client.login(fresh, 'link')).response.status).toBe(200);
    expect(
      (await (await client.request('/api/auth/session')).json()).user.id,
    ).toBe(account.user.id);
    const visitor = browser();
    expect((await visitor.request('/api/workspace')).status).toBe(401);
    expect((await visitor.login(fresh)).response.status).toBe(200);
    expect(
      (await (await visitor.request('/api/auth/session')).json()).user.id,
    ).toBe(account.user.id);
    // Freshness uses the actual persisted PostgreSQL session timestamp.
    await database.pool.query(
      'UPDATE chatgptee_auth_session SET "createdAt"=$2 WHERE "userId"=$1',
      [identity.id, new Date(Date.now() - 600000)],
    );
    expect(
      (
        await client.request('/api/auth/solana/nonce', {
          address: fresh.address,
          purpose: 'link',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await client.request('/api/auth/link-social', {
          provider: 'google',
          callbackURL: '/auth/account',
        })
      ).status,
    ).toBe(401);
  });
  it('advertises both auth systems, starts all three OAuth flows with canonical callbacks and rejects foreign returns', async () => {
    const client = browser();
    const config = await (await client.request('/api/auth/config')).json();
    expect(config.betterAuth).toBe(true);
    expect(config.privyAppId).toBe('fixture-app');
    expect(config.privySocialProviders).toEqual([
      'google',
      'twitter',
      'github',
    ]);
    expect(config.baseURL).toBe(origin);
    expect(config.basePath).toBe('/api/auth');
    for (const provider of ['google', 'github', 'twitter']) {
      const response = await client.request('/api/auth/sign-in/social', {
        provider,
        callbackURL: '/',
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(new URL(data.url).searchParams.get('redirect_uri')).toBe(
        origin + '/api/auth/callback/' + provider,
      );
      expect(new URL(data.url).searchParams.get('state')).toBeTruthy();
    }
    expect(
      (
        await client.request('/api/auth/sign-in/social', {
          provider: 'google',
          callbackURL: 'https://foreign.example',
        })
      ).status,
    ).toBe(403);
    const callback = await client.request(
      '/api/auth/callback/google',
      undefined,
      { 'Sec-Fetch-Site': 'cross-site' },
    );
    expect(callback.status).not.toBe(403); // Better Auth validates OAuth state itself.
  });
  it('starts private sessions from all three Privy social identities without a wallet and keeps matching emails separate', async () => {
    const ids = new Set<string>();
    for (const provider of ['google', 'twitter', 'github']) {
      const subject = 'did:privy:social-' + provider;
      socials.set(subject, provider);
      const token = await issue(undefined, subject);
      const client = browser();
      const response = await client.request('/api/auth/privy', {
        accessToken: token,
      });
      expect(response.status).toBe(200);
      const session = await response.json();
      expect(session.user.walletAddress).toBeNull();
      expect(session.user.displayName).toBe('Social member');
      expect(JSON.stringify(session)).not.toContain(token);
      ids.add(session.user.id);
      expect((await client.request('/api/workspace')).status).toBe(200);
      const accounts = await (
        await client.request('/api/auth/list-accounts')
      ).json();
      expect(accounts.map((x: { providerId: string }) => x.providerId)).toEqual(
        ['privy'],
      );
      await client.request('/api/auth/logout', {});
      expect((await client.request('/api/workspace')).status).toBe(401);
      expect(
        (await client.request('/api/auth/privy', { accessToken: token }))
          .status,
      ).toBe(200);
      expect(
        (await (await client.request('/api/auth/session')).json()).user.id,
      ).toBe(session.user.id);
      expect(
        (
          await client.request('/api/auth/privy', {
            accessToken: token.slice(0, -8) + 'forgeddd',
          })
        ).status,
      ).toBe(401);
    }
    expect(ids.size).toBe(3);
  });
  it('requires an explicit fresh workspace link for Privy social login, retains the native wallet, and refuses another identity', async () => {
    const native = browser(),
      key = wallet();
    await native.login(key);
    const workspace = await (await native.request('/api/auth/session')).json();
    const subject = 'did:privy:linked-social';
    socials.set(subject, 'google');
    const accessToken = await issue(undefined, subject);
    expect(
      (await native.request('/api/auth/privy', { accessToken })).status,
    ).toBe(409);
    const link = {
      accessToken,
      purpose: 'link',
      workspaceId: workspace.user.id,
    };
    expect((await browser().request('/api/auth/privy', link)).status).toBe(401);
    expect(
      (
        await native.request('/api/auth/privy', {
          ...link,
          workspaceId: '00000000-0000-4000-8000-000000000000',
        })
      ).status,
    ).toBe(409);
    expect((await native.request('/api/auth/privy', link)).status).toBe(200);
    const linked = await (await native.request('/api/auth/session')).json();
    expect(linked.user.id).toBe(workspace.user.id);
    expect(linked.user.walletAddress).toBe(key.address);
    await native.request('/api/auth/logout', {});
    const visitor = browser();
    expect(
      (await visitor.request('/api/auth/privy', { accessToken })).status,
    ).toBe(200);
    expect(
      (await (await visitor.request('/api/auth/session')).json()).user.id,
    ).toBe(workspace.user.id);
    const stranger = browser();
    await stranger.login(wallet());
    const other = await (await stranger.request('/api/auth/session')).json();
    expect(
      (
        await stranger.request('/api/auth/privy', {
          ...link,
          workspaceId: other.user.id,
        })
      ).status,
    ).toBe(409);
    const accounts = await (
      await visitor.request('/api/auth/list-accounts')
    ).json();
    expect(
      accounts.map((x: { providerId: string }) => x.providerId).sort(),
    ).toEqual(['privy', 'solana']);
    await database.pool.query(
      'UPDATE chatgptee_auth_session SET "createdAt"=$2 WHERE "userId"=$1',
      [
        (await database.walletIdentity(key.address))!.better_auth_user_id,
        new Date(Date.now() - 600000),
      ],
    );
    expect((await visitor.request('/api/auth/privy', link)).status).toBe(401);
  });
});
