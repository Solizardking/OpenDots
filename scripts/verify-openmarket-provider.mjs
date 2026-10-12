import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { createOpenMarketService } from '../src/server/openmarket-service.ts';
import { openMarketRoutes } from '../src/server/openmarket-routes.ts';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';

// Live reads through the real adapter. This checks the local server key and
// dataset entitlements; production account access is a separate verification.
const report = {
  checkedAt: new Date().toISOString(),
  mode: 'live-provider-local-adapter',
  checks: [],
  coreDataVerified: false,
};
const server = createServer(
  getRequestListener(
    new Hono().route('/api', openMarketRoutes(createOpenMarketService())).fetch,
  ),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/api/markets/openmarket/`;
async function read(name, route, query = {}, required = false) {
  const response = await fetch(
    origin + route + '?' + new URLSearchParams(query),
    { signal: AbortSignal.timeout(16000) },
  );
  const body = await response.json();
  const entry = {
    name,
    status: response.status,
    available: response.ok,
    ...(body.error ? { message: body.error } : {}),
    ...(body.observedAt ? { observedAt: body.observedAt } : {}),
  };
  report.checks.push(entry);
  if (required || (response.status !== 403 && !response.ok))
    assert.equal(
      response.status,
      200,
      `${name}: ${body.error || 'provider failure'}`,
    );
  return { entry, body };
}
try {
  const status = await read('configuration', 'status', {}, true);
  assert.equal(
    status.body.configured,
    true,
    'Set OPENMARKET_API_KEY in the server .env or environment.',
  );
  const discovery = await read(
    'BTC instruments',
    'markets',
    { type: 'TRADE_SIDE_AGNOSTIC_AGG', coin: 'BTC' },
    true,
  );
  const symbols = discovery.body.data.symbols;
  const instrument =
    symbols?.find((m) => m.exchange === 'BINANCE_FUTURES') || symbols?.[0];
  assert.ok(
    instrument?.exchange && instrument?.rawSymbol,
    'No exact BTC instrument was returned.',
  );
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600,
    minute = Math.floor(Date.now() / 1000 / 60) * 60;
  const range = { interval: 'HOUR', from: hour - 3600, period: 3600 };
  const selected = {
    exchange: instrument.exchange,
    rawSymbol: instrument.rawSymbol,
  };
  const candles = await read(
    'BTC candles',
    'points',
    { type: 'TRADE_SIDE_AGNOSTIC_AGG', ...selected, ...range },
    true,
  );
  const points = candles.body.data.series.flatMap((s) => s.points);
  assert.ok(
    points.some((p) => p.Point?.close > 0),
    'The provider returned no usable price candles.',
  );
  candles.entry.instrument = selected;
  candles.entry.pointCount = points.length;
  report.coreDataVerified = true;
  await read('cross-exchange USD volume', 'points', {
    type: 'TRADE_SIDE_AGNOSTIC_AGG',
    exchange: 'BINANCE_FUTURES,BYBIT,OKEX_SWAP',
    coin: 'BTC',
    ...range,
    'transform.groupBy.type': 'GROUP_BY_TYPE_SUM',
  });
  const buckets = await read('recommended orderbook buckets', 'block-sizes', {
    ...selected,
    type: 'BLOCK_BOOK_SNAPSHOT_AGG',
  });
  const blockSize = buckets.body.data?.blockSizes?.[0];
  if (buckets.entry.available) {
    assert.ok(
      Number.isFinite(blockSize) && blockSize > 0,
      'No recommended price bucket was returned.',
    );
    const orderbook = await read('1000-level orderbook snapshot', 'points', {
      type: 'BLOCK_BOOK_SNAPSHOT_AGG',
      ...selected,
      interval: 'MINUTE',
      from: minute - 60,
      period: 60,
      blockSize,
      maxDepth: 1000,
      'transform.normalize.quote': 'USD',
    });
    if (orderbook.entry.available) {
      const snapshots = orderbook.body.data.series.flatMap((s) => s.points);
      const levels = snapshots
        .flatMap((p) => [p.Point.bids, p.Point.asks])
        .filter(Array.isArray)
        .map((values) => values.length / 2);
      assert.ok(
        levels.some((count) => count > 0),
        'The provider returned no orderbook price levels.',
      );
      orderbook.entry.pointCount = snapshots.length;
      orderbook.entry.maximumReturnedLevelsPerSide = Math.max(...levels);
    }
  }
  await read('liquidations by price', 'points', {
    type: 'HYPERLIQUID_LIQUIDATION_AGG',
    coin: 'BTC',
    ...range,
    maxDepth: 100,
    'transform.normalize.quote': 'USD',
  });
  await read('TP/SL trigger liquidity', 'points', {
    type: 'HYPERLIQUID_TRIGGER_LIQUIDITY_AGG',
    coin: 'BTC',
    interval: 'MINUTE',
    from: minute - 60,
    period: 60,
    maxDepth: 100,
    'transform.normalize.quote': 'USD',
  });
  await read('Polymarket ROI leaderboard', 'leaderboard', {
    winRate: 70,
    minTotalTradeCount: 50,
    sortBy: 'ROI',
    limit: 1,
  });
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  await mkdir('artifacts/openmarket-provider', { recursive: true });
  await writeFile(
    'artifacts/openmarket-provider/provider-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
}
