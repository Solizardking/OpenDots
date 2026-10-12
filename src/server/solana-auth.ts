import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  createSignInMessageText,
  verifySignIn,
} from '@solana/wallet-standard-util';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { z } from 'zod';
import type { SignInChallenge, SolanaUser } from '../shared/auth-types.js';
import type { UserDatabase } from './user-database.js';
import type { PrivyAuth } from './privy-auth.js';

const SESSION = 'solana-dots-session';
const BINDING = 'solana-dots-challenge';
export const hashToken = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const verification = z
  .object({
    id: z.string().uuid(),
    address: z.string().min(32).max(44),
    message: z.string().max(4096),
    signature: z.string().max(128),
  })
  .strict();
export function isOwner(c: Context, ownerToken?: string) {
  if (!ownerToken) return false;
  const expected = Buffer.from(ownerToken);
  const supplied = Buffer.from(
    c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
  );
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}
export class SolanaAuth {
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(
    readonly database: UserDatabase,
    private now: () => number = Date.now,
  ) {}
  async user(c: Context): Promise<SolanaUser | undefined> {
    const token = getCookie(c, SESSION);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.database.session(hashToken(token), new Date(this.now()));
  }
  private async startSession(
    c: Context,
    address: string,
    privyUserId?: string,
  ) {
    const old = getCookie(c, SESSION);
    if (old) await this.database.revokeSession(hashToken(old));
    const token = randomBytes(32).toString('hex');
    const user = await this.database.createSession(
      address,
      hashToken(token),
      new Date(this.now() + 86400000),
      privyUserId,
    );
    const origin = c.req.header('origin') ?? new URL(c.req.url).origin;
    setCookie(c, SESSION, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: new URL(origin).protocol === 'https:',
      path: '/api',
      maxAge: 86400,
    });
    return c.json({ user, owner: false });
  }
  routes(ownerToken?: string, privy?: PrivyAuth) {
    const app = new Hono();
    app.use(
      '*',
      bodyLimit({
        maxSize: 8192,
        onError: (c) =>
          c.json({ error: 'Authentication request is too large.' }, 413),
      }),
    );
    app.get('/session', async (c) =>
      c.json({
        user: (await this.user(c)) ?? null,
        owner: isOwner(c, ownerToken),
      }),
    );
    app.get('/config', (c) =>
      c.json({
        privyAppId: privy?.config.appId,
        privyClientId: privy?.config.clientId,
      }),
    );
    app.post('/privy', async (c) => {
      if (!privy)
        return c.json({ error: 'Privy sign-in is not configured.' }, 503);
      const parsed = z
        .object({
          accessToken: z.string().min(20).max(7000),
          address: z.string().min(32).max(44),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: 'Choose a Solana wallet to sign in.' }, 400);
      let privyUserId: string;
      try {
        privyUserId = await privy.verify(
          parsed.data.accessToken,
          parsed.data.address,
        );
      } catch {
        return c.json(
          {
            error:
              'Privy could not verify this wallet sign-in. Please sign in again.',
          },
          401,
        );
      }
      return this.startSession(c, parsed.data.address, privyUserId);
    });
    app.post('/challenge', async (c) => {
      const parsed = z
        .object({ address: z.string().min(32).max(44) })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: 'Choose a Solana wallet.' }, 400);
      try {
        const key = new PublicKey(parsed.data.address);
        if (
          key.toBase58() !== parsed.data.address ||
          !PublicKey.isOnCurve(key.toBytes())
        )
          throw new Error();
      } catch {
        return c.json({ error: 'Choose a valid Solana wallet address.' }, 400);
      }
      const now = this.now();
      for (const [key, value] of this.attempts)
        if (value.until <= now) this.attempts.delete(key);
      const binding = getCookie(c, BINDING) ?? randomBytes(32).toString('hex');
      // Per-address and global limits bound unauthenticated database writes.
      for (const key of [parsed.data.address, '*']) {
        const value = this.attempts.get(key) ?? {
          count: 0,
          until: now + 60000,
        };
        if (++value.count > (key === '*' ? 120 : 10))
          return c.json(
            { error: 'Too many sign-in requests. Try again in a minute.' },
            429,
          );
        this.attempts.set(key, value);
      }
      const origin = c.req.header('origin') ?? new URL(c.req.url).origin;
      const expires = new Date(now + 300000);
      const input: SignInChallenge['input'] = {
        domain: new URL(origin).host,
        address: parsed.data.address,
        statement:
          'Sign in to ChatGPTEE. This verifies your wallet ownership and does not authorize transactions.',
        uri: origin,
        version: '1',
        chainId: 'solana:mainnet',
        nonce: randomBytes(16).toString('hex'),
        issuedAt: new Date(now).toISOString(),
        expirationTime: expires.toISOString(),
      };
      const challenge = {
        id: randomUUID(),
        input,
        message: createSignInMessageText(input),
      };
      await this.database.createChallenge(
        challenge,
        hashToken(binding),
        origin,
        expires,
      );
      setCookie(c, BINDING, binding, {
        httpOnly: true,
        sameSite: 'Strict',
        secure: new URL(origin).protocol === 'https:',
        path: '/api/auth',
        maxAge: 300,
      });
      return c.json(challenge);
    });
    app.post('/verify', async (c) => {
      const parsed = verification.safeParse(
        await c.req.json().catch(() => null),
      );
      const binding = getCookie(c, BINDING);
      if (!parsed.success || !binding)
        return c.json({ error: 'Request a new sign-in challenge.' }, 400);
      const origin = c.req.header('origin') ?? new URL(c.req.url).origin;
      const input = await this.database.consumeChallenge(
        parsed.data.id,
        hashToken(binding),
        origin,
        new Date(this.now()),
      );
      if (!input)
        return c.json(
          {
            error:
              'This sign-in request expired or was already used. Try again.',
          },
          401,
        );
      let valid = false;
      try {
        const key = new PublicKey(parsed.data.address);
        valid = verifySignIn(input, {
          account: {
            address: parsed.data.address,
            publicKey: key.toBytes(),
            chains: ['solana:mainnet'],
            features: ['solana:signMessage'],
          },
          signedMessage: new TextEncoder().encode(parsed.data.message),
          signature: bs58.decode(parsed.data.signature),
        });
      } catch {
        /* Malformed or mismatched signature. */
      }
      if (!valid)
        return c.json(
          { error: 'The wallet signature could not be verified. Try again.' },
          401,
        );
      deleteCookie(c, BINDING, { path: '/api/auth' });
      return this.startSession(c, parsed.data.address);
    });
    app.post('/logout', async (c) => {
      const token = getCookie(c, SESSION);
      if (token) await this.database.revokeSession(hashToken(token));
      deleteCookie(c, SESSION, { path: '/api' });
      return c.json({ ok: true });
    });
    return app;
  }
}

/** Same browser boundaries for authentication and every private feature API. */
export function browserBoundary(origins?: string[]) {
  return async (c: Context, next: () => Promise<void>) => {
    c.header('Cache-Control', 'no-store');
    const url = new URL(c.req.url);
    const allowed = origins?.length ? origins : [url.origin];
    const hostnames = new Set([
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...(origins ?? []).map((item) => new URL(item).hostname),
    ]);
    if (!hostnames.has(url.hostname))
      return c.json({ error: 'Unrecognized host.' }, 403);
    const origin = c.req.header('origin');
    if (
      (origin && !allowed.includes(origin)) ||
      c.req.header('sec-fetch-site') === 'cross-site'
    )
      return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    if (
      !['GET', 'HEAD'].includes(c.req.method) &&
      !c.req.header('content-type')?.includes('application/json')
    )
      return c.json({ error: 'Use application/json.' }, 415);
    await next();
  };
}
