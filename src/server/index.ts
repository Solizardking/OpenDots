import { webSearchProvider } from './parallel.js';
import { BirdeyeService } from './birdeye-service.js';
import { BirdeyeStream } from './birdeye-stream.js';
import { BirdeyeMcpService } from './birdeye-mcp.js';
import { createBirdeyeMemeService } from './birdeye-meme.js';
import {
  pageAccessBoundary,
  missingPublicResource,
} from './public-page-access.js';
import { Hono } from 'hono';
import { agentAccessRoutes } from './agent-access.js';
import { dirname, join } from 'node:path';
import { PostgresUserDatabase } from './user-database.js';
import { databaseUrlFromEnv } from './database-config.js';
import { browserBoundary, isOwner } from './solana-auth.js';
import { PrivyAuth } from './privy-auth.js';
import { createHybridAuth } from './better-auth.js';
import { UserWorkspaces } from './user-workspaces.js';
import { createShutdown } from './shutdown.js';
import { reportChannelFailure, safeFailure } from './slack-channel.js';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Store } from './store.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import { releaseInfo } from './release-info.js';
import { resolveAppOrigins } from './app-origin.js';
import { WorkspaceStore } from './workspace.js';
import { mem0ConfigFromEnv } from './dot-memory.js';
import { modelConfigFromEnv } from './model-config.js';
import { createHash } from 'node:crypto';
import {
  SpectrumMessagingTransport,
  spectrumMessagingConfig,
} from './spectrum-messaging.js';
import { MessagingStore } from './messaging-store.js';
import { MessagingCoordinator } from './messaging-coordinator.js';
import { messagingRoutes } from './messaging-routes.js';
import { Platform } from './platform.js';
import { sandboxFrameRoute } from './sandbox-frame.js';
import { browserUseConfigFromEnv } from './browser-use-config.js';
import {
  intelligenceApiKeyFromEnv,
  intelligenceWsUrlFromEnv,
  type PlatformConfig,
} from './platform-config.js';
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4310);
const ownerToken = process.env.OWNER_TOKEN;
if (
  !['127.0.0.1', '::1', 'localhost'].includes(host) &&
  (!ownerToken || ownerToken.length < 24)
)
  throw new Error(
    'External binding requires an OWNER_TOKEN of at least 24 characters.',
  );
const database = process.env.DATABASE_PATH ?? 'data/opendots.sqlite';
const store = new Store(database);
const workspace = new WorkspaceStore(
  database,
  process.env.OWNER_ID ?? 'opendots-owner',
);
const config: PlatformConfig = {
  birdeye: new BirdeyeService({ env: process.env }),
  birdeyeMcp: new BirdeyeMcpService({ env: process.env }),
  birdeyeMeme: createBirdeyeMemeService({ env: process.env }),
  ...mem0ConfigFromEnv(process.env),
  intelligenceKey: intelligenceApiKeyFromEnv(process.env),
  intelligenceApiUrl: process.env.INTELLIGENCE_API_URL || undefined,
  intelligenceWsUrl: intelligenceWsUrlFromEnv(process.env),
  ...modelConfigFromEnv(process.env),
  openrouterApiKey: process.env.OPENROUTER_API_KEY?.trim(),
  openrouterClaudeModel: process.env.OPENROUTER_CLAUDE_MODEL?.trim(),
  ...browserUseConfigFromEnv(process.env),
  xaiApiKey: process.env.XAI_API_KEY?.trim(),
  xaiImageModel: process.env.XAI_IMAGE_MODEL?.trim(),
  owsVaultPath: process.env.OWS_VAULT_PATH || 'data/ows',
  solanaRpcUrl: process.env.SOLANA_RPC_URL?.trim(),
  computerProvider:
    process.env.COMPUTER_PROVIDER === 'openbot' ? 'openbot' : 'e2b',
  e2bApiKey: process.env.E2B_API_KEY?.trim(),
  e2bTemplate: process.env.E2B_TEMPLATE?.trim() || 'desktop',
  e2bTimeoutMs: Number(process.env.E2B_TIMEOUT_MS || 300000),
  webSearchProvider: webSearchProvider(process.env.WEB_SEARCH_PROVIDER),
  parallelApiKey: process.env.PARALLEL_API_KEY,
  browserUrl: process.env.BROWSER_URL,
  browserSecret: process.env.BROWSER_SECRET,
  computerSupervisorUrl: process.env.COMPUTER_SUPERVISOR_URL,
  computerSupervisorToken: process.env.COMPUTER_SUPERVISOR_TOKEN,
  computerToken: process.env.COMPUTER_TOKEN,
  computerNamespace: process.env.COMPUTER_NAMESPACE,
  voiceKey: process.env.VOICE_API_KEY,
  voiceModel: process.env.VOICE_MODEL,
  voiceName: process.env.VOICE_NAME ?? 'marin',
  slackChannel: process.env.SLACK_CHANNEL_NAME,
  slackTeam: process.env.SLACK_TEAM_ID,
  slackUsers: (process.env.SLACK_USER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  slackDotId: process.env.SLACK_DOT_ID || undefined,
  runtimeUrl: `http://${host === '::1' ? '[::1]' : '127.0.0.1'}:${port}/api/copilotkit`,
  ownerToken,
};
config.birdeyeStream = new BirdeyeStream({
  env: process.env,
  service: config.birdeye,
});
const platform = new Platform(store, workspace, config);
const researchConfig = {
  mode: 'live' as const,
  apiKey: config.apiKey,
  model: config.model,
  baseUrl: config.baseUrl,
  webSearchProvider: config.webSearchProvider,
  parallelApiKey: config.parallelApiKey,
  browserUrl: config.browserUrl,
  browserSecret: config.browserSecret,
};
const runner = new Runner(
  store,
  researchConfig,
  async (claim, _memories, signal, progress) => {
    const threadId = workspace.taskThread(claim.id);
    if (!threadId)
      throw new Error(
        'This legacy task has no Intelligence conversation. Create a new scheduled task from a conversation.',
      );
    progress('Running this task in its Intelligence conversation.');
    const text = await platform.turn(threadId, claim.prompt, signal, {
      opendotsSource: 'scheduled_task',
    });
    return { text, sources: [], sample: false };
  },
);
const wsOrigin = new URL(
  config.intelligenceWsUrl ?? 'wss://realtime.intelligence.copilotkit.ai',
).origin;
const featureApp = createApp({
  store,
  runner,
  config: researchConfig,
  ownerToken,
  origin: resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV),
  platform,
});
const users = new PostgresUserDatabase(databaseUrlFromEnv(process.env));
try {
  await users.initialize();
} catch {
  throw new Error(
    'The user database is unavailable. Check the PostgreSQL URL and provider connectivity.',
  );
}
const privy =
  process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET
    ? new PrivyAuth({
        appId: process.env.PRIVY_APP_ID,
        appSecret: process.env.PRIVY_APP_SECRET,
        clientId: process.env.PRIVY_CLIENT_ID,
      })
    : undefined;
const origins = resolveAppOrigins(process.env.APP_ORIGIN, process.env.NODE_ENV);
const auth = await createHybridAuth({
  users,
  privy,
  ownerToken,
  stateDir: dirname(database),
});
const workspaces = new UserWorkspaces(
  process.env.USER_DATA_PATH ?? join(dirname(database), 'users'),
  config,
  origins,
);
workspaces.restore(await users.users());
const messagingConfig = spectrumMessagingConfig(process.env);
const messagingTransport: SpectrumMessagingTransport =
  new SpectrumMessagingTransport(messagingConfig, (event) =>
    messaging.receive(event),
  );
const messaging: MessagingCoordinator = new MessagingCoordinator(
  new MessagingStore(store.database),
  messagingTransport,
  async (ownerId) => {
    const runtime =
      ownerId === workspace.ownerId
        ? { workspace, platform }
        : await (async () => {
            const user = await users.byId(ownerId);
            return user ? workspaces.runtime(user) : undefined;
          })();
    if (!runtime) return undefined;
    return {
      dot: (id) => runtime.workspace.dot(id),
      createConversation: (id, title) =>
        runtime.platform.createConversation(id, title),
      turn: (threadId, prompt, signal) =>
        runtime.platform.messagingTurn(threadId, prompt, signal),
    };
  },
  (channel) =>
    createHash('sha256')
      .update(
        JSON.stringify([
          messagingConfig.projectId,
          channel,
          channel === 'telegram'
            ? messagingConfig.telegram?.botToken
            : messagingConfig.imessage,
        ]),
      )
      .digest('hex'),
);
const app = new Hono();
const privyOrigin = new URL(
  process.env.PRIVY_AUTH_ORIGIN ?? 'https://auth.privy.io',
).origin;
if (!privyOrigin.startsWith('https://'))
  throw new Error('PRIVY_AUTH_ORIGIN must use HTTPS.');
app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' https://auth.privy.io/js/; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://auth.privy.io https://static.privy.io ${privyOrigin} https://explorer-api.walletconnect.com; connect-src 'self' wss://clawd-ws.fly.dev ${wsOrigin} https://auth.privy.io https://*.privy.io ${privyOrigin} https://*.privy.systems https://api.mainnet-beta.solana.com https://explorer-api.walletconnect.com; media-src 'self' blob:; frame-src 'self' https://live.browser-use.com https://auth.privy.io https://*.privy.io ${privyOrigin} https://oauth.telegram.org; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  await next();
});
// Generated-UI sandbox document: static, no user data, its own strict CSP.
app.route('/', sandboxFrameRoute());
app.get('/healthz', async (c) => {
  c.header('Cache-Control', 'no-store');
  await users.pool.query('SELECT 1');
  return c.json({
    status: 'ready',
    application: 'ChatGPTEE',
    ...releaseInfo(),
  });
});
// Better Auth validates its callbacks/state and cookie mutations itself. OAuth
// callbacks arrive as cross-site navigations; private APIs retain the boundary.
app.route('/api/auth', auth.routes);
app.route('/api/agent', agentAccessRoutes(privy));
app.use('/api/*', browserBoundary(origins));
app.route(
  '/api/messaging',
  messagingRoutes(messaging, async (c) =>
    isOwner(c, ownerToken) ? workspace.ownerId : (await auth.user(c))?.id,
  ),
);
app.all('/api/*', async (c) => {
  if (isOwner(c, ownerToken)) return featureApp.fetch(c.req.raw);
  const internal = workspaces.internal(c.req.header('authorization'));
  if (internal) return internal.fetch(c.req.raw);
  const user = await auth.user(c);
  if (!user) return c.json({ error: 'Sign in to open your workspace.' }, 401);
  return workspaces.app(user).fetch(c.req.raw);
});
app.onError((_error, c) =>
  c.json(
    { error: 'The service is temporarily unavailable. Please retry.' },
    503,
  ),
);
app.get('/api/*', (c) => c.json({ error: 'Not found.' }, 404));
app.use(
  '/*',
  pageAccessBoundary(
    async (c) => isOwner(c, ownerToken) || !!(await auth.user(c)),
  ),
);
app.use(
  '/*',
  serveStatic({
    root: './dist/client',
  }),
);
app.get('*', async (c, next) => {
  if (missingPublicResource(c)) return c.text('Not found.', 404);
  const response = await serveStatic({ path: './dist/client/index.html' })(
    c,
    next,
  );
  return response || c.res;
});
const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`ChatGPTEE listening on http://${host}:${info.port}`);
  runner.start();
  void messagingTransport
    .start()
    .catch(() =>
      reportChannelFailure('Spectrum messaging activation failed', [
        'provider_unavailable',
      ]),
    );
  void platform
    .start()
    .catch((error) =>
      reportChannelFailure(
        'Slack Channels activation failed; check setup status',
        [safeFailure(error)],
      ),
    );
});
const shutdown = createShutdown({
  timeoutMs: 60000,
  stopRunner: () => {
    runner.stop();
    workspaces.stopRunners();
  },
  stopPlatform: async () => {
    await messaging.stop();
    await messagingTransport.stop();
    await Promise.all([platform.stop(), workspaces.stop()]);
    await config.birdeyeStream?.stop();
    await users.close();
  },
  closeServer: () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  exit: (code) => process.exit(code),
  report: (operation, error) =>
    reportChannelFailure(operation, [safeFailure(error)]),
});
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
