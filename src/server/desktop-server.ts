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
import { join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { modelConfigFromEnv } from './model-config.js';
import { createOpenMarketService } from './openmarket-service.js';
import { browserUseConfigFromEnv } from './browser-use-config.js';
import { mem0ConfigFromEnv } from './dot-memory.js';
import { CompanionRegistry, companionAllows } from './companion.js';
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
  const config: PlatformConfig = {
    openMarket: createOpenMarketService({ env }),
    ...mem0ConfigFromEnv(env),
    ...modelConfigFromEnv(env),
    ...browserUseConfigFromEnv(env),
    openrouterApiKey: env.OPENROUTER_API_KEY?.trim(),
    openrouterClaudeModel: env.OPENROUTER_CLAUDE_MODEL?.trim(),
    xaiApiKey: env.XAI_API_KEY,
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
      c.json({ desktop: !phone, companion: phone, betterAuth: false }),
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
    app.get('/api/auth/session', (c) =>
      c.json({ user: null, owner: true, desktop: !phone, companion: phone }),
    );
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
