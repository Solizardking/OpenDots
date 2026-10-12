import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import bs58 from 'bs58';
import { Hono } from 'hono';
import { SolanaAuth, browserBoundary } from '../src/server/solana-auth.js';
import type { UserDatabase } from '../src/server/user-database.js';
import type { SignInChallenge, SolanaUser } from '../src/shared/auth-types.js';

class MemoryUsers implements UserDatabase {
  challenges = new Map<
    string,
    {
      input: SignInChallenge['input'];
      binding: string;
      origin: string;
      expires: number;
    }
  >();
  users = new Map<string, SolanaUser>();
  sessions = new Map<string, { user: SolanaUser; expires: number }>();
  async createChallenge(
    challenge: SignInChallenge,
    binding: string,
    origin: string,
    expires: Date,
  ) {
    this.challenges.set(challenge.id, {
      input: challenge.input,
      binding,
      origin,
      expires: +expires,
    });
  }
  async consumeChallenge(
    id: string,
    binding: string,
    origin: string,
    now: Date,
  ) {
    const value = this.challenges.get(id);
    if (
      !value ||
      value.binding !== binding ||
      value.origin !== origin ||
      value.expires <= +now
    )
      return;
    this.challenges.delete(id);
    return value.input;
  }
  async createSession(address: string, hash: string, expires: Date) {
    let user = this.users.get(address);
    if (!user) {
      user = {
        id: randomUUID(),
        walletAddress: address,
        displayName: null,
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
      };
      this.users.set(address, user);
    }
    this.sessions.set(hash, { user, expires: +expires });
    return user;
  }
  async session(hash: string, now: Date) {
    const value = this.sessions.get(hash);
    return value && value.expires > +now ? value.user : undefined;
  }
  async revokeSession(hash: string) {
    this.sessions.delete(hash);
  }
}
function wallet() {
  const pair = generateKeyPairSync('ed25519');
  return {
    address: bs58.encode(
      pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    ),
    sign: (message: string) =>
      bs58.encode(sign(null, Buffer.from(message), pair.privateKey)),
  };
}
function fixture() {
  let now = Date.now();
  const users = new MemoryUsers();
  const auth = new SolanaAuth(users, () => now);
  const app = new Hono();
  app.use('/api/*', browserBoundary(['https://dots.example']));
  app.route('/api/auth', auth.routes('owner-fixture'));
  app.get('/api/private', async (c) => {
    const user = await auth.user(c);
    return user
      ? c.json({ userId: user.id })
      : c.json({ error: 'Unauthorized' }, 401);
  });
  const request = (
    path: string,
    body?: unknown,
    cookie?: string,
    origin = 'https://dots.example',
  ) =>
    app.request(`https://dots.example/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    users,
    request,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const cookie = (response: Response, name: string) =>
  response.headers.get('set-cookie')?.match(new RegExp(`${name}=[^;]+`))?.[0];
async function challenge(
  f: ReturnType<typeof fixture>,
  w: ReturnType<typeof wallet>,
) {
  const response = await f.request('/auth/challenge', { address: w.address });
  expect(response.status).toBe(200);
  return {
    data: (await response.json()) as SignInChallenge,
    binding: cookie(response, 'solana-dots-challenge')!,
  };
}
async function login(
  f: ReturnType<typeof fixture>,
  w: ReturnType<typeof wallet>,
) {
  const { data, binding } = await challenge(f, w);
  const response = await f.request(
    '/auth/verify',
    {
      id: data.id,
      address: w.address,
      message: data.message,
      signature: w.sign(data.message),
    },
    binding,
  );
  expect(response.status).toBe(200);
  return {
    response,
    session: cookie(response, 'solana-dots-session')!,
    user: (await response.json()).user as SolanaUser,
  };
}

describe('wallet-first authentication', () => {
  it('requires a verified signature before any private access and uses HttpOnly sessions', async () => {
    const f = fixture();
    expect((await f.request('/private')).status).toBe(401);
    const { response, session, user } = await login(f, wallet());
    expect(response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(response.headers.get('set-cookie')).toContain('Secure');
    expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect(
      await (await f.request('/private', undefined, session)).json(),
    ).toEqual({ userId: user.id });
    expect([...f.users.sessions.keys()][0]).not.toEqual(session.split('=')[1]);
  });
  it('rejects forged signatures and consumes the challenge on a failed attempt', async () => {
    const f = fixture(),
      w = wallet(),
      other = wallet();
    const { data, binding } = await challenge(f, w);
    const body = {
      id: data.id,
      address: w.address,
      message: data.message,
      signature: other.sign(data.message),
    };
    expect((await f.request('/auth/verify', body, binding)).status).toBe(401);
    expect(
      (
        await f.request(
          '/auth/verify',
          { ...body, signature: w.sign(data.message) },
          binding,
        )
      ).status,
    ).toBe(401);
    expect(f.users.users.size).toBe(0);
  });
  it('rejects replay, including concurrent verification', async () => {
    const f = fixture(),
      w = wallet();
    const { data, binding } = await challenge(f, w);
    const body = {
      id: data.id,
      address: w.address,
      message: data.message,
      signature: w.sign(data.message),
    };
    const responses = await Promise.all([
      f.request('/auth/verify', body, binding),
      f.request('/auth/verify', body, binding),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
  });
  it('binds challenges to the browser and origin', async () => {
    const f = fixture(),
      w = wallet();
    const { data } = await challenge(f, w);
    const body = {
      id: data.id,
      address: w.address,
      message: data.message,
      signature: w.sign(data.message),
    };
    expect(
      (
        await f.request(
          '/auth/verify',
          body,
          'solana-dots-challenge=another-browser',
        )
      ).status,
    ).toBe(401);
    expect(
      (await f.request('/auth/verify', body, undefined, 'https://evil.example'))
        .status,
    ).toBe(403);
  });
  it.each(['address', 'domain', 'nonce'])(
    'rejects a changed %s even when signed',
    async (field) => {
      const f = fixture(),
        w = wallet();
      const { data, binding } = await challenge(f, w);
      const message =
        field === 'domain'
          ? data.message.replace('dots.example', 'evil.example')
          : field === 'nonce'
            ? data.message.replace(data.input.nonce!, '0'.repeat(32))
            : data.message.replace(w.address, wallet().address);
      expect(
        (
          await f.request(
            '/auth/verify',
            {
              id: data.id,
              address: w.address,
              message,
              signature: w.sign(message),
            },
            binding,
          )
        ).status,
      ).toBe(401);
    },
  );
  it('expires challenges and sessions', async () => {
    const f = fixture(),
      w = wallet();
    const { data, binding } = await challenge(f, w);
    f.advance(300001);
    expect(
      (
        await f.request(
          '/auth/verify',
          {
            id: data.id,
            address: w.address,
            message: data.message,
            signature: w.sign(data.message),
          },
          binding,
        )
      ).status,
    ).toBe(401);
    const { session } = await login(f, w);
    f.advance(86400001);
    expect((await f.request('/private', undefined, session)).status).toBe(401);
  });
  it('restores users, separates wallet identities, and revokes logout sessions', async () => {
    const f = fixture(),
      w = wallet();
    const first = await login(f, w),
      second = await login(f, w),
      other = await login(f, wallet());
    expect(second.user.id).toBe(first.user.id);
    expect(other.user.id).not.toBe(first.user.id);
    expect(
      (await f.request('/auth/session', undefined, first.session)).status,
    ).toBe(200);
    expect((await f.request('/auth/logout', {}, first.session)).status).toBe(
      200,
    );
    expect((await f.request('/private', undefined, first.session)).status).toBe(
      401,
    );
    expect(
      (await f.request('/private', undefined, second.session)).status,
    ).toBe(200);
  });
  it('rejects malformed public keys and bounds unauthenticated requests', async () => {
    const f = fixture();
    expect(
      (await f.request('/auth/challenge', { address: 'x'.repeat(44) })).status,
    ).toBe(400);
    const w = wallet();
    for (let i = 0; i < 10; i++)
      expect(
        (await f.request('/auth/challenge', { address: w.address })).status,
      ).toBe(200);
    expect(
      (await f.request('/auth/challenge', { address: w.address })).status,
    ).toBe(429);
  });
});
