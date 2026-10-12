import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { TradingService } from '../src/server/trading-service.js';
import { BrainStore } from '../src/server/trading/brain-store.mjs';
import {
  QUESTIONS,
  namespace_for,
  validate_answers,
} from '../src/server/trading/brain-providers.mjs';
import {
  BrainService,
  decision_gate,
  learning_state,
} from '../src/server/trading/brain-service.mjs';
import { normalize_launch } from '../src/server/trading/launch-feed.mjs';
import { tradingRoutes } from '../src/server/trading-routes.js';
const mint = 'So11111111111111111111111111111111111111112';
const strategy = {
  prompt: 'Review liquid momentum, wait if evidence is weak.',
  mint,
  maxSol: 0.01,
  minLiquidityUsd: 20000,
  confidence: 0.85,
};
const env = {
  SUPERMEMORY_API_KEY: 'test-memory-private',
  TYPESAFE_API_KEY: 'test-typesafe-private',
};
const cleanup = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
function payload(action = 'wait') {
  return {
    model: 'jev-test',
    answers: Object.fromEntries(
      Object.entries(QUESTIONS).map(([id, q]) => {
        if (q.type === 'noul') return [id, { type: 'noul', noul: 0.99 }];
        const keys =
          q.type === 'choice'
            ? Object.keys(q.criteria)
            : q.criteria.map((_, i) => String(i));
        const choice = q.type === 'choice' ? action : '0';
        return [
          id,
          {
            type: q.type,
            confidence: 1,
            probabilities: Object.fromEntries(
              keys.map((k) => [k, k === choice ? 1 : 0]),
            ),
            ...(q.type === 'choice' ? { choice } : { score: 0 }),
          },
        ];
      }),
    ),
  };
}
function fixture(
  fetchImpl = vi.fn(async (url) => {
    if (String(url).includes('dexscreener'))
      return Response.json([
        {
          chainId: 'solana',
          dexId: 'pumpswap',
          baseToken: { address: mint, name: 'Test', symbol: 'T' },
          pairAddress: mint,
          priceUsd: '2',
          liquidity: { usd: 100000 },
        },
      ]);
    if (String(url).includes('systemone')) return Response.json(payload());
    if (String(url).includes('/search')) return Response.json({ results: [] });
    return Response.json({ id: 'accepted', status: 'queued' });
  }),
) {
  const store = new Store(':memory:'),
    workspace = new WorkspaceStore(':memory:', 'owner');
  store.updateSettings({
    paused: false,
    memoryAllowed: true,
    researchAllowed: true,
  });
  const dot = workspace.dots()[0];
  workspace.updateDot(dot.id, {
    ...dot,
    memoryAllowed: true,
    researchAllowed: true,
  });
  const service = new TradingService(store, workspace, env, fetchImpl);
  cleanup.push(async () => {
    await service.stop();
    workspace.close();
    store.close();
  });
  return { store, workspace, dot, service, fetchImpl };
}
it('isolates owner and Dot data, namespaces and idempotent request identities', async () => {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  const a = new BrainStore(db, 'alice'),
    b = new BrainStore(db, 'bob');
  const scopeA = '["alice","dot-a"]',
    scopeB = '["bob","dot-b"]',
    id = randomUUID();
  await a.save_strategy(scopeA, strategy);
  await a.record(scopeA, 'decision', { mint }, id);
  expect(await b.strategy(scopeA)).toBeNull();
  expect(await b.get(scopeA, id)).toBeNull();
  await expect(b.record(scopeB, 'decision', { mint }, id)).rejects.toThrow(
    'another scope',
  );
  expect(await a.get(scopeA, id)).toMatchObject({ data: { mint } });
  expect(namespace_for(scopeA)).not.toBe(namespace_for(scopeB));
  expect(namespace_for(scopeA)).not.toContain('alice');
});
it('uses private Supermemory graph recall and typed real provider contracts without exposing keys', async () => {
  const f = fixture();
  await f.service.save(f.dot.id, strategy);
  const id = randomUUID();
  const row = await f.service.evaluate(f.dot.id, { requestId: id });
  expect(row.data).toMatchObject({
    gate: 'wait',
    autoExecute: false,
    answers: { action: { choice: 'wait' } },
  });
  const calls = f.fetchImpl.mock.calls.length;
  expect((await f.service.evaluate(f.dot.id, { requestId: id })).id).toBe(id);
  expect(f.fetchImpl.mock.calls).toHaveLength(calls);
  const search = f.fetchImpl.mock.calls.find(([url]) =>
    String(url).includes('/search'),
  );
  expect(search[1].headers.Authorization).toBe('Bearer test-memory-private');
  expect(JSON.parse(search[1].body)).toMatchObject({
    include: { related: true, documents: true },
  });
  expect(JSON.stringify(f.service.config())).not.toContain(
    'test-memory-private',
  );
});
it('blocks evaluation and cloud sync when workspace or Dot permissions are revoked', async () => {
  const f = fixture();
  await f.service.save(f.dot.id, strategy);
  f.store.updateSettings({
    ...f.workspace.dot(f.dot.id),
    memoryAllowed: false,
  });
  await expect(f.service.evaluate(f.dot.id)).rejects.toThrow(
    'Enable research and memory',
  );
  await f.service.engine.sync();
  expect(f.fetchImpl).not.toHaveBeenCalled();
  await expect(f.service.monitor(f.dot.id, true)).rejects.toThrow(
    'Enable research',
  );
  expect(
    (await f.service.monitor(f.dot.id, false)).strategy.monitorUntil,
  ).toBeNull();
});
it('cancels in-flight private provider calls and does not journal a revoked decision', async () => {
  let searchStarted;
  const reached = new Promise((resolve) => (searchStarted = resolve));
  const f = fixture(
    vi.fn(async (url, init) => {
      if (String(url).includes('/search')) {
        searchStarted();
        return new Promise((resolve, reject) =>
          init.signal.addEventListener(
            'abort',
            () => reject(Error('aborted')),
            { once: true },
          ),
        );
      }
      return Response.json([]);
    }),
  );
  await f.service.save(f.dot.id, strategy);
  const result = f.service.evaluate(f.dot.id);
  await reached;
  f.workspace.updateDot(f.dot.id, {
    ...f.workspace.dot(f.dot.id),
    memoryAllowed: false,
  });
  await expect(result).rejects.toThrow();
  expect(
    (await f.service.view(f.dot.id)).records.filter(
      (r) => r.type === 'decision',
    ),
  ).toHaveLength(0);
});
it('persists the monitoring request and stops it when permissions are disabled', async () => {
  const f = fixture();
  await f.service.save(f.dot.id, strategy);
  expect(
    (await f.service.monitor(f.dot.id, true)).strategy.monitorUntil,
  ).toBeGreaterThan(Date.now());
  f.store.updateSettings({ paused: true });
  await f.service.engine.tick();
  expect((await f.service.view(f.dot.id)).strategy.monitorUntil).toBeNull();
  expect(f.fetchImpl).not.toHaveBeenCalled();
});
it('keeps queued memory distinct from indexed memory until the provider confirms completion', async () => {
  const f = fixture();
  await f.service.save(f.dot.id, strategy);
  await f.service.engine.sync();
  expect((await f.service.view(f.dot.id)).records[0].sync_status).toBe(
    'queued',
  );
  f.store.database.prepare('UPDATE trading_journal SET retry_at=0').run();
  f.fetchImpl.mockImplementation(async () =>
    Response.json({ system: { status: 'done' } }),
  );
  await f.service.engine.sync();
  expect((await f.service.view(f.dot.id)).records[0].sync_status).toBe(
    'indexed',
  );
});
it('rejects stale/replayed/invalid launch events while retaining independently sourced mints', () => {
  const value = {
    type: 'token-launch',
    mint,
    time: new Date().toISOString(),
    name: '<script>execute</script>',
  };
  expect(normalize_launch({ ...value, replay: true }, 'pump')).toBeNull();
  expect(
    normalize_launch(
      { ...value, time: new Date(Date.now() - 180000).toISOString() },
      'pump',
    ),
  ).toBeNull();
  expect(normalize_launch({ ...value, mint: 'invalid' }, 'pump')).toBeNull();
  expect(normalize_launch(value, 'pump')).toMatchObject({
    source: 'pump',
    mint,
  });
  expect(normalize_launch(value, 'clawd').id).not.toBe(
    normalize_launch(value, 'pump').id,
  );
});
it('requires fresh priced liquid evidence and adapts only from actual current-strategy outcomes', () => {
  const s = { ...strategy, version: randomUUID() },
    answers = validate_answers(payload('buy')).answers;
  const market = { mint, observedAt: Date.now(), liquidityUsd: 100000 };
  const learn = learning_state([], s);
  expect(decision_gate(answers, market, s, learn).gate).toBe('wallet_review');
  expect(
    decision_gate(
      answers,
      { ...market, observedAt: Date.now() - 60000 },
      s,
      learn,
    ).gate,
  ).toBe('wait');
  const outcomes = Array.from({ length: 3 }, () => ({
    type: 'paper_outcome',
    data: { strategyVersion: s.version, directionalReturnPct: -1 },
  }));
  expect(learning_state(outcomes, s)).toMatchObject({
    samples: 3,
    threshold: 0.95,
    modelTraining: false,
  });
  expect(
    learning_state(outcomes, { ...s, version: randomUUID() }).samples,
  ).toBe(0);
  expect(() =>
    validate_answers({
      ...payload(),
      answers: {
        ...payload().answers,
        action: {
          type: 'choice',
          choice: 'execute',
          confidence: 1,
          probabilities: { execute: 1 },
        },
      },
    }),
  ).toThrow();
});
it('rejects cross-Dot routes and unknown execution fields before any provider or wallet operation', async () => {
  const f = fixture(),
    pump = { prepareConnected: vi.fn() };
  const app = tradingRoutes(f.service, pump);
  const other = randomUUID();
  expect((await app.request('/dots/' + other + '/trading')).status).toBe(400);
  const response = await app.request(`/dots/${f.dot.id}/trading/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), execute: true }),
  });
  expect(response.status).toBe(400);
  expect(f.fetchImpl).not.toHaveBeenCalled();
  expect(pump.prepareConnected).not.toHaveBeenCalled();
});
it('enforces saved strategy cap, fresh decision and thread ownership before existing wallet review', async () => {
  const f = fixture();
  await f.service.save(f.dot.id, strategy);
  f.workspace.bindThread('thread', f.dot.id, 'Trading');
  const view = await f.service.view(f.dot.id),
    scope = f.service.scope(f.dot.id);
  const journal = new BrainStore(f.store.database, 'owner'),
    id = randomUUID();
  await journal.record(
    scope,
    'decision',
    {
      answers: { action: { choice: 'buy' } },
      gate: 'wallet_review',
      strategyVersion: view.strategy.version,
      evaluatedAt: Date.now(),
      market: { observedAt: Date.now() },
    },
    id,
  );
  const pump = {
    prepareConnected: vi.fn(),
    prepare: vi.fn(),
    decline: vi.fn(),
  };
  await expect(
    f.service.reviewPump(
      f.dot.id,
      id,
      'thread',
      { amount: '0.02', slippageBps: 100 },
      pump,
    ),
  ).rejects.toThrow('cap');
  await expect(
    f.service.reviewPump(
      f.dot.id,
      id,
      'not-owned',
      { amount: '0.005', slippageBps: 100 },
      pump,
    ),
  ).rejects.toThrow();
  expect(pump.prepare).not.toHaveBeenCalled();
  pump.prepare.mockResolvedValue({
    id: 'request',
    estimatedSolDebit: '0.006',
    maximumQuote: '0.005',
  });
  expect(
    await f.service.reviewPump(
      f.dot.id,
      id,
      'thread',
      { amount: '0.005', slippageBps: 100 },
      pump,
    ),
  ).toMatchObject({ id: 'request' });
  expect(pump.prepare.mock.calls[0][1].input).toMatchObject({
    mint,
    side: 'buy',
    amount: '0.005',
  });
});

it('disabled Dot outbox rows cannot starve an enabled Dot’s pending and indexing work', async () => {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  const journal = new BrainStore(db, 'owner', Date.now, () => ['active']);
  for (let i = 0; i < 4; i++)
    await journal.record('disabled', 'strategy', { mint });
  const row = await journal.record('active', 'strategy', { mint });
  expect((await journal.pending()).map((r) => r.id)).toEqual([row.id]);
  db.prepare(
    "UPDATE trading_journal SET sync_status='queued',retry_at=0",
  ).run();
  expect((await journal.processing()).map((r) => r.id)).toEqual([row.id]);
});

it('records later same-pool observations once per eligible decision, without fabricated fills or colliding outcome IDs', async () => {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  let clock = Date.now();
  const journal = new BrainStore(db, 'owner', () => clock);
  const engine = new BrainService({ store: journal, now: () => clock });
  const saved = await engine.save('active', strategy);
  const ids = [
    'aaaaaaaa-1111-4111-8111-111111111111',
    'bbbbbbbb-1111-4111-8111-111111111111',
  ];
  for (const [i, id] of ids.entries())
    await journal.record(
      'active',
      'decision',
      {
        strategyVersion: saved.version,
        mint,
        gate: 'wallet_review',
        evaluatedAt: clock,
        answers: { action: { choice: i ? 'sell' : 'buy' } },
        market: { pair: mint, priceUsd: 1, observedAt: clock },
        observationWindowMs: 300000,
      },
      id,
    );
  await journal.record('active', 'decision', {
    gate: 'wait',
    mint,
    evaluatedAt: clock,
    observationWindowMs: 300000,
  });
  clock += 300001;
  engine.market = async () => ({
    mint,
    pair: mint,
    priceUsd: 2,
    observedAt: clock,
  });
  await engine.benchmark();
  await engine.benchmark();
  const outcomes = (await journal.recent('active')).filter(
    (r) => r.type === 'paper_outcome',
  );
  expect(outcomes).toHaveLength(2);
  expect(new Set(outcomes.map((r) => r.id)).size).toBe(2);
  expect(
    outcomes.map((r) => r.data.directionalReturnPct).sort((a, b) => a - b),
  ).toEqual([-100, 100]);
  for (const outcome of outcomes)
    expect(outcome.data).toMatchObject({
      realizedProfit: false,
      excludes: ['fees', 'slippage', 'execution'],
      kind: 'observed_paper_benchmark',
      durationMs: 300001,
    });
});
