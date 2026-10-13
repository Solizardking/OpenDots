import { expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { TradingService } from '../src/server/trading-service.js';
import { namespace_for } from '../src/server/trading/brain-providers.mjs';

it('automatically syncs a private memory outbox with Supermemory alone and keeps decision providers idle', async () => {
  vi.useFakeTimers();
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'memory-only-owner');
  store.updateSettings({
    paused: false,
    memoryAllowed: true,
    researchAllowed: true,
  });
  const dot = workspace.dots()[0];
  const scope = JSON.stringify([workspace.ownerId, dot.id]);
  const requests: {
    url: string;
    method?: string;
    body?: Record<string, unknown>;
  }[] = [];
  const fetchImpl: typeof fetch = async (url, options) => {
    const target = String(url);
    expect(
      target.startsWith(
        `https://api.supermemory.ai/ns/${namespace_for(scope)}/document`,
      ),
    ).toBe(true);
    expect(options?.headers).toEqual({
      Authorization: 'Bearer private-memory-test',
      ...(options?.method === 'POST'
        ? { 'Content-Type': 'application/json' }
        : {}),
    });
    const body =
      typeof options?.body === 'string' ? JSON.parse(options.body) : undefined;
    requests.push({ url: target, method: options?.method, body });
    return options?.method === 'POST'
      ? Response.json({ id: body.id, status: 'queued' })
      : Response.json({ system: { status: 'done', dreamingStatus: 'done' } });
  };
  const trading = new TradingService(
    store,
    workspace,
    { SUPERMEMORY_API_KEY: 'private-memory-test' },
    fetchImpl,
  );
  try {
    expect(trading.config().decisionsConfigured).toBe(false);
    await trading.save(dot.id, {
      prompt: 'Wait for verified liquidity before reviewing a trade.',
      mint: 'So11111111111111111111111111111111111111112',
      maxSol: 0.01,
      minLiquidityUsd: 20000,
      confidence: 0.85,
    });
    trading.start();
    trading.start();
    await vi.advanceTimersByTimeAsync(15000);
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect((await trading.view(dot.id)).records[0].sync_status).toBe('queued');
    await vi.advanceTimersByTimeAsync(300000);
    expect(requests).toHaveLength(2);
    expect((await trading.view(dot.id)).records[0].sync_status).toBe('indexed');
    expect(requests[0].body?.metadata).toMatchObject({
      app: 'opendots-trading',
      type: 'strategy',
    });
  } finally {
    await trading.stop();
    workspace.close();
    store.close();
    vi.useRealTimers();
  }
});
