/** Live browser + Neon verification with an ephemeral test wallet, never a user key. */
import { chromium, type Cookie } from 'playwright';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import bs58 from 'bs58';
import { PostgresUserDatabase } from '../src/server/user-database.js';
import type { SignInChallenge } from '../src/shared/auth-types.js';

const origin = process.env.VERIFY_ORIGIN ?? 'https://chatgptee.ai';
const directory = process.env.VERIFY_ARTIFACTS ?? 'artifacts/agent-access/live';
mkdirSync(directory, { recursive: true });
const pair = generateKeyPairSync('ed25519');
const fixtureWalletIds = new Set<string>();
let deviceSession: any;
const publicKey = [
  ...pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
];
const address = bs58.encode(new Uint8Array(publicKey));
const db = new PostgresUserDatabase(process.env.DATABASE_URL!);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const errors: string[] = [];
const networkFailures: {
  hostname: string;
  path: string;
  method: string;
  status: number | null;
  expected: boolean;
  failure?: string;
}[] = [];
const report: Record<string, unknown> = { origin };
let privyId: string | undefined;
let betterAuth = false;
const schema = new Map<string, Set<string>>();
const authTableNames = [
  'solana_dots_users',
  'chatgptee_auth_user',
  'chatgptee_auth_account',
  'chatgptee_auth_session',
  'chatgptee_auth_verification',
];
function safeLocation(value: string) {
  try {
    const url = new URL(value);
    return {
      hostname: url.hostname,
      path: url.pathname.replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        '[redacted]',
      ),
    };
  } catch {
    return { hostname: 'unknown', path: 'unknown' };
  }
}
function safeDiagnostic(value: string) {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
      const location = safeLocation(match);
      return `${location.hostname}${location.path}`;
    })
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[redacted token]',
    );
}
async function inspectAuthSchema() {
  const result = await db.pool.query<{
    table_name: string;
    column_name: string;
  }>(
    'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1)',
    [authTableNames],
  );
  schema.clear();
  for (const row of result.rows) {
    const columns = schema.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    schema.set(row.table_name, columns);
  }
  if (betterAuth) {
    for (const [table, columns] of [
      ['chatgptee_auth_user', ['id', 'solanaWallet']],
      ['chatgptee_auth_account', ['userId', 'providerId', 'accountId']],
      ['chatgptee_auth_session', ['userId']],
      ['chatgptee_auth_verification', ['id', 'identifier', 'value']],
    ] as const)
      if (!columns.every((column) => schema.get(table)?.has(column)))
        throw new Error(
          'Better Auth schema is missing required identity fields.',
        );
    const foreignKeys = await db.pool.query<{
      table_name: string;
      relation: string;
    }>(
      "SELECT conrelid::regclass::text AS table_name,pg_get_constraintdef(oid) AS relation FROM pg_constraint WHERE contype='f' AND conrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1))",
      [['chatgptee_auth_account', 'chatgptee_auth_session']],
    );
    report.betterAuthSchema = {
      tables: authTableNames.filter((table) => schema.has(table)),
      foreignKeys: foreignKeys.rows,
    };
  }
}
async function fixtureIdentity() {
  const mapped = schema.get('solana_dots_users')?.has('better_auth_user_id');
  const result = await db.pool.query<{
    id: string;
    privy_user_id: string | null;
    better_auth_user_id: string | null;
  }>(
    `SELECT id,privy_user_id,${mapped ? 'better_auth_user_id' : 'NULL::text AS better_auth_user_id'} FROM solana_dots_users WHERE wallet_address=$1`,
    [address],
  );
  const row = result.rows[0];
  const ids = new Set<string>(
    row?.better_auth_user_id ? [row.better_auth_user_id] : [],
  );
  if (schema.has('chatgptee_auth_user')) {
    const users = await db.pool.query<{ id: string }>(
      'SELECT id FROM chatgptee_auth_user WHERE "solanaWallet"=$1',
      [address],
    );
    for (const user of users.rows) ids.add(user.id);
  }
  if (schema.has('chatgptee_auth_account')) {
    const accounts = await db.pool.query<{ userId: string }>(
      'SELECT "userId" FROM chatgptee_auth_account WHERE "providerId"=$1 AND "accountId"=$2',
      ['solana', address],
    );
    for (const account of accounts.rows) ids.add(account.userId);
  }
  const subjects = new Set<string>(
    row?.privy_user_id ? [row.privy_user_id] : [],
  );
  if (schema.has('chatgptee_auth_account') && ids.size) {
    const accounts = await db.pool.query<{ accountId: string }>(
      'SELECT "accountId" FROM chatgptee_auth_account WHERE "providerId"=$1 AND "userId"=ANY($2)',
      ['privy', [...ids]],
    );
    for (const account of accounts.rows) subjects.add(account.accountId);
  }
  return { row, betterAuthIds: [...ids], privySubjects: [...subjects] };
}
async function protectedSessionCookie(label: string) {
  const name = betterAuth
    ? `${new URL(origin).protocol === 'https:' ? '__Secure-' : ''}chatgptee.session_token`
    : 'solana-dots-session';
  const cookie = (await context.cookies()).find((value) => value.name === name);
  const lifetime = cookie ? cookie.expires - Date.now() / 1000 : 0;
  const expectedLifetime = (betterAuth ? 7 : 1) * 86400;
  const protectedCookie =
    !!cookie &&
    cookie.httpOnly &&
    cookie.sameSite === (betterAuth ? 'Lax' : 'Strict') &&
    cookie.path === (betterAuth ? '/' : '/api') &&
    (new URL(origin).protocol !== 'https:' || cookie.secure) &&
    Math.abs(lifetime - expectedLifetime) < 120;
  report[`${label}CookieProtected`] = protectedCookie;
  report[`${label}CookieContract`] = {
    name,
    httpOnly: cookie?.httpOnly,
    secure: cookie?.secure,
    sameSite: cookie?.sameSite,
    path: cookie?.path,
    expectedLifetimeSeconds: expectedLifetime,
    observedLifetimeSeconds: Math.round(lifetime),
  };
  if (!protectedCookie || !cookie)
    throw new Error(
      'Session cookie did not match the active authentication contract.',
    );
  return cookie;
}
async function replaySessionCookie(cookie: Cookie) {
  // Send the original captured credential independently of the browser jar.
  const response = await fetch(new URL('/api/auth/session', origin), {
    headers: { Origin: origin, Cookie: `${cookie.name}=${cookie.value}` },
  });
  const result = await response.json();
  return { status: response.status, result };
}
async function cookieAuthorized(cookie: Cookie, userId: string) {
  const { status, result } = await replaySessionCookie(cookie);
  return (
    status === 200 &&
    result.user?.id === userId &&
    result.user?.walletAddress === address &&
    result.owner === false
  );
}
async function cookieRevoked(cookie: Cookie) {
  const { status, result } = await replaySessionCookie(cookie);
  return status === 200 && result.user === null && result.owner === false;
}
async function cleanupFixture() {
  await inspectAuthSchema();
  const identity = await fixtureIdentity();
  privyId ??= identity.privySubjects[0];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (identity.betterAuthIds.length) {
      // Validate ownership before cascading through identity/account/session records.
      const users = await client.query<{
        id: string;
        solanaWallet: string | null;
      }>(
        'SELECT id,"solanaWallet" FROM chatgptee_auth_user WHERE id=ANY($1) FOR UPDATE',
        [identity.betterAuthIds],
      );
      if (users.rows.some((user) => user.solanaWallet !== address))
        throw new Error(
          'Fixture cleanup refused an identity with another wallet.',
        );
      const foreignWallets = await client.query(
        'SELECT id FROM chatgptee_auth_account WHERE "userId"=ANY($1) AND "providerId"=$2 AND "accountId"<>$3',
        [identity.betterAuthIds, 'solana', address],
      );
      if (foreignWallets.rowCount)
        throw new Error(
          'Fixture cleanup refused an identity with other wallet accounts.',
        );
      if (schema.get('solana_dots_users')?.has('better_auth_user_id')) {
        const foreignWorkspaces = await client.query(
          'SELECT id FROM solana_dots_users WHERE better_auth_user_id=ANY($1) AND wallet_address IS DISTINCT FROM $2',
          [identity.betterAuthIds, address],
        );
        if (foreignWorkspaces.rowCount)
          throw new Error(
            'Fixture cleanup refused an identity with another workspace.',
          );
      }
      for (const table of ['chatgptee_auth_session', 'chatgptee_auth_account'])
        if (schema.has(table))
          await client.query(`DELETE FROM ${table} WHERE "userId"=ANY($1)`, [
            identity.betterAuthIds,
          ]);
      await client.query('DELETE FROM chatgptee_auth_user WHERE id=ANY($1)', [
        identity.betterAuthIds,
      ]);
    }
    if (schema.has('chatgptee_auth_verification')) {
      const values = await client.query<{ id: string; value: string }>(
        'SELECT id,value FROM chatgptee_auth_verification WHERE identifier ~ $1 AND position($2 in value)>0',
        ['^(clawd|chatgptee)-solana:', address],
      );
      const ids = values.rows
        .filter((row) => {
          try {
            return JSON.parse(row.value).input?.address === address;
          } catch {
            return false;
          }
        })
        .map((row) => row.id);
      if (ids.length)
        await client.query(
          'DELETE FROM chatgptee_auth_verification WHERE id=ANY($1)',
          [ids],
        );
    }
    await client.query(
      "DELETE FROM solana_dots_auth_challenges WHERE input->>'address'=$1",
      [address],
    );
    await client.query(
      'DELETE FROM solana_dots_users WHERE wallet_address=$1',
      [address],
    );
    await client.query('COMMIT');
    const remaining = await fixtureIdentity();
    report.neonFixtureRemoved =
      !remaining.row && remaining.betterAuthIds.length === 0;
    if (!report.neonFixtureRemoved)
      throw new Error(
        'Fixture identity remained in the database after cleanup.',
      );
    report.betterAuthFixturesRemoved = betterAuth
      ? identity.betterAuthIds.length
      : 'not used';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (privyId && /^did:privy:[a-z0-9]+$/.test(privyId)) {
    const headers = {
      'privy-app-id': process.env.PRIVY_APP_ID!,
      Authorization: `Basic ${Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString('base64')}`,
    };
    const endpoint = `https://auth.privy.io/api/v1/users/${encodeURIComponent(privyId)}`;
    const existing = await fetch(endpoint, { headers });
    if (existing.status === 404) report.privyFixtureRemoved = true;
    else {
      if (!existing.ok)
        throw new Error(
          'Could not verify Privy fixture ownership before cleanup.',
        );
      const user = await existing.json();
      if (
        user.id !== privyId ||
        !user.linked_accounts?.every(
          (account: any) =>
            account.type === 'wallet' &&
            ((account.chain_type === 'solana' && account.address === address) ||
              fixtureWalletIds.has(account.id)),
        )
      )
        throw new Error(
          'Fixture cleanup refused a Privy identity with other accounts.',
        );
      const result = await fetch(endpoint, { method: 'DELETE', headers });
      report.privyFixtureRemoved = result.ok || result.status === 404;
      if (!report.privyFixtureRemoved)
        throw new Error('Privy fixture removal failed.');
    }
  }
}
try {
  // tsx preserves function names with a helper; serialized browser callbacks need it too.
  await context.addInitScript('window.__name = (fn) => fn;');
  await context.exposeFunction('qaSignMessage', (bytes: number[]) => [
    ...sign(null, Buffer.from(bytes), pair.privateKey),
  ]);
  await context.exposeFunction(
    'qaSignIn',
    (input: SignInChallenge['input']) => {
      const message = createSignInMessageText({ ...input, address });
      return {
        message: [...new TextEncoder().encode(message)],
        signature: [...sign(null, Buffer.from(message), pair.privateKey)],
      };
    },
  );
  await context.addInitScript(
    ({ address, publicKey, icon }) => {
      const account = {
        address,
        publicKey: new Uint8Array(publicKey),
        chains: ['solana:mainnet'],
        features: [
          'solana:signIn',
          'solana:signMessage',
          'solana:signTransaction',
          'solana:signAndSendTransaction',
        ],
      };
      let accounts: (typeof account)[] = [];
      const listeners = new Set<
        (event: { accounts: typeof accounts }) => void
      >();
      const notify = () =>
        listeners.forEach((callback) => callback({ accounts }));
      const qa = window as unknown as {
        qaSignMessage: (bytes: number[]) => Promise<number[]>;
        qaSignIn: (
          input: unknown,
        ) => Promise<{ message: number[]; signature: number[] }>;
      };
      const wallet = {
        version: '1.0.0',
        name: 'Phantom',
        icon,
        chains: ['solana:mainnet'],
        get accounts() {
          return accounts;
        },
        features: {
          'solana:signAndSendTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signAndSendTransaction: async () => {
              throw new Error(
                'This authentication fixture never sends transactions.',
              );
            },
          },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async () => {
              throw new Error(
                'This authentication fixture never signs transactions.',
              );
            },
          },
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              accounts = [account];
              notify();
              return { accounts };
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => {
              accounts = [];
              notify();
            },
          },
          'standard:events': {
            version: '1.0.0',
            on: (
              _event: string,
              callback: (event: { accounts: typeof accounts }) => void,
            ) => {
              listeners.add(callback);
              return () => listeners.delete(callback);
            },
          },
          'solana:signMessage': {
            version: '1.0.0',
            signMessage: async (...inputs: { message: Uint8Array }[]) =>
              Promise.all(
                inputs.map(async (input) => ({
                  signedMessage: input.message,
                  signature: new Uint8Array(
                    await qa.qaSignMessage([...input.message]),
                  ),
                  signatureType: 'ed25519',
                })),
              ),
          },
          'solana:signIn': {
            version: '1.0.0',
            signIn: async (...inputs: unknown[]) =>
              Promise.all(
                inputs.map(async (input) => {
                  const result = await qa.qaSignIn(input);
                  accounts = [account];
                  notify();
                  return {
                    account,
                    signedMessage: new Uint8Array(result.message),
                    signature: new Uint8Array(result.signature),
                    signatureType: 'ed25519',
                  };
                }),
              ),
          },
        },
      };
      const register = (api: { register: (...wallets: unknown[]) => void }) =>
        api.register(wallet);
      window.addEventListener('wallet-standard:app-ready', (event) =>
        register((event as CustomEvent).detail),
      );
      window.dispatchEvent(
        new CustomEvent('wallet-standard:register-wallet', {
          detail: register,
        }),
      );
    },
    {
      address,
      publicKey,
      icon: `data:image/svg+xml;base64,${readFileSync('public/brand/solana-logomark.svg').toString('base64')}`,
    },
  );

  const { AgentSession } = await import('../agent/session.mjs');
  const { createRequire } = await import('node:module');
  const { Entry } = createRequire(import.meta.url)(
    '../agent/node_modules/@napi-rs/keyring',
  );
  const headers = {
    'Content-Type': 'application/json',
    'privy-app-id': process.env.PRIVY_APP_ID!,
  };
  async function oauth(path: string, body: unknown, token?: string) {
    const response = await fetch('https://auth.privy.io/api/oauth/v2' + path, {
      method: 'POST',
      headers: {
        ...headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  const denied = await oauth('/device_authorization', {});
  if (
    denied.status !== 200 ||
    denied.body.verification_uri !== origin + '/authorize'
  )
    throw new Error('Privy verification URI is incorrect.');
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  let webToken = '';
  page.on('request', (request) => {
    if (request.url().endsWith('/device_verify')) {
      webToken =
        request.headers()['authorization']?.replace(/^Bearer /, '') ?? '';
      if (webToken)
        privyId = JSON.parse(
          Buffer.from(webToken.split('.')[1], 'base64url').toString(),
        ).sub;
    }
  });
  if (process.env.VERIFY_CLIENT_DIRECTORY) {
    const { resolve } = await import('node:path');
    const directory = resolve(process.env.VERIFY_CLIENT_DIRECTORY);
    await context.route(origin + '/authorize**', async (route) => {
      if (route.request().resourceType() !== 'document')
        return route.continue();
      await route.fulfill({
        path: resolve(directory, 'index.html'),
        contentType: 'text/html',
      });
    });
    await context.route(origin + '/assets/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      await route.fulfill({
        path: resolve(directory, '.' + path),
        contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
      });
    });
    report.stagedClientFixture = true;
  }
  if (process.env.VERIFY_LOCAL_WALLET_ROUTE === '1') {
    const { agentAccessRoutes } = await import('../src/server/agent-access.js');
    const { PrivyAuth } = await import('../src/server/privy-auth.js');
    const routes = agentAccessRoutes(
      new PrivyAuth({
        appId: process.env.PRIVY_APP_ID!,
        appSecret: process.env.PRIVY_APP_SECRET!,
      }),
    );
    await context.route(origin + '/api/agent/wallets', async (route) => {
      const req = route.request();
      const res = await routes.request('/wallets', {
        method: req.method(),
        headers: req.headers(),
        body: req.postData()!,
      });
      await route.fulfill({
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: await res.text(),
      });
    });
    report.stagedWalletRouteFixture = true;
  }
  await page.goto(denied.body.verification_uri_complete);
  await page
    .getByRole('button', { name: 'Sign in with Privy', exact: true })
    .click();
  await page.getByRole('button', { name: /Phantom/ }).click();
  await page
    .getByRole('button', { name: 'Approve agent access', exact: true })
    .waitFor();
  report.privyLogin = true;
  report.codePrefilled =
    (await page.getByLabel('Agent code').inputValue()) ===
    denied.body.user_code;
  await page.screenshot({
    path: `${directory}/agent-review.png`,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Deny access', exact: true }).click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Agent access denied.' })
    .waitFor();
  const denial = await oauth('/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: denied.body.device_code,
  });
  report.deviceDenialResponse = {
    status: denial.status,
    error: denial.body.error,
    errorCode: denial.body.error_code,
    description: denial.body.error_description,
  };
  if (denial.body.error !== 'access_denied')
    throw new Error('Denied device code was not rejected.');
  report.deviceDenial = true;
  if (process.env.VERIFY_CREATE_USER_WALLET === '1') {
    const { agentAccessRoutes } = await import('../src/server/agent-access.js');
    const { PrivyAuth } = await import('../src/server/privy-auth.js');
    const routes = agentAccessRoutes(
      new PrivyAuth({
        appId: process.env.PRIVY_APP_ID!,
        appSecret: process.env.PRIVY_APP_SECRET!,
      }),
    );
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${webToken}`,
      },
      body: JSON.stringify({ chain_type: 'solana' }),
    };
    const r = await routes.request('/wallets', init);
    const body = await r.json();
    if (!r.ok)
      throw new Error(
        `User-owned wallet creation: ${r.status} ${body.error ?? ''}`,
      );
    const w = body.wallet;
    const repeated = await (await routes.request('/wallets', init)).json();
    if (repeated.wallet?.id !== w.id)
      throw new Error('Agent wallet creation was not idempotent.');
    report.userWalletCreationIdempotent = true;
    fixtureWalletIds.add(w.id);
    report.serverCreatedFixtureWallet = {
      id: w.id,
      address: w.address,
      ownerId: w.owner_id,
    };
  } else {
    await page
      .getByRole('button', { name: 'Create Solana agent wallet', exact: true })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Solana agent wallet ready.' })
      .waitFor({ timeout: 60000 });
  }
  const fixtureUser = await fetch(
    'https://auth.privy.io/api/v1/users/' + encodeURIComponent(privyId!),
    {
      headers: {
        'privy-app-id': process.env.PRIVY_APP_ID!,
        Authorization: `Basic ${Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString('base64')}`,
      },
    },
  );
  if (!fixtureUser.ok)
    throw new Error('Could not read the generated fixture identity.');
  const fixtureAccounts = (await fixtureUser.json()).linked_accounts;
  for (const account of fixtureAccounts)
    if (account.type === 'wallet' && account.wallet_client_type === 'privy')
      fixtureWalletIds.add(account.id);
  const target =
    'https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=solana&vs_currencies=usd';
  const review = await fetch(
    origin + '/api/agent/resource?url=' + encodeURIComponent(target),
    {
      headers: { Authorization: `Bearer ${webToken}` },
      signal: AbortSignal.timeout(30000),
    },
  );
  report.paymentReview = {
    status: review.status,
    paymentRequiredHeader: !!review.headers.get('payment-required'),
    cacheControl: review.headers.get('cache-control'),
  };
  await review.body?.cancel();
  if (review.status !== 402 || !review.headers.has('payment-required'))
    throw new Error(
      'The Worker did not preserve the real provider payment challenge.',
    );
  const blocked = await fetch(
    origin +
      '/api/agent/resource?url=' +
      encodeURIComponent('http://127.0.0.1:4310/healthz'),
    { headers: { Authorization: `Bearer ${webToken}` } },
  );
  report.authenticatedPrivateDestinationBlocked = blocked.status === 400;
  if (!report.authenticatedPrivateDestinationBlocked)
    throw new Error('The payment proxy accepted a private destination.');
  const approved = await oauth('/device_authorization', {});
  await page.getByLabel('Agent code').fill(approved.body.user_code);
  await page
    .getByRole('button', { name: 'Approve agent access', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Agent access approved.' })
    .waitFor();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(5, approved.body.interval) * 1000),
  );
  const issued = await oauth('/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: approved.body.device_code,
  });
  if (
    issued.status !== 200 ||
    !issued.body.access_token ||
    !issued.body.refresh_token
  )
    throw new Error('Approved device did not receive tokens.');
  report.deviceApproval = true;
  deviceSession = new AgentSession(
    process.env.PRIVY_APP_ID!,
    fetch,
    new Entry('ai.chatgptee.agent.qa', address),
  );
  deviceSession.save(issued.body);
  deviceSession.load();
  report.secureCredentialRoundTrip =
    deviceSession.tokens.access_token === issued.body.access_token;
  const key = await deviceSession.authenticate();
  report.ephemeralSigningKeyDecrypted = !!key.privateKey;
  report.walletsAccessible = key.wallets.map((w: any) => ({
    id: w.id,
    chainType: w.chain_type,
    address: w.address,
  }));
  for (const wallet of key.wallets) fixtureWalletIds.add(wallet.id);
  const solanaWallet = key.wallets.find((w: any) => w.chain_type === 'solana');
  if (!solanaWallet)
    throw new Error(
      'Created Solana wallet was not accessible to the device grant.',
    );
  const text =
    'ChatGPTEE temporary agent verification; no transaction or payment.';
  const signed = await deviceSession.rpc(solanaWallet.id, {
    method: 'signMessage',
    params: {
      message: Buffer.from(text).toString('base64'),
      encoding: 'base64',
    },
  });
  const { createPublicKey, verify } = await import('node:crypto');
  const publicKeyObject = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(bs58.decode(solanaWallet.address)),
    ]),
    format: 'der',
    type: 'spki',
  });
  const signature = signed.data?.signature;
  report.agentMessageSignatureVerified =
    !!signature &&
    verify(
      null,
      Buffer.from(text),
      publicKeyObject,
      Buffer.from(signature, 'base64'),
    );
  if (!report.agentMessageSignatureVerified)
    throw new Error('Agent wallet message signature did not verify.');
  const oldRefresh = deviceSession.tokens.refresh_token;
  deviceSession.tokens.expiresAt = 0;
  await deviceSession.token();
  report.refreshTokenRotated =
    oldRefresh !== deviceSession.tokens.refresh_token;
  if (!report.refreshTokenRotated)
    throw new Error('Refresh token did not rotate.');
  await page
    .getByRole('button', { name: 'Refresh authorizations', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Revoke access', exact: true })
    .waitFor();
  if (
    (await page
      .getByRole('button', { name: 'Revoke access', exact: true })
      .count()) !== 1
  )
    throw new Error('Unexpected fixture grant count.');
  await page.screenshot({
    path: `${directory}/agent-grants.png`,
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Revoke access', exact: true })
    .click();
  await page
    .getByRole('status')
    .filter({ hasText: 'Agent authorization revoked.' })
    .waitFor();
  const revoked = await oauth('/token', {
    grant_type: 'refresh_token',
    refresh_token: deviceSession.tokens.refresh_token,
  });
  report.grantRevocationResponse = {
    status: revoked.status,
    error: revoked.body.error,
    description: revoked.body.error_description,
  };
  report.grantRevocation =
    [400, 401, 403].includes(revoked.status) &&
    !revoked.body.access_token &&
    ['access_denied', 'invalid_grant'].includes(revoked.body.error);
  if (!report.grantRevocation)
    throw new Error('Revoked grant still refreshed tokens.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `${directory}/agent-mobile.png`,
    animations: 'disabled',
  });
  report.mobileFitsViewport = await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  report.browserErrors = errors;
  report.paymentSubmitted = false;
  if (errors.length || !report.mobileFitsViewport)
    throw new Error('Agent page failed browser checks.');
} catch (error) {
  report.error =
    error instanceof Error
      ? safeDiagnostic(error.message)
      : 'Verification failed.';
  const pages = context.pages();
  if (pages[0]) {
    await pages[0].screenshot({
      path: `${directory}/verification-failure.png`,
    });
    writeFileSync(
      `${directory}/verification-failure.txt`,
      await pages[0].locator('body').innerText(),
    );
  }
  report.browserErrors = [...errors];
  process.exitCode = 1;
} finally {
  report.browserErrors = [...errors];
  report.networkFailures = networkFailures.map((failure) => ({ ...failure }));
  // Stop SDK callbacks before deleting the generated user's records.
  await context.close();
  await browser.close();
  // Remove only this randomly generated wallet's identity and dependent sessions.
  try {
    await cleanupFixture();
  } catch (error) {
    report.cleanupError =
      error instanceof Error
        ? safeDiagnostic(error.message)
        : 'Fixture cleanup failed.';
    process.exitCode = 1;
  }
  deviceSession?.logout();
  await db.close();
  writeFileSync(
    `${directory}/auth-browser-verification.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
}
