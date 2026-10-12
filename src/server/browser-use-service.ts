import { BrowserUse, type RunCreateBody } from 'browser-use-sdk/v4';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { BrowserUseConfig } from './browser-use-config.js';
import type { WorkspaceStore } from './workspace.js';
import {
  cloudRunFinished,
  type BrowserUseStatus,
  type CloudBrowser,
  type CloudRun,
} from '../shared/browser-use-types.js';

const browserSchema = z.object({
  id: z.string(),
  status: z.enum(['active', 'stopped']),
  liveUrl: z.string().nullable().optional(),
  cdpUrl: z.string().nullable().optional(),
  recordingUrl: z.string().nullable().optional(),
  recordingAvailable: z.boolean().optional(),
  timeoutAt: z.string(),
  agentSessionId: z.string().nullable().optional(),
});
export const cloudTask = z
  .object({
    task: z.string().trim().min(1).max(12000),
    followup: z.boolean().optional(),
  })
  .strict();

export class BrowserUseError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export function cloudRunError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (/invalid_api_key|incorrect api key|authentication_error/i.test(error))
    return 'Browser Use’s upstream model credentials were rejected (HTTP 401). Check the OpenAI provider configuration in Browser Use Cloud, then retry.';
  if (/insufficient|quota|credit|spend.limit/i.test(error))
    return 'Browser Use could not complete the task because provider credits or quota are unavailable. Check the Browser Use account and model provider.';
  return 'Browser Use could not complete the task. Check the run in Browser Use Cloud for provider details.';
}
const publicBrowser = (browser: CloudBrowser): CloudBrowser => ({
  id: browser.id,
  status: browser.status,
  liveUrl: browser.liveUrl,
  recordingUrl: browser.recordingUrl,
  recordingAvailable: browser.recordingAvailable,
  timeoutAt: browser.timeoutAt,
});
const workspaceLocks = new WeakMap<WorkspaceStore, Set<string>>();
const providerWorkspaceCreations = new WeakMap<
  WorkspaceStore,
  Promise<string>
>();

export class BrowserUseService {
  private readonly client?: BrowserUse;
  private readonly busy: Set<string>;
  constructor(
    private workspace: WorkspaceStore,
    private config: BrowserUseConfig,
    private paused: () => boolean,
    client?: BrowserUse,
  ) {
    this.busy = workspaceLocks.get(workspace) ?? new Set<string>();
    workspaceLocks.set(workspace, this.busy);
    this.client =
      client ??
      (config.browserUseApiKey
        ? new BrowserUse({
            apiKey: config.browserUseApiKey,
            maxRetries: 0,
            timeout: 15000,
          })
        : undefined);
  }
  get configured() {
    return !!this.client;
  }
  private requireDot(id: string) {
    if (!this.workspace.dot(id))
      throw new BrowserUseError('Dot not found.', 404);
  }
  private requireEnabled(id: string) {
    this.requireDot(id);
    if (this.paused()) throw new BrowserUseError('ChatGPTEE is paused.', 403);
    if (!this.workspace.browserUse.get(id).enabled)
      throw new BrowserUseError(
        'Enable Browser Use for this Dot in the Computer panel.',
        403,
      );
    if (!this.client)
      throw new BrowserUseError(
        'Set BROWSERUSE_API_KEY on the server, then restart.',
        503,
      );
  }
  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof BrowserUseError) throw error;
      const code =
        error && typeof error === 'object' && 'status' in error
          ? Number(error.status)
          : undefined;
      throw new BrowserUseError(
        `Browser Use request failed${code ? ` (HTTP ${code})` : ''}. Check the API key, profile, workspace, account credits, and provider availability.`,
      );
    }
  }
  private async exclusive<T>(
    id: string,
    operation: () => Promise<T>,
    wait = false,
  ): Promise<T> {
    this.requireDot(id);
    const deadline = Date.now() + 30000;
    while (this.busy.has(id)) {
      if (!wait || Date.now() >= deadline)
        throw new BrowserUseError('Browser Use is busy. Retry shortly.', 409);
      await delay(25);
    }
    this.busy.add(id);
    try {
      return await operation();
    } finally {
      this.busy.delete(id);
    }
  }
  private async isolatedWorkspaceId(): Promise<string> {
    const saved = this.workspace.browserUse.providerWorkspaceId();
    if (saved) return saved;
    const pending = providerWorkspaceCreations.get(this.workspace);
    if (pending) return pending;
    const creating = this.provider(async () => {
      const namespace = await this.client!.workspaces.create({
        name: 'ChatGPTEE workspace',
      });
      if (!namespace.id)
        throw new BrowserUseError(
          'Could not create a private Browser Use workspace.',
        );
      this.workspace.browserUse.saveProviderWorkspaceId(namespace.id);
      return namespace.id;
    });
    providerWorkspaceCreations.set(this.workspace, creating);
    try {
      return await creating;
    } finally {
      if (providerWorkspaceCreations.get(this.workspace) === creating)
        providerWorkspaceCreations.delete(this.workspace);
    }
  }
  // SDK 3.11.3 has v4 create/stop but no browsers.get; inspect through the same v4 REST API.
  private async rest(path: string): Promise<unknown> {
    return this.provider(async () => {
      const response = await fetch(
        `https://api.browser-use.com/api/v4${path}`,
        {
          headers: { 'X-Browser-Use-API-Key': this.config.browserUseApiKey! },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok)
        throw new BrowserUseError(
          `Browser Use request failed (HTTP ${response.status}). Check account access and credits.`,
        );
      return response.json();
    });
  }
  private view(id: string): BrowserUseStatus {
    return {
      ...this.workspace.browserUse.get(id),
      configured: this.configured,
      model: this.config.browserUseModel || 'gpt-6-luna',
      profileConfigured: !!this.config.clawdProfile,
      suppliedCdpConfigured: !!this.config.cdpUrl,
    };
  }
  async status(id: string) {
    return this.exclusive(
      id,
      async () => {
        const state = this.workspace.browserUse.get(id);
        if (this.client && state.browser)
          state.browser = publicBrowser(
            browserSchema.parse(
              await this.rest(`/browsers/${state.browser.id}`),
            ),
          );
        if (this.client && state.run) {
          const run = state.run;
          if (!cloudRunFinished(run.status)) {
            const next = await this.provider(() =>
              this.client!.runs.status(run.id),
            );
            run.status = next.status;
            if (cloudRunFinished(run.status)) {
              const done = await this.provider(() =>
                this.client!.runs.get(run.id),
              );
              run.result = done.result;
              run.error = cloudRunError(done.error);
              run.totalCostUsd = done.totalCostUsd;
            }
          }
          if (!run.browser) {
            const list = z
              .object({ items: z.array(browserSchema) })
              .parse(
                await this.rest(
                  `/browsers?agentSessionId=${encodeURIComponent(run.sessionId)}&pageSize=100`,
                ),
              );
            const browser = list.items.find(
              (item) => item.agentSessionId === run.sessionId,
            );
            if (browser) run.browser = publicBrowser(browser);
          }
          if (run.browser)
            run.browser = publicBrowser(
              browserSchema.parse(
                await this.rest(`/browsers/${run.browser.id}`),
              ),
            );
        }
        this.workspace.browserUse.save(id, state);
        return this.view(id);
      },
      true,
    );
  }
  async permission(id: string, enabled: boolean) {
    return this.exclusive(
      id,
      async () => {
        const state = this.workspace.browserUse.get(id);
        state.enabled = enabled;
        this.workspace.browserUse.save(id, state);
        if (!enabled) await this.stopOwned(id);
        return this.view(id);
      },
      true,
    );
  }
  async startBrowser(id: string) {
    return this.exclusive(id, async () => {
      this.requireEnabled(id);
      const state = this.workspace.browserUse.get(id);
      if (state.browser?.status === 'active')
        throw new BrowserUseError(
          'Stop the current cloud browser before starting another.',
          409,
        );
      const browser = await this.provider(() =>
        this.client!.browsers.create({
          profileId: this.config.clawdProfile,
          proxyCountryCode: 'jp',
          timeout: 15,
          allowResizing: true,
          enableRecording: true,
        }),
      );
      state.browser = publicBrowser(browser);
      try {
        this.workspace.browserUse.save(id, state);
      } catch (error) {
        await this.provider(() => this.client!.browsers.stop(browser.id));
        throw error;
      }
      if (this.paused() || !this.workspace.browserUse.get(id).enabled) {
        await this.stopOwned(id);
        throw new BrowserUseError(
          'Browser stopped because permission changed.',
          403,
        );
      }
      return this.view(id);
    });
  }
  async stopBrowser(id: string) {
    return this.exclusive(
      id,
      async () => {
        const state = this.workspace.browserUse.get(id);
        if (this.client && state.browser?.status === 'active') {
          state.browser = publicBrowser(
            await this.provider(() =>
              this.client!.browsers.stop(state.browser!.id),
            ),
          );
          this.workspace.browserUse.save(id, state);
        }
        return this.view(id);
      },
      true,
    );
  }
  async createRun(id: string, input: z.input<typeof cloudTask>) {
    return this.exclusive(id, async () => {
      this.requireEnabled(id);
      const data = cloudTask.parse(input);
      const state = this.workspace.browserUse.get(id);
      if (state.run && !cloudRunFinished(state.run.status))
        throw new BrowserUseError(
          'This Dot already has an active run. Stop it or wait for completion.',
          409,
        );
      if (data.followup && !state.run)
        throw new BrowserUseError(
          'Start a task before sending a follow-up.',
          400,
        );
      let workspaceId = this.config.browserUseWorkspaceId;
      if (this.config.browserUseIsolatedWorkspace) {
        if (data.followup) {
          workspaceId = this.workspace.browserUse.providerWorkspaceId();
          if (!workspaceId || state.run!.workspaceId !== workspaceId)
            throw new BrowserUseError(
              'Start a new Browser Use task to use your private workspace. This older session cannot be continued.',
              403,
            );
        } else {
          workspaceId = await this.isolatedWorkspaceId();
        }
      }
      if (!data.followup && state.run?.browser?.status === 'active') {
        await this.provider(() =>
          this.client!.browsers.stop(state.run!.browser!.id),
        );
      }
      const body: RunCreateBody = {
        task: data.task,
        model: (this.config.browserUseModel || 'gpt-6-luna') as NonNullable<
          RunCreateBody['model']
        >,
        modelParams: { reasoning: { effort: 'high' }, service_tier: 'default' },
        workspaceId,
        judge: {},
        ...(data.followup ? { sessionId: state.run!.sessionId } : {}),
        browserSettings: {
          profileId: this.config.clawdProfile,
          proxyCountryCode: 'us',
          screenWidth: 1440,
          screenHeight: 900,
          record: true,
        },
      };
      const run = await this.provider(() => this.client!.runs.create(body));
      state.run = {
        id: run.id,
        sessionId: run.sessionId,
        workspaceId: run.workspaceId,
        status: run.status,
        ...(data.followup && state.run?.browser?.status === 'active'
          ? { browser: state.run.browser }
          : {}),
      };
      try {
        this.workspace.browserUse.save(id, state);
      } catch (error) {
        await this.provider(() => this.client!.runs.cancel(run.id));
        throw error;
      }
      if (this.paused()) {
        await this.stopOwned(id);
        throw new BrowserUseError(
          'Run cancelled because ChatGPTEE was paused.',
          403,
        );
      }
      return this.view(id);
    });
  }
  private async stopOwned(id: string, standalone = true) {
    const state = this.workspace.browserUse.get(id);
    if (!this.client) return;
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    if (state.run && !cloudRunFinished(state.run.status)) {
      await attempt(async () => {
        const run = await this.provider(() =>
          this.client!.runs.cancel(state.run!.id),
        );
        state.run = {
          ...state.run!,
          status: run.status,
          result: run.result,
          error: cloudRunError(run.error),
          totalCostUsd: run.totalCostUsd,
        };
        this.workspace.browserUse.save(id, state);
      });
    }
    // Discover a run's browser even if the owner cancels before the first poll.
    if (state.run && !state.run.browser) {
      await attempt(async () => {
        const list = z
          .object({ items: z.array(browserSchema) })
          .parse(
            await this.rest(
              `/browsers?agentSessionId=${encodeURIComponent(state.run!.sessionId)}&pageSize=100`,
            ),
          );
        const browser = list.items.find(
          (item) => item.agentSessionId === state.run!.sessionId,
        );
        if (browser) state.run!.browser = publicBrowser(browser);
      });
    }
    if (state.run?.browser?.status === 'active') {
      await attempt(async () => {
        state.run!.browser = publicBrowser(
          await this.provider(() =>
            this.client!.browsers.stop(state.run!.browser!.id),
          ),
        );
        this.workspace.browserUse.save(id, state);
      });
    }
    if (standalone && state.browser?.status === 'active') {
      await attempt(async () => {
        state.browser = publicBrowser(
          await this.provider(() =>
            this.client!.browsers.stop(state.browser!.id),
          ),
        );
      });
    }
    this.workspace.browserUse.save(id, state);
    if (errors.length) throw errors[0];
  }
  async stop(id: string) {
    return this.exclusive(
      id,
      async () => {
        await this.stopOwned(id);
        return this.view(id);
      },
      true,
    );
  }
  async stopRun(id: string) {
    return this.exclusive(
      id,
      async () => {
        await this.stopOwned(id, false);
        return this.view(id);
      },
      true,
    );
  }
  async stopAll() {
    const results = await Promise.allSettled(
      this.workspace.browserUse.ids().map((id) => this.stop(id)),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
  async checkCdp(id: string) {
    this.requireDot(id);
    if (!this.config.cdpUrl)
      throw new BrowserUseError('CDP_URL is not configured.', 503);
    try {
      const url = new URL(this.config.cdpUrl);
      if (!['https:', 'http:'].includes(url.protocol))
        throw new Error('Use an HTTP(S) CDP endpoint.');
      const response = await fetch(new URL('/json/version', url), {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return { connected: false, status: response.status };
      const data = z
        .object({ Browser: z.string(), webSocketDebuggerUrl: z.string() })
        .parse(await response.json());
      return { connected: true, browser: data.Browser };
    } catch {
      return {
        connected: false,
        error: 'The supplied CDP browser is unavailable or expired.',
      };
    }
  }
  async waitForRun(
    id: string,
    runId: string,
    signal: AbortSignal,
    timeoutMs = 75000,
  ): Promise<CloudRun> {
    const deadline = Date.now() + timeoutMs;
    let completed: CloudRun | undefined;
    try {
      for (;;) {
        signal.throwIfAborted();
        this.requireEnabled(id);
        const state = await this.status(id);
        if (state.run?.id !== runId)
          throw new BrowserUseError('The active browser run changed.', 409);
        if (cloudRunFinished(state.run.status)) {
          completed = state.run;
          break;
        }
        if (Date.now() >= deadline)
          throw new BrowserUseError(
            'Browser Use task timed out and was cancelled.',
            504,
          );
        await delay(2000, undefined, { signal });
      }
    } finally {
      // Cancel unfinished paid work and explicitly stop only browsers this app owns.
      if (this.workspace.browserUse.get(id).run?.id === runId)
        await this.stopRun(id);
    }
    return this.workspace.browserUse.get(id).run ?? completed!;
  }
  async waitForRecording(id: string, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await this.status(id);
      const browser = state.browser;
      if (!browser || browser.status !== 'stopped')
        throw new BrowserUseError(
          'Stop the browser before waiting for its recording.',
          400,
        );
      if (browser.recordingUrl || browser.recordingAvailable === false)
        return browser;
      if (Date.now() >= deadline) return browser;
      await delay(2000);
    }
  }
  async withStandaloneBrowser<T>(
    id: string,
    operation: (cdpUrl: string) => Promise<T>,
  ): Promise<T> {
    const state = await this.startBrowser(id);
    try {
      const browser = browserSchema.parse(
        await this.rest(`/browsers/${state.browser!.id}`),
      );
      if (!browser.cdpUrl)
        throw new BrowserUseError(
          'The provider did not return a CDP connection.',
        );
      return await operation(browser.cdpUrl);
    } finally {
      await this.stopBrowser(id);
    }
  }
}
