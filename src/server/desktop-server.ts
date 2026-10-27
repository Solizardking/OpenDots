import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  pageAccessBoundary,
  missingPublicResource,
  hasDesktopPageCookie,
} from './public-page-access.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { modelConfigFromEnv } from './model-config.js';
import { createOpenMarketService } from './openmarket-service.js';
import { BirdeyeService } from './birdeye-service.js';
import { BirdeyeStream } from './birdeye-stream.js';
import { BirdeyeMcpService } from './birdeye-mcp.js';
import { createBirdeyeMemeService } from './birdeye-meme.js';
import { browserUseConfigFromEnv } from './browser-use-config.js';
import { mem0ConfigFromEnv } from './dot-memory.js';
import { CompanionRegistry, companionAllows } from './companion.js';
import { PrivyAuth } from './privy-auth.js';
import {
  XaiAuthorizationError,
  XaiOAuth,
  type XaiTokens,
} from './xai-oauth.js';
import { DesktopRelay } from './desktop-relay.js';
import type { PlatformConfig } from './platform-config.js';
import type { ServerType } from '@hono/node-server';

async function listen(
  fetch: Hono['fetch'],
  hostname: string,
  preferredPort: number,
) {
  for (const port of preferredPort ? [preferredPort, 0] : [0]) {
    const server = serve({ fetch, hostname, port });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.once('listening', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      return server;
    } catch (error) {
      if (port === 0 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
        throw error;
    }
  }
  throw Error('Could not start the workspace listener.');
}

export async function startDesktopServer(options: {
  dataPath: string;
  clientPath: string;
  token: string;
  env?: Record<string, string | undefined>;
  port?: number;
  relayOrigin?: string;
}) {
  const env = options.env ?? {};
  const store = new Store(join(options.dataPath, 'workspace.sqlite'));
  const workspace = new WorkspaceStore(
    join(options.dataPath, 'workspace.sqlite'),
    'solana-dots-desktop',
  );
  const registry = new CompanionRegistry(
    join(options.dataPath, 'paired-devices.json'),
  );
  // Privy identity link. The app ID and client ID are public identifiers;
  // the app secret never ships in the desktop app, so access tokens are
  // verified against Privy's JWKS only (PrivyAuth.verifyAccessToken). The
  // linked subject is the same did:privy: identity the web app resolves to
  // a workspace. Defaults are the production ChatGPTEE app and its
  // 'solanadots' client; PRIVY_APP_ID / PRIVY_CLIENT_ID settings override.
  const privyAppId = env.PRIVY_APP_ID?.trim() || 'cm7mmxm7a01bs3i2ltojavlnl';
  const privyClientId =
    env.PRIVY_CLIENT_ID?.trim() ||
    'client-WY5h9nS2qotwc22b7QY2amSocg9UQ2g42v3GPoykYcBbM';
  const privy = new PrivyAuth({
    appId: privyAppId,
    appSecret: '',
    clientId: privyClientId,
  });
  const privyIdentityPath = join(options.dataPath, 'privy-identity.json');
  let privyIdentity: { subject: string; linkedAt: number } | undefined;
  try {
    const saved = JSON.parse(readFileSync(privyIdentityPath, 'utf8'));
    if (
      saved &&
      typeof saved.subject === 'string' &&
      saved.subject.startsWith('did:privy:') &&
      typeof saved.linkedAt === 'number'
    )
      privyIdentity = { subject: saved.subject, linkedAt: saved.linkedAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const savePrivyIdentity = (
    next: { subject: string; linkedAt: number } | undefined,
  ) => {
    privyIdentity = next;
    if (!next) {
      try {
        unlinkSync(privyIdentityPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return;
    }
    mkdirSync(dirname(privyIdentityPath), { recursive: true, mode: 0o700 });
    const temporary = privyIdentityPath + '.tmp';
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, privyIdentityPath);
  };
  // xAI model OAuth (device flow). Tokens persist beside the workspace data
  // with the same 0600 atomic-write pattern as the Privy link. The device
  // code itself is memory-only and never leaves the server.
  const xai = new XaiOAuth();
  const xaiTokensPath = join(options.dataPath, 'xai-oauth.json');
  let xaiTokens: XaiTokens | undefined;
  try {
    const saved = JSON.parse(readFileSync(xaiTokensPath, 'utf8'));
    if (
      saved &&
      typeof saved.accessToken === 'string' &&
      typeof saved.tokenType === 'string' &&
      saved.tokenType.toLowerCase() === 'bearer' &&
      typeof saved.expiresAt === 'number' &&
      (saved.refreshToken === undefined ||
        typeof saved.refreshToken === 'string')
    )
      xaiTokens = {
        accessToken: saved.accessToken,
        tokenType: saved.tokenType,
        expiresAt: saved.expiresAt,
        ...(typeof saved.refreshToken === 'string'
          ? { refreshToken: saved.refreshToken }
          : {}),
        ...(typeof saved.scope === 'string' ? { scope: saved.scope } : {}),
      };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const saveXaiTokens = (next: XaiTokens | undefined) => {
    xaiTokens = next;
    if (!next) {
      try {
        unlinkSync(xaiTokensPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return;
    }
    mkdirSync(dirname(xaiTokensPath), { recursive: true, mode: 0o700 });
    const temporary = xaiTokensPath + '.tmp';
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, xaiTokensPath);
  };
  let xaiPending:
    | { deviceCode: string; expiresAt: number; intervalMs: number }
    | undefined;
  // A connected xAI account stands in for XAI_API_KEY when none is set:
  // refresh once at startup when the stored token is due, then hand the
  // access token to the model config. Later expiry is picked up on the
  // next workspace restart (saving provider settings restarts it).
  let modelEnv = env;
  if (xaiTokens && !env.XAI_API_KEY?.trim()) {
    try {
      let current = xaiTokens;
      if (!xai.accessToken(current)) {
        current = await xai.refresh(current);
        saveXaiTokens(current);
      }
      modelEnv = { ...env, XAI_API_KEY: current.accessToken };
    } catch {
      /* Keep the configured providers; /api/model/xai reports the state. */
    }
  }
  const config: PlatformConfig = {
    birdeyeMcp: new BirdeyeMcpService({ env }),
    birdeyeMeme: createBirdeyeMemeService({ env }),
    openMarket: createOpenMarketService({ env }),
    birdeye: new BirdeyeService({ env }),
    ...mem0ConfigFromEnv(env),
    ...modelConfigFromEnv(modelEnv),
    ...browserUseConfigFromEnv(env),
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim(),
    openrouterClaudeModel: env.OPENROUTER_CLAUDE_MODEL?.trim(),
    xaiApiKey: modelEnv.XAI_API_KEY,
    xaiImageModel: env.XAI_IMAGE_MODEL,
    voiceKey: env.VOICE_API_KEY,
    voiceModel: env.VOICE_MODEL,
    voiceName: env.VOICE_NAME || 'marin',
    e2bApiKey: env.E2B_API_KEY,
    e2bTemplate: 'desktop',
    e2bTimeoutMs: 300000,
    computerProvider: 'e2b',
    intelligenceKey: env.COPILOTKIT_INTELLIGENCE_API_KEY,
    parallelApiKey: env.PARALLEL_API_KEY,
    webSearchProvider: env.PARALLEL_API_KEY ? 'parallel' : 'disabled',
    slackUsers: [],
    ownerToken: options.token,
    publicMcp: true,
    runtimeUrl: '',
    owsVaultPath: join(options.dataPath, 'ows'),
    pumpEnabled: true,
    tradingEnv: env,
    solanaRpcUrl: env.SOLANA_RPC_URL,
  };
  config.birdeyeStream = new BirdeyeStream({ env, service: config.birdeye });
  const platform = new Platform(store, workspace, config);
  const research = {
    mode: 'live' as const,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    webSearchProvider: config.webSearchProvider,
    parallelApiKey: config.parallelApiKey,
  };
  const runner = new Runner(
    store,
    research,
    async (claim, _memories, signal, progress) => {
      const thread = workspace.taskThread(claim.id);
      if (!thread)
        throw Error('Select a conversation for this scheduled task.');
      progress('Working in the original conversation.');
      return {
        text: await platform.turn(thread, claim.prompt, signal),
        sources: [],
        sample: false,
      };
    },
  );
  let localOrigin = '';
  let companionServer: ServerType | undefined;
  let companionPort = 0;
  let companionOrigins: string[] = [];
  const featureApp = createApp({
    store,
    runner,
    config: research,
    platform,
    ownerToken: options.token,
  });
  const authenticated = (supplied: string) => {
    const a = Buffer.from(options.token),
      b = Buffer.from(supplied);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  let relay: DesktopRelay | undefined;
  const state = () => ({
    enabled: !!companionServer,
    urls: companionOrigins,
    remote: relay?.state(),
    pairing: registry.pairing(),
    devices: registry.list(),
    keepAwake: false,
  });
  const appFor = (phone: boolean) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      const url = new URL(c.req.url);
      const allowed = phone ? companionOrigins : [localOrigin];
      if (!allowed.includes(url.origin))
        return c.json({ error: 'Unrecognized host.' }, 403);
      const origin = c.req.header('origin');
      if (
        (origin && origin !== url.origin) ||
        c.req.header('sec-fetch-site') === 'cross-site'
      )
        return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Referrer-Policy', 'no-referrer');
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' wss://clawd-ws.fly.dev https://api.mainnet-beta.solana.com https://explorer-api.walletconnect.com wss://realtime.intelligence.copilotkit.ai; media-src 'self' blob:; frame-src https://live.browser-use.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      await next();
    });
    app.get('/healthz', (c) =>
      c.json({ status: 'ready', application: 'ChatGPTEE', desktop: !phone }),
    );
    if (phone)
      app.post('/api/companion/pair', async (c) => {
        if (!c.req.header('content-type')?.includes('application/json'))
          return c.json({ error: 'Use application/json.' }, 415);
        const raw = await c.req.text();
        if (raw.length > 4096)
          return c.json({ error: 'Request too large.' }, 413);
        try {
          const body = JSON.parse(raw);
          if (
            typeof body.credential !== 'string' ||
            body.credential.length > 128 ||
            typeof body.name !== 'string'
          )
            throw Error('Enter a pairing code and device name.');
          const result = registry.pair(body.credential, body.name);
          c.header(
            'Set-Cookie',
            `solana_dots_phone=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
          );
          return c.json({ paired: true, device: result.device });
        } catch (error) {
          return c.json(
            {
              error: error instanceof Error ? error.message : 'Pairing failed.',
            },
            400,
          );
        }
      });
    app.get('/api/auth/config', (c) =>
      c.json({
        desktop: !phone,
        companion: phone,
        betterAuth: false,
        privyAppId,
        privyClientId,
        privySocialProviders: ['google', 'twitter', 'github'],
      }),
    );
    app.use('/api/*', async (c, next) => {
      let valid: boolean;
      if (phone) {
        const cookie = c.req
          .header('cookie')
          ?.split(';')
          .map((x) => x.trim())
          .find((x) => x.startsWith('solana_dots_phone='))
          ?.slice('solana_dots_phone='.length);
        valid = !!registry.authenticate(cookie ?? '');
      } else
        valid = authenticated(
          c.req.header('authorization')?.replace(/^Bearer /, '') || '',
        );
      if (!valid)
        return c.json(
          {
            error: phone
              ? 'Pair this phone from your Mac first.'
              : 'Desktop session required.',
          },
          401,
        );
      if (phone && !companionAllows(c.req.method, new URL(c.req.url).pathname))
        return c.json({ error: 'Manage this feature on your Mac.' }, 403);
      await next();
    });
    const sessionBody = () => ({
      user: null,
      owner: true,
      desktop: !phone,
      companion: phone,
      privy: privyIdentity
        ? { subject: privyIdentity.subject, linkedAt: privyIdentity.linkedAt }
        : null,
    });
    app.get('/api/auth/session', (c) => c.json(sessionBody()));
    // Link the owner's Privy identity to this Mac's workspace. Paired phones
    // never reach these routes: companionAllows excludes them, so the auth
    // middleware above answers 403 'Manage this feature on your Mac.'
    app.post('/api/auth/privy', async (c) => {
      if (!c.req.header('content-type')?.includes('application/json'))
        return c.json({ error: 'Use application/json.' }, 415);
      const raw = await c.req.text();
      if (raw.length > 8192)
        return c.json({ error: 'Request too large.' }, 413);
      try {
        const body = JSON.parse(raw) as { accessToken?: unknown };
        if (
          typeof body.accessToken !== 'string' ||
          body.accessToken.length < 20 ||
          body.accessToken.length > 7000
        )
          throw Error('Invalid Privy sign-in.');
        const subject = await privy.verifyAccessToken(body.accessToken);
        savePrivyIdentity({ subject, linkedAt: Date.now() });
        return c.json(sessionBody());
      } catch {
        return c.json(
          { error: 'Privy could not verify your sign-in. Please try again.' },
          401,
        );
      }
    });
    app.post('/api/auth/privy/unlink', (c) => {
      savePrivyIdentity(undefined);
      return c.json(sessionBody());
    });
    // xAI model connection (device flow). Like the Privy link routes, paired
    // phones never reach these: companionAllows excludes them.
    app.get('/api/model/xai', (c) =>
      c.json({
        connected: !!xaiTokens,
        ...(xaiTokens ? { expiresAt: xaiTokens.expiresAt } : {}),
      }),
    );
    app.post('/api/model/xai/start', async (c) => {
      try {
        const start = await xai.start();
        xaiPending = {
          deviceCode: start.deviceCode,
          expiresAt: start.expiresAt,
          intervalMs: start.intervalMs,
        };
        return c.json({
          userCode: start.userCode,
          verificationUri: start.verificationUri,
          expiresAt: start.expiresAt,
          intervalMs: start.intervalMs,
        });
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof XaiAuthorizationError
                ? error.message
                : 'xAI sign-in could not start. Please retry.',
          },
          502,
        );
      }
    });
    app.post('/api/model/xai/poll', async (c) => {
      if (!xaiPending || xaiPending.expiresAt <= Date.now()) {
        xaiPending = undefined;
        return c.json({ error: 'Start xAI sign-in again.' }, 410);
      }
      try {
        const result = await xai.poll(
          xaiPending.deviceCode,
          xaiPending.intervalMs,
        );
        if (result.status === 'pending') {
          xaiPending.intervalMs = result.intervalMs;
          return c.json({ connected: false, intervalMs: result.intervalMs });
        }
        saveXaiTokens(result.tokens);
        xaiPending = undefined;
        return c.json({ connected: true, expiresAt: result.tokens.expiresAt });
      } catch (error) {
        xaiPending = undefined;
        return c.json(
          {
            error:
              error instanceof XaiAuthorizationError
                ? error.message
                : 'xAI sign-in could not finish. Please retry.',
          },
          401,
        );
      }
    });
    app.post('/api/model/xai/disconnect', (c) => {
      xaiPending = undefined;
      saveXaiTokens(undefined);
      return c.json({ connected: false });
    });
    if (!phone) app.get('/api/companion/state', (c) => c.json(state()));
    app.all('/api/*', async (c) => {
      // Scope every request to this Mac's workspace. Do not forward a phone token upstream.
      const headers = new Headers(c.req.raw.headers);
      headers.set('authorization', `Bearer ${options.token}`);
      headers.delete('origin');
      headers.delete('sec-fetch-site');
      headers.delete('cookie');
      const request = new Request(
        localOrigin + new URL(c.req.url).pathname + new URL(c.req.url).search,
        {
          method: c.req.method,
          headers,
          ...(['GET', 'HEAD'].includes(c.req.method)
            ? {}
            : { body: c.req.raw.body, duplex: 'half' }),
        } as RequestInit,
      );
      return featureApp.fetch(request);
    });
    app.use(
      '/*',
      pageAccessBoundary((c) =>
        phone
          ? !!registry.authenticate(getCookie(c, 'solana_dots_phone') || '')
          : authenticated(
              c.req.header('authorization')?.replace(/^Bearer /, '') || '',
            ) || hasDesktopPageCookie(c, options.token),
      ),
    );
    app.use(
      '/*',
      serveStatic({
        root: options.clientPath,
      }),
    );
    app.get('*', async (c, next) => {
      if (missingPublicResource(c)) return c.text('Not found.', 404);
      const response = await serveStatic({
        path: join(options.clientPath, 'index.html'),
      })(c, next);
      return response || c.res;
    });
    return app;
  };
  const localApp = appFor(false);
  const server = await listen(
    localApp.fetch,
    '127.0.0.1',
    options.port ?? 4319,
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('Desktop server did not bind.');
  localOrigin = `http://127.0.0.1:${address.port}`;
  config.runtimeUrl = localOrigin + '/api/copilotkit';
  runner.start();
  await platform.start();
  const stopPhone = async () => {
    registry.cancel();
    relay?.stop();
    relay = undefined;
    if (companionServer) {
      const closing = companionServer;
      companionServer = undefined;
      if ('closeAllConnections' in closing) closing.closeAllConnections();
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
    companionOrigins = [];
    companionPort = 0;
    return state();
  };
  return {
    origin: localOrigin,
    state,
    async action(action: string, value?: string) {
      if (action === 'start') {
        if (!companionServer) {
          companionServer = await listen(appFor(true).fetch, '0.0.0.0', 4320);
          const address = companionServer.address();
          if (!address || typeof address === 'string')
            throw Error('Phone listener failed.');
          companionPort = address.port;
          const ips = [
            ...new Set(
              Object.values(networkInterfaces())
                .flat()
                .filter((i) => i && i.family === 'IPv4' && !i.internal)
                .map((i) => i!.address),
            ),
          ];
          companionOrigins = [...ips, '127.0.0.1'].map(
            (ip) => `http://${ip}:${companionPort}`,
          );
          relay = new DesktopRelay(
            join(options.dataPath, 'relay-identity.json'),
            appFor(true).fetch,
            () => `http://127.0.0.1:${companionPort}`,
            options.relayOrigin,
          );
          relay.start();
        }
      } else if (action === 'stop') return stopPhone();
      else if (action === 'pair') {
        if (!companionServer) throw Error('Enable Phone access first.');
        registry.open();
      } else if (action === 'cancel') registry.cancel();
      else if (action === 'revoke' && value) registry.revoke(value);
      else if (action !== 'state') throw Error('Unknown Phone action.');
      return state();
    },
    async close() {
      runner.stop();
      await stopPhone();
      await platform.stop();
      await config.birdeyeStream?.stop();
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      workspace.close();
      store.close();
    },
  };
}

// Electron's utilityProcess sends secrets over a private IPC pipe, never argv.
type Parent = {
  on: (
    name: string,
    fn: (event: { data: Record<string, unknown> }) => void,
  ) => void;
  postMessage: (value: unknown) => void;
};
const parent = (process as typeof process & { parentPort?: Parent }).parentPort;
if (parent) {
  let runtime: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
  parent.on(
    'message',
    (event) =>
      void (async () => {
        const message = event.data;
        try {
          if (message.action === 'initialize') {
            runtime = await startDesktopServer(
              message.options as Parameters<typeof startDesktopServer>[0],
            );
            parent.postMessage({ ready: true, origin: runtime.origin });
          } else if (message.action === 'shutdown') {
            await runtime?.close();
            process.exit(0);
          } else
            parent.postMessage({
              id: message.id,
              result: await runtime?.action(
                String(message.action),
                message.value as string,
              ),
            });
        } catch (error) {
          let detail =
            error instanceof Error ? error.message : 'Unknown desktop error';
          for (const value of Object.values(
            (message.options as { env?: Record<string, string> } | undefined)
              ?.env ?? {},
          ))
            if (value.length >= 12)
              detail = detail.split(value).join('[redacted]');
          parent.postMessage({
            id: message.id,
            error:
              'The desktop service could not complete this action. Check setup and retry.',
            detail: detail.slice(0, 2000),
          });
        }
      })(),
  );
}
