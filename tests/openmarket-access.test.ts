import { expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { createOpenMarketService } from '../src/server/openmarket-service.js';
import { openMarketTools } from '../src/server/openmarket-tools.js';

it('keeps OpenMarket behind the existing owner and browser boundary', async () => {
  const store = new Store(':memory:');
  const config = {
    mode: 'sample' as const,
    baseUrl: 'https://provider.invalid',
  };
  const app = createApp({
    store,
    config,
    runner: new Runner(store, config),
    ownerToken: 'fixture-owner',
    origin: 'https://app.example',
  });
  try {
    expect(
      (await app.request('https://app.example/api/markets/openmarket/status'))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request('https://app.example/api/markets/openmarket/status', {
          headers: {
            Authorization: 'Bearer fixture-owner',
            Origin: 'https://other.example',
          },
        })
      ).status,
    ).toBe(403);
    const status = await app.request(
      'https://app.example/api/markets/openmarket/status',
      {
        headers: {
          Authorization: 'Bearer fixture-owner',
          Origin: 'https://app.example',
        },
      },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ source: 'OpenMarket' });
    expect(
      (
        await app.request('https://app.example/api/markets/openmarket/points', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer fixture-owner',
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(405);
  } finally {
    store.close();
  }
});

it('stops an aborted Dot tool before requesting provider data', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const service = createOpenMarketService({
    env: { OPENMARKET_API_KEY: 'fixture' },
    fetchImpl,
  });
  const controller = new AbortController();
  controller.abort();
  const tool = openMarketTools(() => {}, controller.signal, service)[0];
  await expect(
    tool.execute!({ route: 'leaderboard', query: { limit: '1' } }),
  ).rejects.toThrow('cancelled');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('sanitizes provider failures for the read-only Dot tool', async () => {
  const service = createOpenMarketService({
    env: { OPENMARKET_API_KEY: 'fixture' },
    fetchImpl: vi.fn(
      async () => new Response('private provider credentials', { status: 403 }),
    ),
  });
  const tool = openMarketTools(() => {})[0];
  const scoped = openMarketTools(() => {}, undefined, service)[0];
  expect(tool.name).toBe('openmarket_data');
  expect(
    await scoped.execute!({ route: 'leaderboard', query: { limit: '1' } }),
  ).toMatchObject({
    source: 'OpenMarket',
    status: 403,
    error: expect.stringContaining('permissions'),
  });
});
