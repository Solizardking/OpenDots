import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { Platform } from './platform.js';
import { Runner } from './runner.js';
import { createApp } from './app.js';
import type { PlatformConfig } from './platform-config.js';
import type { SolanaUser } from '../shared/auth-types.js';

export class UserWorkspaces {
  private internalTokens = new Map<string, Hono>();
  private runtimes = new Map<
    string,
    {
      app: Hono;
      runner: Runner;
      platform: Platform;
      store: Store;
      workspace: WorkspaceStore;
    }
  >();
  constructor(
    private root: string,
    private config: PlatformConfig,
    private origin?: string[],
  ) {}
  restore(users: SolanaUser[]) {
    // Resume persisted schedules after a restart, even before the user signs back in.
    for (const user of users)
      if (existsSync(join(this.root, user.id, 'workspace.sqlite')))
        this.app(user);
  }
  internal(authorization?: string) {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    return this.internalTokens.get(
      createHash('sha256').update(authorization.slice(7)).digest('hex'),
    );
  }
  runtime(user: SolanaUser) {
    this.app(user);
    return this.runtimes.get(user.id)!;
  }
  app(user: SolanaUser) {
    if (!/^[0-9a-f-]{36}$/.test(user.id))
      throw new Error('Invalid user identity.');
    const existing = this.runtimes.get(user.id);
    if (existing) return existing.app;
    const directory = join(this.root, user.id);
    const store = new Store(join(directory, 'workspace.sqlite'));
    const workspace = new WorkspaceStore(
      join(directory, 'workspace.sqlite'),
      user.id,
    );
    const config: PlatformConfig = {
      ...this.config,
      // Server-only credentials scope scheduled turns and call receipts to this user.
      ownerToken: randomBytes(32).toString('hex'),
      publicMcp: true,
      browserUseIsolatedWorkspace: true,
      browserUseWorkspaceId: undefined,
      owsVaultPath: join(directory, 'ows'),
      // Owner Slack identity and browser login profiles belong to the legacy workspace.
      slackChannel: undefined,
      slackTeam: undefined,
      slackUsers: [],
      slackDotId: undefined,
      clawdProfile: undefined,
      cdpUrl: undefined,
    };
    const platform = new Platform(store, workspace, config);
    const research = {
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
      research,
      async (claim, _memories, signal, progress) => {
        const threadId = workspace.taskThread(claim.id);
        if (!threadId)
          throw new Error('Select a conversation for this scheduled task.');
        progress('Running this task in its original conversation.');
        return {
          text: await platform.turn(threadId, claim.prompt, signal, {
            opendotsSource: 'scheduled_task',
          }),
          sources: [],
          sample: false,
        };
      },
    );
    const app = createApp({
      store,
      runner,
      config: research,
      platform,
      origin: this.origin,
    });
    this.runtimes.set(user.id, { app, runner, platform, store, workspace });
    this.internalTokens.set(
      createHash('sha256').update(config.ownerToken!).digest('hex'),
      app,
    );
    runner.start();
    void platform
      .start()
      .catch(() => console.error('User workspace service activation failed.'));
    return app;
  }
  stopRunners() {
    for (const runtime of this.runtimes.values()) runtime.runner.stop();
  }
  async stop() {
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        try {
          await runtime.platform.stop();
        } finally {
          runtime.workspace.close();
          runtime.store.close();
        }
      }),
    );
    this.runtimes.clear();
    this.internalTokens.clear();
  }
}
