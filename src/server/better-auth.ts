import {
  betterAuth,
  type BetterAuthOptions,
  type BetterAuthPlugin,
} from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { getMigrations } from 'better-auth/db/migration';
import { dash } from '@better-auth/infra';
import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { solanaAuth } from './solana-better-auth.js';
import { SolanaAuth, browserBoundary, isOwner } from './solana-auth.js';
import type { PrivyAuth } from './privy-auth.js';
import {
  IdentityConflict,
  type PostgresUserDatabase,
} from './user-database.js';
import { authClientIpHeader, trustedAuthHeaders } from './auth-proxy.js';

type Identity = { id: string; name: string; solanaWallet?: string | null };
type Env = Record<string, string | undefined>;
function authSecret(env: Env, directory: string) {
  if (env.BETTER_AUTH_SECRET) {
    if (env.BETTER_AUTH_SECRET.length < 32)
      throw Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
    return env.BETTER_AUTH_SECRET;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'better-auth.secret');
  try {
    writeFileSync(path, randomBytes(48).toString('base64url'), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (statSync(path).mode & 0o077)
    throw Error('Better Auth secret file must have 0600 permissions.');
  const secret = readFileSync(path, 'utf8').trim();
  if (secret.length < 32) throw Error('Invalid persisted Better Auth secret.');
  return secret;
}
export async function createHybridAuth(options: {
  users: PostgresUserDatabase;
  privy?: PrivyAuth;
  ownerToken?: string;
  stateDir: string;
  env?: Env;
  origin?: string;
}) {
  const env = options.env ?? process.env;
  const proxySecret = env.CHATGPTEE_PROXY_SECRET;
  if (proxySecret && proxySecret.length < 32)
    throw Error('CHATGPTEE_PROXY_SECRET must contain at least 32 characters.');
  if (env.NODE_ENV === 'production' && !proxySecret)
    throw Error(
      'Production authentication requires CHATGPTEE_PROXY_SECRET for the Cloudflare origin boundary.',
    );
  const url = new URL(
    options.origin || env.BETTER_AUTH_URL || 'https://chatgptee.ai',
  );
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        env.NODE_ENV !== 'production' &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw Error('BETTER_AUTH_URL must be a fixed HTTPS origin.');
  const origin = url.origin;
  const origins = new Set([origin]);
  for (const item of (env.APP_ORIGIN || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)) {
    const trusted = new URL(item);
    if (
      trusted.protocol !== 'https:' &&
      !(
        env.NODE_ENV !== 'production' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(trusted.hostname)
      )
    )
      throw Error('Invalid trusted authentication origin.');
    origins.add(trusted.origin);
  }
  const providerOptions = {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
    twitter: {
      clientId: env.TWITTER_CLIENT_ID || env.X_CLIENT_ID,
      clientSecret: env.TWITTER_CLIENT_SECRET || env.X_CLIENT_SECRET,
    },
  };
  const socialProviders = Object.fromEntries(
    Object.entries(providerOptions).filter(
      ([, v]) => v.clientId && v.clientSecret,
    ),
  );
  const conflict = (message: string) => new APIError('CONFLICT', { message });
  const claim = async (identity: Identity) => {
    try {
      return await options.users.resolveIdentity(identity);
    } catch (error) {
      if (!(error instanceof IdentityConflict)) throw error;
      throw conflict(
        'This wallet has another workspace. Sign in with that wallet, then link your social account from its account settings.',
      );
    }
  };
  const privyPlugin = {
    id: 'chatgptee-privy',
    endpoints: {
      signInPrivy: createAuthEndpoint(
        '/hybrid/privy',
        {
          method: 'POST',
          requireRequest: true,
          body: z
            .object({
              accessToken: z.string().min(20).max(7000),
              address: z.string().min(32).max(44).optional(),
              purpose: z.enum(['sign-in', 'link']).default('sign-in'),
              workspaceId: z.string().uuid().optional(),
            })
            .strict(),
        },
        async (ctx) => {
          if (!options.privy)
            throw new APIError('SERVICE_UNAVAILABLE', {
              message: 'Privy sign-in is not configured.',
            });
          let subject: string;
          let displayName: string | undefined;
          const address = ctx.body.address;
          try {
            if (address) {
              const wallet = new PublicKey(address);
              if (
                wallet.toBase58() !== address ||
                !PublicKey.isOnCurve(wallet.toBytes())
              )
                throw Error();
            }
            const verified = await options.privy.verifyIdentity(
              ctx.body.accessToken,
              address,
            );
            subject = verified.subject;
            displayName = verified.displayName;
          } catch {
            throw new APIError('UNAUTHORIZED', {
              message: 'Privy could not verify your sign-in. Please try again.',
            });
          }
          const adapter = ctx.context.internalAdapter;
          const privyKey = { providerId: 'privy', accountId: subject };
          const walletKey = {
            providerId: 'solana',
            accountId: address!,
          };
          const privyOwner = await adapter.findAccountOwnerByKey(privyKey);
          const walletOwner = address
            ? await adapter.findAccountOwnerByKey(walletKey)
            : null;
          const workspace = address
            ? await options.users.walletIdentity(address)
            : null;
          const storedUser = workspace?.better_auth_user_id
            ? await adapter.findUserById(workspace.better_auth_user_id)
            : null;
          if (
            (privyOwner && privyOwner.kind !== 'owned') ||
            (walletOwner && walletOwner.kind !== 'owned')
          )
            throw conflict('This identity is unavailable.');
          const candidates = [
            privyOwner?.user,
            walletOwner?.user,
            storedUser,
          ].filter((x) => !!x);
          if (new Set(candidates.map((x) => x.id)).size > 1)
            throw conflict('These identities belong to different workspaces.');
          let user = candidates[0];
          const current = await getSessionFromCtx(ctx);
          if (ctx.body.purpose === 'link') {
            if (!current)
              throw new APIError('UNAUTHORIZED', {
                message: 'Sign in to your workspace before linking Privy.',
              });
            if (Date.now() - current.session.createdAt.getTime() > 300000)
              throw new APIError('UNAUTHORIZED', {
                message: 'Sign in again before linking Privy.',
              });
            if (
              !ctx.body.workspaceId ||
              (await claim(current.user as Identity)).id !==
                ctx.body.workspaceId
            )
              throw conflict(
                'Your workspace changed. Start account linking again.',
              );
            if (user && user.id !== current.user.id)
              throw conflict('Privy is already linked to a different account.');
            user = current.user;
          } else if (current && current.user.id !== user?.id) {
            throw conflict(
              'Sign out before switching accounts, or link Privy from Account settings.',
            );
          }
          const existingWallet = (user as Identity | undefined)?.solanaWallet;
          if (address && existingWallet && existingWallet !== address)
            throw conflict('This account uses a different Solana wallet.');
          user ??= await adapter.createUser(
            {
              name:
                displayName ||
                (address
                  ? 'ChatGPTEE ' + address.slice(0, 6)
                  : 'ChatGPTEE member'),
              email:
                createHash('sha256')
                  .update(address || subject)
                  .digest('hex') +
                (address
                  ? '@solana.chatgptee.invalid'
                  : '@privy.chatgptee.invalid'),
              emailVerified: false,
              ...(address ? { solanaWallet: address } : {}),
            },
            { method: 'privy' },
          );
          await claim({
            ...user,
            ...(address ? { solanaWallet: address } : {}),
          });
          if (!privyOwner)
            await adapter.createAccount({ ...privyKey, userId: user.id });
          if (address && !walletOwner)
            await adapter.createAccount({ ...walletKey, userId: user.id });
          if (address)
            user = await adapter.updateUser(user.id, { solanaWallet: address });
          const session = await adapter.createSession(user.id);
          if (!session)
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Could not start your session.',
            });
          await setSessionCookie(ctx, { user, session });
          return ctx.json({
            user: await claim(user as Identity),
            owner: false,
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
  const plugins: BetterAuthPlugin[] = [
    solanaAuth(origin, Date.now, async (id, address) => {
      await claim({ id, name: '', solanaWallet: address });
    }),
    privyPlugin,
  ];
  if (env.BETTER_AUTH_API_KEY)
    plugins.push(dash({ apiKey: env.BETTER_AUTH_API_KEY }));
  const settings: BetterAuthOptions = {
    appName: 'ChatGPTEE',
    baseURL: origin,
    basePath: '/api/auth',
    secret: authSecret(env, options.stateDir),
    database: options.users.pool,
    trustedOrigins: [...origins],
    socialProviders,
    emailAndPassword: { enabled: false },
    user: {
      modelName: 'chatgptee_auth_user',
      additionalFields: {
        solanaWallet: {
          type: 'string',
          required: false,
          input: false,
          returned: true,
          unique: true,
        },
      },
    },
    account: {
      modelName: 'chatgptee_auth_account',
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        disableImplicitLinking: true,
        allowDifferentEmails: true,
      },
    },
    session: {
      modelName: 'chatgptee_auth_session',
      expiresIn: 7 * 86400,
      updateAge: 86400,
      freshAge: 300,
      cookieCache: { enabled: false },
    },
    verification: { modelName: 'chatgptee_auth_verification' },
    advanced: {
      cookiePrefix: 'chatgptee',
      useSecureCookies: origin.startsWith('https:'),
      database: { generateId: () => randomUUID(), joins: true },
      ipAddress: { ipAddressHeaders: [authClientIpHeader], ipv6Subnet: 64 },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'chatgptee_auth_rate_limit',
      max: 60,
      window: 60,
      customRules: {
        '/solana/nonce': { max: 10, window: 60 },
        '/solana/verify': { max: 10, window: 60 },
        '/hybrid/privy': { max: 10, window: 60 },
        '/sign-in/social': { max: 10, window: 60 },
      },
    },
    plugins,
    telemetry: { enabled: false },
    logger: { level: 'error' },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const actions = [
          '/sign-out',
          '/sign-in/social',
          '/link-social',
          '/update-user',
          '/unlink-account',
          '/revoke-session',
          '/revoke-sessions',
          '/revoke-other-sessions',
        ];
        if (
          ctx.request &&
          ctx.request.method !== 'GET' &&
          (actions.includes(ctx.path) ||
            ctx.path.startsWith('/solana/') ||
            ctx.path.startsWith('/hybrid/'))
        ) {
          if (
            !origins.has(ctx.request.headers.get('origin') || '') ||
            ctx.request.headers.get('sec-fetch-site') === 'cross-site'
          )
            throw new APIError('FORBIDDEN', {
              message: 'Open this action from the ChatGPTEE website.',
            });
        }
        if (ctx.path === '/link-social') {
          const session = await getSessionFromCtx(ctx);
          if (
            !session ||
            Date.now() - session.session.createdAt.getTime() > 300000
          )
            throw new APIError('UNAUTHORIZED', {
              message: 'Sign in again before linking an account.',
            });
        }
        if (['/sign-in/social', '/link-social'].includes(ctx.path))
          for (const key of [
            'callbackURL',
            'errorCallbackURL',
            'newUserCallbackURL',
          ]) {
            const value = ctx.body?.[key];
            if (typeof value !== 'string') continue;
            const target = new URL(value, origin);
            if (
              target.username ||
              target.password ||
              !origins.has(target.origin)
            )
              throw new APIError('FORBIDDEN', {
                message: 'Return to ChatGPTEE after sign-in.',
              });
          }
      }),
    },
  };
  // Protect existing identity/session data before altering the auth schema.
  await options.users.protectBetterAuthTables();
  await (await getMigrations(settings)).runMigrations();
  // Migrations create empty tables; restrict them before any handler can write.
  await options.users.protectBetterAuthTables();
  const auth = betterAuth(settings);
  const legacy = new SolanaAuth(options.users);
  const verifiedHeaders = new WeakMap<Context, Headers>();
  async function handle(request: Request) {
    const oldRequest = request.clone();
    const response = await auth.handler(request);
    const path = new URL(request.url).pathname;
    if (
      response.status < 400 &&
      (path.includes('/callback/') ||
        path.endsWith('/solana/verify') ||
        path.endsWith('/hybrid/privy')) &&
      response.headers
        .getSetCookie()
        .some((x) => x.includes('chatgptee.session_token='))
    ) {
      const old = await legacy.routes().request(
        new Request(origin + '/logout', {
          method: 'POST',
          headers: oldRequest.headers,
          body: '{}',
        }),
      );
      const headers = new Headers(response.headers);
      for (const cookie of old.headers.getSetCookie())
        headers.append('Set-Cookie', cookie);
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  }
  async function user(c: Context) {
    const headers =
      verifiedHeaders.get(c) ??
      trustedAuthHeaders(c.req.raw, proxySecret, peerAddress(c));
    const [session, old] = await Promise.all([
      headers ? auth.api.getSession({ headers }) : Promise.resolve(null),
      legacy.user(c),
    ]);
    if (!session) return old;
    const current =
      (await options.users.mappedIdentity(session.user.id)) ??
      (await claim(session.user as Identity));
    if (old && old.id !== current.id) return undefined;
    return current;
  }
  const routes = new Hono();
  function peerAddress(c: Context) {
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  }
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const headers = trustedAuthHeaders(c.req.raw, proxySecret, peerAddress(c));
    if (!headers)
      return c.json(
        { error: 'Authentication must pass through the trusted app edge.' },
        403,
      );
    verifiedHeaders.set(c, headers);
    await next();
  });
  function authenticatedRequest(c: Context, target?: string) {
    const request = target ? new Request(target, c.req.raw) : c.req.raw;
    return new Request(request, {
      headers: verifiedHeaders.get(c),
    });
  }
  routes.use(
    '*',
    bodyLimit({
      maxSize: 8192,
      onError: (c) =>
        c.json({ error: 'Authentication request is too large.' }, 413),
    }),
  );
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use('/challenge', browserBoundary([...origins]));
  routes.use('/verify', browserBoundary([...origins]));
  routes.get('/config', (c) =>
    c.json({
      privyAppId: options.privy?.config.appId,
      privyClientId: options.privy?.config.clientId,
      betterAuth: true,
      baseURL: origin,
      basePath: '/api/auth',
      socialProviders: Object.keys(socialProviders),
      privySocialProviders: options.privy
        ? (env.PRIVY_SOCIAL_PROVIDERS ?? 'google,twitter,github')
            .split(',')
            .map((x) => x.trim())
            .filter((x) => ['google', 'twitter', 'github'].includes(x))
        : [],
    }),
  );
  routes.get('/session', async (c) =>
    c.json({
      user: (await user(c)) ?? null,
      owner: isOwner(c, options.ownerToken),
    }),
  );
  routes.post('/privy', (c) =>
    handle(authenticatedRequest(c, origin + '/api/auth/hybrid/privy')),
  );
  routes.post('/logout', async (c) => {
    const oldRequest = c.req.raw.clone();
    const signedOut = await auth.handler(
      authenticatedRequest(c, origin + '/api/auth/sign-out'),
    );
    if (!signedOut.ok) return signedOut;
    const old = await legacy
      .routes()
      .request(new Request(origin + '/logout', oldRequest));
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    for (const response of [signedOut, old])
      for (const cookie of response.headers.getSetCookie())
        headers.append('Set-Cookie', cookie);
    return new Response(JSON.stringify({ ok: true }), { headers });
  });
  // Keep valid legacy sessions and wallet clients working during migration.
  routes.route('/', legacy.routes(options.ownerToken, options.privy));
  routes.all('*', (c) => handle(authenticatedRequest(c)));
  return { auth, routes, user, origin };
}
