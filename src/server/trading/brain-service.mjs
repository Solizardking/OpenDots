/* global process, fetch, AbortSignal, console, setInterval, clearInterval, setTimeout */
import { createHash, randomUUID } from 'node:crypto';
import { brain_error, BrainProviders } from './brain-providers.mjs';
import { validMarketMint, selectSolanaPair } from './market-feed.mjs';

const uuid = (value) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function strategy_input(input, now = Date.now()) {
  if (
    typeof input.prompt !== 'string' ||
    input.prompt.trim().length < 10 ||
    input.prompt.length > 2000
  )
    throw brain_error('Describe your strategy in 10–2,000 characters.');
  if (!validMarketMint(input.mint))
    throw brain_error('Choose a valid Solana token mint.');
  const maxSol = Number(input.maxSol),
    minLiquidityUsd = Number(input.minLiquidityUsd),
    confidence = Number(input.confidence);
  if (!Number.isFinite(maxSol) || maxSol < 0.001 || maxSol > 0.1)
    throw brain_error('Choose a trade cap between 0.001 and 0.1 SOL.');
  if (
    !Number.isFinite(minLiquidityUsd) ||
    minLiquidityUsd < 20000 ||
    minLiquidityUsd > 100000000
  )
    throw brain_error('Minimum pool liquidity must be at least $20,000.');
  if (!Number.isFinite(confidence) || confidence < 0.8 || confidence > 0.99)
    throw brain_error('Choose confidence between 0.80 and 0.99.');
  return {
    version: randomUUID(),
    prompt: input.prompt.trim(),
    mint: input.mint,
    maxSol,
    minLiquidityUsd,
    confidence,
    monitorUntil: null,
    savedAt: now,
  };
}

export function learning_state(records, strategy) {
  const outcomes = records
    .filter(
      (record) =>
        record.type === 'paper_outcome' &&
        record.data.strategyVersion === strategy?.version,
    )
    .slice(0, 20);
  const losses = outcomes.filter(
    (record) => record.data.directionalReturnPct < 0,
  ).length;
  // Observable, conservative policy adaptation; never described as model training.
  const penalty =
    outcomes.length >= 3 ? Math.min(0.1, (losses / outcomes.length) * 0.1) : 0;
  return {
    samples: outcomes.length,
    losses,
    threshold: Math.min(
      0.99,
      Math.max(0.8, strategy?.confidence || 0.85) + penalty,
    ),
    method:
      'Observed paper benchmarks over 5 minutes (or 30 when requested); losses raise the review threshold. These exclude fees, slippage and execution.',
    modelTraining: false,
  };
}

export function decision_gate(
  answers,
  market,
  strategy,
  learning,
  now = Date.now(),
) {
  const reasons = [];
  if (
    !market ||
    market.mint !== strategy.mint ||
    now - market.observedAt > 45000
  )
    reasons.push('Fresh price evidence is unavailable.');
  if (
    !market ||
    market.liquidityUsd === null ||
    market.liquidityUsd < strategy.minLiquidityUsd
  )
    reasons.push('Pool liquidity does not meet your minimum.');
  if (!['buy', 'sell'].includes(answers.action.choice))
    reasons.push(`Model action: ${answers.action.choice}.`);
  if (answers.action.confidence < learning.threshold)
    reasons.push('Action confidence is below the adaptive threshold.');
  if (answers.risk.normalized > 0.5 || answers.risk.confidence < 0.6)
    reasons.push('Risk is high or uncertain.');
  if (answers.strategy_match.noul < 0.8)
    reasons.push('Strategy match is uncertain.');
  if (answers.evidence_sufficient.noul < 0.85)
    reasons.push('The model reports insufficient evidence.');
  return {
    gate: reasons.length ? 'wait' : 'wallet_review',
    reasons: reasons.length
      ? reasons
      : [
          'Evidence supports a quote review. Wallet approval is still required.',
        ],
    autoExecute: false,
  };
}

export class BrainService {
  constructor({
    store = null,
    feeds,
    providers = new BrainProviders(),
    fetchImpl = fetch,
    now = Date.now,
    env = process.env,
    allowed = () => true,
  } = {}) {
    this.store = store;
    this.feeds = feeds;
    this.providers = providers;
    this.fetch = fetchImpl;
    this.now = now;
    this.env = env;
    this.allowed = allowed;
    this.busy = new Set();
    this.marketCache = new Map();
    this.minute = -1;
    this.calls = 0;
    this.workerBusy = false;
  }
  config() {
    return {
      ...this.providers.config(),
      persistenceConfigured: !!this.store,
      model: 'jev-latest',
      autoExecute: false,
      monitoring:
        'One decision per minute, at most 60 per Dot per day; stops after one hour unless renewed.',
      feeds: this.feeds?.snapshot() || { sources: [], events: [] },
    };
  }
  require_store() {
    if (!this.store)
      throw brain_error(
        'Trading persistence requires the server database.',
        503,
      );
  }
  async view(wallet) {
    this.require_store();
    const [strategy, records, orders] = await Promise.all([
      this.store.strategy(wallet),
      this.store.recent(wallet),
      this.store.orders(wallet),
    ]);
    return {
      strategy,
      records,
      orders,
      learning: learning_state(records, strategy),
      graph: this.graph(records),
    };
  }
  graph(records) {
    const nodes = new Map(),
      edges = [];
    const add = (id, label, type) =>
      nodes.set(id, { id, label: String(label).slice(0, 100), type });
    for (const record of records.slice(0, 25)) {
      add(
        record.id,
        record.type === 'decision'
          ? `${record.data.answers.action.choice} · ${record.data.gate}`
          : record.type,
        record.type,
      );
      if (record.data.mint) {
        add(record.data.mint, record.data.mint, 'token');
        edges.push({
          from: record.id,
          to: record.data.mint,
          kind: 'observed_token',
        });
      }
      if (record.data.strategyVersion) {
        add(record.data.strategyVersion, 'Strategy version', 'strategy');
        edges.push({
          from: record.id,
          to: record.data.strategyVersion,
          kind: 'evaluated_strategy',
        });
      }
      if (record.data.decisionId) {
        add(record.data.decisionId, 'Prior decision', 'decision');
        edges.push({
          from: record.id,
          to: record.data.decisionId,
          kind: 'measured_outcome',
        });
      }
      for (const memory of record.data.memories || []) {
        add(memory.id, memory.text, 'memory');
        edges.push({ from: record.id, to: memory.id, kind: 'recalled' });
        for (const related of memory.related || []) {
          add(related.id, related.text, 'memory');
          edges.push({ from: memory.id, to: related.id, kind: related.kind });
        }
      }
    }
    return {
      nodes: [...nodes.values()].slice(0, 100),
      edges: edges.slice(0, 150),
    };
  }
  require_access(wallet) {
    if (!this.allowed(wallet))
      throw brain_error(
        'Enable research and memory for this Dot and unpause the workspace.',
        403,
      );
  }
  async save(wallet, input) {
    this.require_access(wallet);
    this.require_store();
    return this.store.save_strategy(wallet, strategy_input(input, this.now()));
  }
  async monitor(wallet, input) {
    this.require_store();
    if (typeof input.enabled !== 'boolean')
      throw brain_error('Choose start or pause monitoring.');
    if (input.enabled) this.require_access(wallet);
    if (
      input.enabled &&
      (!this.providers.config().memoryConfigured ||
        !this.providers.config().decisionsConfigured)
    )
      throw brain_error(
        'Configure Supermemory and TypeSafe before starting monitoring.',
        503,
      );
    const strategy = await this.store.monitoring(
      wallet,
      input.enabled,
      this.now() + 3600000,
    );
    if (!strategy) throw brain_error('Save a strategy first.');
    return { strategy };
  }
  async market(mint, fresh = false) {
    const cached = this.marketCache.get(mint);
    if (!fresh && cached && this.now() - cached.observedAt < 10000)
      return cached;
    let payload;
    try {
      const response = await this.fetch(
        `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`,
        { signal: AbortSignal.timeout(8000), redirect: 'error' },
      );
      if (!response.ok) throw Error();
      payload = await response.json();
    } catch {
      throw brain_error('The token price provider is unavailable.', 502);
    }
    const pair = selectSolanaPair(payload, mint, { pumpOnly: true });
    if (!pair)
      throw brain_error(
        'No priced Pump.fun or PumpSwap pool is available for this mint.',
        422,
      );
    const numeric = (value) =>
      value !== null &&
      value !== undefined &&
      value !== '' &&
      Number.isFinite(Number(value))
        ? Number(value)
        : null;
    const result = {
      mint,
      name: String(pair.baseToken.name || '').slice(0, 64),
      symbol: String(pair.baseToken.symbol || '').slice(0, 20),
      pair: pair.pairAddress,
      venue: pair.dexId,
      priceUsd: Number(pair.priceUsd),
      liquidityUsd: numeric(pair.liquidity?.usd),
      volume24h: numeric(pair.volume?.h24),
      change5m: numeric(pair.priceChange?.m5),
      observedAt: this.now(),
      source: 'DEX Screener REST',
      tokenSafety: 'unverified',
    };
    if (this.env.JUPITER_API_KEY || this.env.JUP_SWAP_V1_API_KEY) {
      try {
        const response = await this.fetch(
          `https://api.jup.ag/tokens/v2/search?query=${mint}`,
          {
            headers: {
              'x-api-key':
                this.env.JUPITER_API_KEY || this.env.JUP_SWAP_V1_API_KEY,
            },
            signal: AbortSignal.timeout(8000),
            redirect: 'error',
          },
        );
        const rows = response.ok ? await response.json() : [];
        const token = Array.isArray(rows)
          ? rows.find((row) => row.id === mint)
          : null;
        if (token)
          result.tokenIntelligence = {
            source: 'Jupiter Tokens V2',
            observedAt: this.now(),
            isVerified: token.isVerified === true,
            organicScore: numeric(token.organicScore),
            holderCount: numeric(token.holderCount),
            mintAuthorityDisabled: token.audit?.mintAuthorityDisabled === true,
            freezeAuthorityDisabled:
              token.audit?.freezeAuthorityDisabled === true,
            topHoldersPercentage: numeric(token.audit?.topHoldersPercentage),
          };
      } catch {
        result.tokenIntelligence = { status: 'unavailable' };
      }
    }
    this.marketCache.delete(mint);
    this.marketCache.set(mint, result);
    while (this.marketCache.size > 100)
      this.marketCache.delete(this.marketCache.keys().next().value);
    return result;
  }
  async evaluate(wallet, input = {}) {
    this.require_access(wallet);
    this.require_store();
    const id = input.requestId || randomUUID();
    if (!uuid(id)) throw brain_error('Invalid decision request.');
    const old = await this.store.get(wallet, id);
    if (old) return old;
    if (this.busy.has(wallet))
      throw brain_error('A decision is already running for this Dot.', 409);
    if (
      input.command !== undefined &&
      (typeof input.command !== 'string' ||
        input.command.length < 3 ||
        input.command.length > 1000)
    )
      throw brain_error('Enter a command in 3–1,000 characters.');
    const minute = Math.floor(this.now() / 60000);
    if (minute !== this.minute) {
      this.minute = minute;
      this.calls = 0;
    }
    if (this.calls >= 10)
      throw brain_error(
        'Decision capacity is busy. Try again next minute.',
        429,
      );
    this.busy.add(wallet);
    this.calls++;
    try {
      const strategy = await this.store.strategy(wallet);
      if (!strategy)
        throw brain_error('Save a natural-language strategy first.');
      if ((await this.store.decision_count(wallet)) >= 60)
        throw brain_error('The daily decision limit has been reached.', 429);
      await this.store.attempt(wallet);
      const records = await this.store.recent(wallet);
      const learning = learning_state(records, strategy);
      let market = null,
        marketError = null;
      try {
        market = await this.market(strategy.mint);
      } catch (error) {
        marketError = error.message;
      }
      const memories = await this.providers.recall(
        wallet,
        `${strategy.prompt}\n${input.command || ''}\nToken ${strategy.mint}`,
      );
      const feed = this.feeds?.snapshot() || { sources: [], events: [] };
      const events = feed.events
        .filter((event) => event.mint === strategy.mint)
        .slice(0, 20);
      const entityA = events.find((event) => event.source === 'clawd') || null,
        entityB = events.find((event) => event.source === 'pump') || null;
      const state = {
        strategy,
        command: input.command || null,
        market,
        marketError,
        observedEvents: events,
        sourceHealth: feed.sources,
        entityA,
        entityB,
        memories,
        learning,
        recentOutcomes: records
          .filter((row) => row.type === 'paper_outcome')
          .slice(0, 10)
          .map((row) => row.data),
        limits: {
          walletApprovalRequired: true,
          autoExecute: false,
          tokenSafetyVerified: false,
        },
        now: this.now(),
      };
      const result = input.command
        ? await this.providers.command(state)
        : await this.providers.decide(state);
      this.require_access(wallet);
      const gate = decision_gate(
        result.answers,
        market,
        strategy,
        learning,
        this.now(),
      );
      let dispatch = null;
      if (input.command) {
        const route = result.answers.route;
        const horizon = result.answers.horizon;
        const confidence = Math.min(
          route.confidence,
          result.answers.horizon_stated.noul >= 0.8 ? horizon.confidence : 1,
        );
        const fn = confidence >= 0.8 ? route.choice : 'unknown';
        dispatch = {
          function: fn,
          confidence,
          horizon:
            result.answers.horizon_stated.noul >= 0.8 &&
            horizon.choice !== 'default'
              ? horizon.choice
              : 'short',
        };
        if (fn !== 'evaluate_market') {
          gate.gate = 'wait';
          gate.reasons = ['Read-only command; no trade is proposed.'];
        }
        if (fn === 'recall_memory') dispatch.result = memories;
        if (fn === 'explain_outcomes') dispatch.result = learning;
        if (fn === 'compare_sources') {
          const link = result.answers.link;
          dispatch.result = {
            entityA,
            entityB,
            score: link.score,
            confidence: link.confidence,
            sameName: result.answers.same_name.noul,
            sameSymbol: result.answers.same_symbol.noul,
            metadataAgrees: result.answers.metadata_agrees.noul,
            relation:
              !entityA || !entityB
                ? 'insufficient_evidence'
                : entityA.mint !== entityB.mint
                  ? 'different_token'
                  : link.score >= 1.5 && link.confidence >= 0.8
                    ? 'same_mint'
                    : 'review',
            rule: 'Only identical Solana mint addresses can link token identities; semantic similarity never merges different mints.',
          };
        }
      }
      if ((await this.store.strategy(wallet))?.version !== strategy.version) {
        gate.gate = 'wait';
        gate.reasons = [
          'Strategy changed during evaluation; request a fresh decision.',
        ];
      }
      const data = {
        ...result,
        ...gate,
        dispatch,
        market,
        mint: strategy.mint,
        marketError,
        strategyVersion: strategy.version,
        learning,
        memories,
        observedEvents: events,
        evaluatedAt: this.now(),
        command: input.command || null,
        observationWindowMs: dispatch?.horizon === 'long' ? 1800000 : 300000,
      };
      this.require_access(wallet);
      return await this.store.record(wallet, 'decision', data, id);
    } finally {
      this.busy.delete(wallet);
    }
  }
  async sync() {
    if (!this.store || !this.providers.config().memoryConfigured) return;
    for (const record of await this.store.pending()) {
      if (!this.allowed(record.wallet)) continue;
      try {
        const result = await this.providers.remember(record.wallet, record);
        await this.store.synced(
          record.id,
          result.status === 'done' ? 'indexed' : 'queued',
        );
      } catch (error) {
        await this.store.synced(record.id, 'failed', error.message);
      }
    }
    for (const record of await this.store.processing()) {
      if (!this.allowed(record.wallet)) continue;
      try {
        const status = await this.providers.memory_status(
          record.wallet,
          record.id,
        );
        await this.store.synced(
          record.id,
          status === 'done'
            ? 'indexed'
            : status === 'failed'
              ? 'failed'
              : 'queued',
          status === 'failed' ? 'Memory indexing failed; retry pending.' : null,
        );
      } catch (error) {
        await this.store.synced(record.id, 'failed', error.message);
      }
    }
  }
  async benchmark() {
    if (!this.store) return;
    for (const record of await this.store.benchmarks()) {
      if (!this.allowed(record.wallet)) continue;
      try {
        const market = await this.market(record.data.mint);
        const entry = record.data.market;
        if (
          !entry ||
          market.pair !== entry.pair ||
          this.now() - record.data.evaluatedAt > 3600000
        )
          continue;
        if (!this.allowed(record.wallet)) continue;
        const priceReturnPct = (market.priceUsd / entry.priceUsd - 1) * 100;
        await this.store.record(
          record.wallet,
          'paper_outcome',
          {
            decisionId: record.id,
            strategyVersion: record.data.strategyVersion,
            mint: market.mint,
            entry,
            exit: market,
            priceReturnPct,
            directionalReturnPct:
              priceReturnPct *
              (record.data.answers.action.choice === 'sell' ? -1 : 1),
            durationMs: market.observedAt - entry.observedAt,
            kind: 'observed_paper_benchmark',
            excludes: ['fees', 'slippage', 'execution'],
            realizedProfit: false,
          },
          createHash('sha256')
            .update(`paper:${record.wallet}:${record.id}`)
            .digest('hex')
            .slice(0, 32)
            .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
        );
      } catch {
        /* Retry missing market evidence within the one-hour window. */
      }
    }
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 15000);
    this.timer.unref();
  }
  async tick() {
    if (this.workerBusy || !this.store) return;
    this.workerBusy = true;
    try {
      await this.benchmark();
      for (const row of await this.store.active()) {
        if (!this.allowed(row.wallet)) {
          await this.store.monitoring(row.wallet, false);
          continue;
        }
        try {
          await this.evaluate(row.wallet);
        } catch (error) {
          await this.store.attempt(row.wallet);
          await this.store.record(row.wallet, 'monitor_error', {
            message: error.status
              ? error.message
              : 'Monitoring temporarily unavailable.',
            mint: row.data.mint,
          });
          if (error.status === 429)
            await this.store.monitoring(row.wallet, false);
        }
      }
      await this.sync();
    } catch {
      console.error('Trading brain worker temporarily unavailable.');
    } finally {
      this.workerBusy = false;
    }
  }
  async stop() {
    clearInterval(this.timer);
    while (this.workerBusy)
      await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
