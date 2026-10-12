import { TradingService } from './trading-service.js';
import { ComputerService } from './computer-service.js';
import { BrowserUseService } from './browser-use-service.js';
import { WalletService } from './wallet-service.js';
import { PumpService } from './pump-service.js';
import { JupiterService } from './jupiter-service.js';
import { ConnectionService } from './connections.js';
import { publicMcpTransport } from './public-mcp-transport.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { createSlackChannel } from './slack-channel.js';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { learningSelector } from './learning.js';
import { SetupTelemetry } from './setup-telemetry.js';
import { LocalConversationRunner } from './local-runner.js';
import { DotMemoryService } from './dot-memory.js';
export class Platform {
  private channelStartupFailed = false;
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly browserUse: BrowserUseService;
  readonly wallets: WalletService;
  readonly pump: PumpService;
  readonly jupiter: JupiterService;
  readonly connections: ConnectionService;
  readonly memory: DotMemoryService;
  readonly trading: TradingService;
  readonly intelligence?: CopilotKitIntelligence;
  readonly localRunner?: LocalConversationRunner;
  readonly handler?: CopilotHonoApp;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
  ) {
    this.setupTelemetry = new SetupTelemetry(store);
    this.memory = new DotMemoryService(store, workspace, config);
    this.trading = new TradingService(store, workspace, config.tradingEnv);
    this.wallets = new WalletService(config.owsVaultPath || 'data/ows');
    this.pump = new PumpService(
      store.database,
      workspace,
      this.wallets,
      config,
      () => store.settings().paused,
    );
    this.jupiter = new JupiterService(
      store.database,
      workspace,
      config,
      () => store.settings().paused,
    );
    this.browserUse = new BrowserUseService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.connections = new ConnectionService(
      workspace.connections,
      config.publicMcp ? publicMcpTransport : undefined,
    );
    if (!config.intelligenceKey)
      this.localRunner = new LocalConversationRunner(workspace);
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return (
        this.intelligence ?? {
          getOrCreateThread: async () => undefined,
          getThreadMessages: async ({ threadId }: { threadId: string }) => ({
            messages: this.localRunner!.getThreadMessages(threadId),
          }),
        }
      );
    });
    if (config.intelligenceKey)
      this.intelligence = new CopilotKitIntelligence({
        apiKey: config.intelligenceKey,
        apiUrl: config.intelligenceApiUrl,
        wsUrl: config.intelligenceWsUrl,
        getLearningContainerId: learningSelector(
          workspace,
          config.slackDotId ?? workspace.dots()[0]?.id,
        ),
      });
    const channels = [];
    if (
      this.intelligence &&
      config.slackChannel &&
      config.slackTeam &&
      config.slackUsers.length
    ) {
      const dotId = config.slackDotId ?? workspace.dots()[0].id;
      if (!workspace.dot(dotId))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
      const slack = createSlackChannel({
        name: config.slackChannel,
        config,
        ownerId: workspace.ownerId,
        paused: () => store.settings().paused,
        agent: () =>
          new DotAgent(
            store,
            workspace,
            config,
            dotId,
            true,
            this.setupTelemetry,
            this.memory,
            this.trading,
          ),
      });
      channels.push(slack);
    }
    const agents = async () =>
      Object.fromEntries(
        workspace
          .dots()
          .map((dot) => [
            dot.id,
            new DotAgent(
              store,
              workspace,
              config,
              dot.id,
              false,
              this.setupTelemetry,
              this.memory,
              this.trading,
            ),
          ]),
      );
    const common = {
      telemetryId: this.setupTelemetry.identity,
      telemetryProperties: this.setupTelemetry.metadata,
      agents,
    };
    const runtime = this.intelligence
      ? new CopilotRuntime({
          ...common,
          intelligence: this.intelligence,
          identifyUser: async () => ({
            id: workspace.ownerId,
            name: 'Solana Dots owner',
          }),
          channels,
          generateThreadNames: true,
        })
      : new CopilotRuntime({ ...common, runner: this.localRunner });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(
      this.config,
      this.handler?.channels?.status().overall ??
        (this.config.slackChannel ? 'setup_required' : 'not_configured'),
      this.channelStartupFailed,
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  async start() {
    this.memory.start();
    this.trading.start();
    this.setupTelemetry.start();
    if (this.handler?.channels) {
      try {
        await this.handler.channels.ready({ timeoutMs: 15000 });
        this.channelStartupFailed = false;
      } catch (error) {
        this.channelStartupFailed = true;
        this.setupTelemetry.capture({
          kind: 'setup_failed',
          step: 'settings',
          error_class: 'channel_start_failed',
        });
        throw error;
      }
    }
  }
  async stop() {
    const results = await Promise.allSettled([
      this.browserUse.stopAll(),
      this.localRunner?.stopAll(),
      this.setupTelemetry.stop(),
      this.handler?.channels?.stop(),
      this.memory.stop(),
      this.trading.stop(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    try {
      await this.intelligence?.createThread({
        threadId: id,
        userId: this.workspace.ownerId,
        agentId: dotId,
        name: title,
      });
    } catch {
      throw new Error(
        'Intelligence could not create this conversation. Check the runtime key and connection.',
      );
    }
    return this.workspace.bindThread(id, dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const history = this.intelligence
      ? await this.intelligence.getThreadMessages({
          threadId,
          userId: this.workspace.ownerId,
        })
      : { messages: this.localRunner!.getThreadMessages(threadId) };
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    if (!this.handler)
      return Response.json(
        { error: `Setup required: ${this.setup().missing.join(', ')}.` },
        { status: 503 },
      );
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    return runThreadTurn(
      this.config.runtimeUrl,
      this.config.ownerToken
        ? { Authorization: `Bearer ${this.config.ownerToken}` }
        : {},
      thread.dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
  messagingTurn(threadId: string, prompt: string, signal: AbortSignal) {
    return this.turn(threadId, prompt, signal, {
      opendotsSource: 'spectrum_message',
    });
  }
}
