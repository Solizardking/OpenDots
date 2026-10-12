import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createOpenMarketService } from '../src/server/openmarket-service.ts';
import { openMarketRoutes } from '../src/server/openmarket-routes.ts';

const root = '/api/markets/openmarket/';
const time = 2000000000;
const range = '&interval=HOUR&from=1900000&period=3600';
const json = (data) => Response.json(data);
async function fixture(_context, fetchImpl) {
  const service = createOpenMarketService({
    env: { OPENMARKET_API_KEY: 'private-fixture-only' },
    now: () => time,
    fetchImpl,
  });
  const app = new Hono().route('/api', openMarketRoutes(service));
  return async (route) => {
    const response = await app.request('http://localhost' + root + route);
    return { status: response.status, body: await response.json() };
  };
}

test('cross-exchange volume translates comma venues to repeated upstream parameters and shares their cache', async (t) => {
  let requests = 0;
  const call = await fixture(t, async (url, options) => {
    requests++;
    const parsed = new URL(url);
    assert.deepEqual(parsed.searchParams.getAll('exchange'), [
      'BINANCE_FUTURES',
      'BYBIT',
      'OKEX_SWAP',
    ]);
    assert.equal(parsed.searchParams.get('transform.normalize.quote'), 'USD');
    assert.equal(options.headers['X-OpenMarket-Key'], 'private-fixture-only');
    return json({
      series: [
        {
          id: {
            type: 'TRADE_SIDE_AGNOSTIC_AGG',
            coin: 'BTC',
            interval: 'HOUR',
          },
          points: [
            { Point: { volume: 42, open: 0, timestamp: { s: 1900000 } } },
          ],
        },
      ],
    });
  });
  const base =
    'points?type=TRADE_SIDE_AGNOSTIC_AGG&coin=BTC&transform.groupBy.type=GROUP_BY_TYPE_SUM' +
    range;
  const first = await call(base + '&exchange=BINANCE_FUTURES,BYBIT,OKEX_SWAP');
  assert.equal(first.status, 200);
  assert.equal(first.body.query.exchange, 'BINANCE_FUTURES,BYBIT,OKEX_SWAP');
  assert.equal(first.body.data.series[0].points[0].Point.volume, 42);
  assert.equal(
    (
      await call(
        base + '&exchange=OKEX_SWAP&exchange=BINANCE_FUTURES&exchange=BYBIT',
      )
    ).status,
    200,
  );
  assert.equal(requests, 1);
  assert.ok(!JSON.stringify(first.body).includes('private-fixture-only'));
});

test('volume aggregation rejects ambiguous, duplicate or excessive venues before calling the provider', async (t) => {
  let requests = 0;
  const call = await fixture(t, async () => {
    requests++;
    return json({ series: [] });
  });
  const base =
    'points?type=TRADE_SIDE_AGNOSTIC_AGG&coin=BTC&transform.groupBy.type=GROUP_BY_TYPE_SUM' +
    range;
  for (const suffix of [
    '&exchange=BYBIT',
    '&exchange=BYBIT,BYBIT',
    '&exchange=A,B,C,D,E,F',
    '&exchange=A,,B',
    '&exchange=A,B&rawSymbol=BTCUSDT',
    '&exchange=A,B&type=OPEN_INTEREST_AGG',
  ])
    assert.equal((await call(base + suffix)).status, 400);
  assert.equal(
    (
      await call(
        base.replace('TRADE_SIDE_AGNOSTIC_AGG', 'OPEN_INTEREST_AGG') +
          '&exchange=A,B',
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        base.replace('&transform.groupBy.type=GROUP_BY_TYPE_SUM', '') +
          '&exchange=A&exchange=B&rawSymbol=BTCUSDT',
      )
    ).status,
    400,
  );
  assert.equal(requests, 0);
});

test('heatmaps retain 1000 price levels and USD normalization within bounded snapshot ranges', async (t) => {
  let requests = 0;
  const call = await fixture(t, async (url) => {
    requests++;
    const query = new URL(url).searchParams;
    assert.equal(query.get('maxDepth'), '1000');
    assert.equal(query.get('blockSize'), '5');
    assert.equal(query.get('transform.normalize.quote'), 'USD');
    return json({
      series: [
        {
          id: {
            type: 'BLOCK_BOOK_SNAPSHOT_AGG',
            exchange: 'BINANCE_FUTURES',
            rawSymbol: 'BTCUSDT',
          },
          points: [],
        },
      ],
    });
  });
  const path =
    'points?type=BLOCK_BOOK_SNAPSHOT_AGG&exchange=BINANCE_FUTURES&rawSymbol=BTCUSDT&maxDepth=1000&blockSize=5&transform.normalize.quote=USD' +
    range;
  assert.equal((await call(path)).status, 200);
  for (const invalid of [
    path.replace('maxDepth=1000', 'maxDepth=1001'),
    path.replace('period=3600', 'period=75600'),
  ])
    assert.equal((await call(invalid)).status, 400);
  assert.equal(requests, 1);
});

test('the four supplied Polymarket leaderboards preserve filter and sorting semantics', async (t) => {
  const queries = [
    {
      winRate: '90',
      maxTotalTradeCount: '20',
      primaryCategory: 'Politics',
      sortBy: 'REALIZED_PNL',
    },
    { winRate: '70', minTotalTradeCount: '50', sortBy: 'ROI', limit: '10' },
    {
      openPositionCount: '5',
      sortBy: 'TOTAL_SIZE',
      sortDirection: 'SORT_DIRECTION_DESC',
    },
    {
      minTotalTradeCount: '5000',
      winRate: '55',
      sortBy: 'TOTAL_POSITION_COUNT',
    },
  ];
  let index = 0;
  const call = await fixture(t, async (url) => {
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/v1/polymarket/analytics/leaderboard');
    assert.deepEqual(Object.fromEntries(parsed.searchParams), queries[index++]);
    return json({ traderProfiles: [] });
  });
  for (const query of queries)
    assert.equal(
      (await call('leaderboard?' + new URLSearchParams(query))).status,
      200,
    );
  assert.equal(index, 4);
});

test('invalid leaderboard filters, sort scopes and pagination never reach the provider', async (t) => {
  let requests = 0;
  const call = await fixture(t, async () => {
    requests++;
    return json({});
  });
  const condition = '0x' + '1'.repeat(64);
  for (const query of [
    'winRate=101',
    'winRate=-1',
    'sortBy=AVG_PRICE',
    'minTotalTradeCount=50&maxTotalTradeCount=20',
    'limit=101',
    'limit=100&offset=9950',
    'winRate=55&winRate=90',
    'apiKey=leak',
    `conditionId=${condition}&sortBy=ROI`,
    `conditionId=${condition}&primaryCategory=Politics`,
  ])
    assert.equal((await call('leaderboard?' + query)).status, 400);
  assert.equal(
    (
      await call(
        'trader-profile?userWallet=0x' + '1'.repeat(40) + '&winRate=90',
      )
    ).status,
    400,
  );
  assert.equal(requests, 0);
});

test('wrong aggregation coins and malformed point wrappers cannot be displayed as valid data', async (t) => {
  let payload = {
    series: [
      { id: { type: 'TRADE_SIDE_AGNOSTIC_AGG', coin: 'ETH' }, points: [] },
    ],
  };
  const call = await fixture(t, async () => json(payload));
  const base =
    'points?type=TRADE_SIDE_AGNOSTIC_AGG&coin=BTC&exchange=A,B&transform.groupBy.type=GROUP_BY_TYPE_SUM' +
    range;
  assert.equal((await call(base)).status, 502);
  payload = {
    series: [
      { id: { type: 'TRADE_SIDE_AGNOSTIC_AGG', coin: 'BTC' }, points: [null] },
    ],
  };
  assert.equal(
    (await call(base.replace('from=1900000', 'from=1903600'))).status,
    502,
  );
});

test('only points inside the requested range are shown', async (t) => {
  const call = await fixture(t, async () =>
    json({
      series: [
        {
          id: { type: 'TRADE_SIDE_AGNOSTIC_AGG', coin: 'BTC' },
          points: [1899999, 1900000, 1903599, 1903600].map((s) => ({
            Point: { timestamp: { s }, volume: 1 },
          })),
        },
      ],
    }),
  );
  const result = await call(
    'points?type=TRADE_SIDE_AGNOSTIC_AGG&coin=BTC&exchange=A,B&transform.groupBy.type=GROUP_BY_TYPE_SUM' +
      range,
  );
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.data.series[0].points.map((p) => p.Point.timestamp.s),
    [1900000, 1903599],
  );
});

test('provider plan refusals, invalid keys and quota errors are sanitized without retries', async (t) => {
  for (const status of [403, 401, 429]) {
    let requests = 0;
    const denied = await fixture(t, async () => {
      requests++;
      return new Response('private-fixture-only provider details', { status });
    });
    const result = await denied('leaderboard?limit=1');
    assert.equal(result.status, status === 401 ? 502 : status);
    assert.ok(!JSON.stringify(result.body).includes('private-fixture-only'));
    assert.equal(result.body.data, undefined);
    assert.equal(requests, 1);
  }
});
