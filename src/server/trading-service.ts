import type { PumpService } from './pump-service.js';
import { brain_error } from './trading/brain-providers.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BrainService } from './trading/brain-service.mjs';
import { BrainStore } from './trading/brain-store.mjs';
import { BrainProviders } from './trading/brain-providers.mjs';
import { LaunchFeed } from './trading/launch-feed.mjs';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';
import type { TradingStrategyInput } from '../shared/trading-types.js';
const sharedFeed = new LaunchFeed();
let feedUsers = 0;

export class TradingService {
  readonly engine: BrainService;
  private started = false;
  private context = new AsyncLocalStorage<string>();
  constructor(
    private store: Store,
    private workspace: WorkspaceStore,
    env = process.env,
    fetchImpl = fetch,
  ) {
    const guardedFetch: typeof fetch = async (url, options) => {
      const scope = this.context.getStore();
      if (!scope || !this.allowed(scope))
        throw Error('Trading permission revoked.');
      const controller = new AbortController();
      const timer = setInterval(() => {
        if (!this.allowed(scope)) controller.abort();
      }, 100);
      timer.unref();
      try {
        return await fetchImpl(url, {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal,
        });
      } finally {
        clearInterval(timer);
      }
    };
    const providers = new BrainProviders({ env, fetchImpl: guardedFetch });
    // Background outbox calls enter the same private scope as interactive calls.
    for (const name of ['recall', 'remember', 'memory_status'] as const) {
      const original = providers[name].bind(providers);
      Object.defineProperty(providers, name, {
        value: (scope: string, arg: string) =>
          this.context.run(scope, () => original(scope, arg)),
      });
    }
    this.engine = new BrainService({
      store: new BrainStore(store.database, workspace.ownerId, Date.now, () =>
        workspace
          .dots()
          .map((dot) => this.scope(dot.id))
          .filter((scope) => this.allowed(scope)),
      ),
      feeds: sharedFeed,
      providers,
      env,
      allowed: (scope) => this.allowed(scope),
      fetchImpl,
    });
  }
  scope(dotId: string) {
    if (!this.workspace.dot(dotId)) throw Error('Dot not found.');
    return JSON.stringify([this.workspace.ownerId, dotId]);
  }
  allowed(scope: string) {
    try {
      const [owner, dotId] = JSON.parse(scope) as [string, string];
      const dot = this.workspace.dot(dotId),
        settings = this.store.settings();
      return (
        owner === this.workspace.ownerId &&
        !!dot &&
        !settings.paused &&
        settings.memoryAllowed &&
        settings.researchAllowed &&
        dot.memoryAllowed &&
        dot.researchAllowed
      );
    } catch {
      return false;
    }
  }
  config() {
    return this.engine.config();
  }
  feeds() {
    return sharedFeed.snapshot();
  }
  view(dotId: string) {
    return this.engine.view(this.scope(dotId));
  }
  save(dotId: string, input: TradingStrategyInput) {
    return this.engine.save(this.scope(dotId), input);
  }
  monitor(dotId: string, enabled: boolean) {
    return this.engine.monitor(this.scope(dotId), { enabled });
  }
  evaluate(dotId: string, input?: { requestId?: string; command?: string }) {
    const scope = this.scope(dotId);
    return this.context.run(scope, () => this.engine.evaluate(scope, input));
  }
  async reviewPump(
    dotId: string,
    decisionId: string,
    threadId: string,
    input: { amount: string; slippageBps: number; address?: string },
    pump: PumpService,
  ) {
    const scope = this.scope(dotId);
    if (!this.allowed(scope))
      throw brain_error('Trading permission is disabled.', 403);
    this.workspace.requireThread(threadId, dotId);
    const view = await this.engine.view(scope),
      decision = view.records.find(
        (row) => row.id === decisionId && row.type === 'decision',
      );
    const data = decision?.data,
      strategy = view.strategy,
      side = data?.answers?.action.choice;
    if (
      !data ||
      !strategy ||
      data.gate !== 'wallet_review' ||
      data.strategyVersion !== strategy.version ||
      !data.evaluatedAt ||
      Date.now() - data.evaluatedAt > 45000 ||
      !data.market ||
      Date.now() - data.market.observedAt > 45000 ||
      !['buy', 'sell'].includes(side ?? '')
    )
      throw brain_error(
        'Request a fresh eligible decision before reviewing a trade.',
        409,
      );
    if (
      !/^\d{1,18}(?:\.\d{1,9})?$/.test(input.amount) ||
      Number(input.amount) <= 0
    )
      throw brain_error('Enter a positive trade amount.');
    if (side === 'buy' && Number(input.amount) > strategy.maxSol)
      throw brain_error('This amount exceeds the saved strategy SOL cap.');
    const action = {
      kind: 'trade' as const,
      input: {
        mint: strategy.mint,
        side: side as 'buy' | 'sell',
        amount: input.amount,
        quoteMint: 'So11111111111111111111111111111111111111112',
        slippageBps: input.slippageBps,
      },
    };
    const review = await (input.address
      ? pump.prepareConnected(threadId, action, input.address)
      : pump.prepare(threadId, action));
    if (
      !this.allowed(scope) ||
      Number(review.estimatedSolDebit) > strategy.maxSol ||
      (side === 'buy' && Number(review.maximumQuote) > strategy.maxSol) ||
      (await this.engine.view(scope)).strategy?.version !== strategy.version
    ) {
      pump.decline(threadId, review.id);
      throw brain_error(
        'The prepared transaction exceeds the strategy cap or its permission changed. No transaction was signed.',
        409,
      );
    }
    return review;
  }
  start() {
    if (
      this.started ||
      !this.config().memoryConfigured ||
      !this.config().decisionsConfigured
    )
      return;
    this.started = true;
    if (feedUsers++ === 0) void sharedFeed.start();
    // Monitoring needs a scope for TypeSafe even when the page is closed.
    const decide = this.engine.evaluate.bind(this.engine);
    this.engine.evaluate = (scope, input) =>
      this.context.run(scope, () => decide(scope, input));
    this.engine.start();
  }
  async stop() {
    await this.engine.stop();
    if (this.started) {
      this.started = false;
      if (--feedUsers === 0) sharedFeed.stop();
    }
  }
}
