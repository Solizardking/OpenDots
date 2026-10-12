import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { createOpenMarketService } from '../src/server/openmarket-service.ts';
import { openMarketRoutes } from '../src/server/openmarket-routes.ts';
import { Hono } from 'hono';
import { getRequestListener } from '@hono/node-server';

// Real components and adapter, isolated provider/session fixtures. No inference,
// live API key, real wallet, order or transaction is used by this verifier.
const env = { OPENMARKET_API_KEY: 'private-openmarket-fixture-only' },
  queries = [],
  errors = [];
let denyPolymarket = false,
  sessionReads = 0;
const service = createOpenMarketService({
  env,
  fetchImpl: async (url, options) => {
    const parsed = new URL(url),
      params = parsed.searchParams,
      type = params.get('type');
    assert.equal(options.headers['X-OpenMarket-Key'], env.OPENMARKET_API_KEY);
    queries.push(parsed);
    if (/OPTION_SUMMARY/.test(type || ''))
      return new Response('{}', { status: 403 });
    if (parsed.pathname.endsWith('/markets')) {
      const coin = params.get('coin');
      return Response.json({
        symbols: [
          {
            exchange: 'BINANCE_FUTURES',
            rawSymbol: coin + 'USDT',
            normalizedSymbol: coin + '-USDT',
            coin,
            category: 'PERPETUAL',
          },
        ],
      });
    }
    if (parsed.pathname.endsWith('/block-sizes'))
      return Response.json({ blockSizes: [5] });
    if (parsed.pathname.includes('polymarket')) {
      if (denyPolymarket) return new Response('{}', { status: 403 });
      if (parsed.pathname.endsWith('/trader-profile'))
        return Response.json({
          traderProfile: {
            wallet_address: params.get('userWallet'),
            total_realized_pnl: 10,
          },
        });
      return Response.json({
        traderProfiles: Array.from(
          {
            length:
              params.get('offset') === '10'
                ? 1
                : Number(params.get('limit') || 20),
          },
          (_, i) => ({
            wallet_address: '0x' + String(i + 1).padStart(40, '0'),
            total_realized_pnl: 10,
            total_roi: 2,
          }),
        ),
      });
    }
    const stamp = { s: Number(params.get('from')) };
    const point = params.has('transform.groupBy.type')
      ? { timestamp: stamp, volume: 42000, open: 0, high: 0, low: 0, close: 0 }
      : type === 'BLOCK_BOOK_SNAPSHOT_AGG'
        ? {
            timestamp: stamp,
            bids: Array.from({ length: 1000 }, (_, i) => [
              83000 - i * 5,
              i + 1,
            ]).flat(),
          }
        : type.includes('HYPERLIQUID')
          ? { timestamp: stamp, levels: [99, 1, 100, 10, 101, 3] }
          : { timestamp: stamp, fundingRate: 0.001 };
    return Response.json({
      series: [
        {
          id: {
            type,
            interval: params.get('interval'),
            ...(params.has('transform.groupBy.type')
              ? {}
              : { exchange: params.get('exchange') || undefined }),
            rawSymbol: params.get('rawSymbol') || undefined,
            coin: params.get('coin') || undefined,
          },
          points: [{ Point: point }],
        },
      ],
    });
  },
});
const handler = getRequestListener(
  new Hono().route('/api', openMarketRoutes(service)).fetch,
);
const cacheDir = await mkdtemp(join(tmpdir(), 'clawd-openmarket-data-ui-'));
const send = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};
const server = await createServer({
  configFile: false,
  root: resolve('.'),
  cacheDir,
  envDir: join(cacheDir, 'no-env'),
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: {
    noDiscovery: true,
    include: [
      'react',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ],
  },
  plugins: [
    {
      name: 'openmarket-data-fixture',
      enforce: 'pre',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url, 'http://fixture').pathname;
          if (path === '/') {
            res.setHeader('Content-Type', 'text/html');
            return res.end(
              '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenMarket panels fixture</title><style>html,body,#root{margin:0;min-height:100%;background:#111827;color:#e5eef7;font-family:system-ui}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/openmarket-data-entry.tsx"></script></body></html>',
            );
          }
          if (!path.startsWith('/api/')) return next();
          assert.equal(req.headers['x-openmarket-key'], undefined);
          assert.ok(!req.url.includes('private-openmarket-fixture-only'));
          if (
            !req.headers.cookie?.includes('openmarket-fixture-session=present')
          )
            return send(res, 401, {
              error: 'The signed-in app session is required.',
            });
          sessionReads++;
          if (path === '/api/backpack/public/markets')
            return send(res, 200, {
              data: [{ symbol: 'BTC_USDC' }],
              observedAt: Date.now(),
            });
          if (path.startsWith('/api/markets/openmarket/'))
            return handler(req, res, next);
          send(res, 404, { error: 'Unknown fixture route.' });
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const artifacts = 'artifacts/openmarket-fixtures';
await mkdir(artifacts, { recursive: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page
    .context()
    .addCookies([
      {
        name: 'openmarket-fixture-session',
        value: 'present',
        url: origin,
        httpOnly: true,
      },
    ]);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  await page.getByText('OpenMarket session ready', { exact: true }).waitFor();
  const crypto = page.locator('.om-analytics'),
    poly = page.locator('.om-content');
  const load = async () => {
    await crypto
      .getByRole('button', { name: 'Load dataset', exact: true })
      .click();
  };
  await crypto
    .getByLabel('OpenMarket quick example')
    .selectOption('cross-exchange');
  await load();
  await crypto
    .getByRole('img', {
      name: 'BTC · Cross-exchange volume (USD) volume chart',
      exact: true,
    })
    .waitFor();
  assert.deepEqual(queries.at(-1).searchParams.getAll('exchange'), [
    'BINANCE_FUTURES',
    'BYBIT',
    'OKEX_SWAP',
  ]);
  assert.equal(
    queries.at(-1).searchParams.get('transform.normalize.quote'),
    'USD',
  );
  assert.equal(await crypto.getByLabel('Interactive price chart').count(), 0);
  await crypto.getByLabel('OpenMarket quick example').selectOption('orderbook');
  await load();
  await crypto.getByRole('img', { name: /heatmap$/ }).waitFor();
  assert.equal(queries.at(-1).searchParams.get('maxDepth'), '1000');
  assert.equal(queries.at(-1).searchParams.get('blockSize'), '5');
  assert.equal(
    await crypto
      .getByRole('img', { name: /heatmap$/ })
      .locator('rect')
      .count(),
    1000,
  );
  await crypto.screenshot({ path: artifacts + '/orderbook-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await crypto.screenshot({ path: artifacts + '/orderbook-mobile.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await crypto.getByLabel('Heatmap resolution').selectOption('HD');
  await load();
  await crypto.getByRole('img', { name: /heatmap$/ }).waitFor();
  assert.equal(queries.at(-1).searchParams.get('blockSize'), '25');
  for (const [preset, type, interval] of [
    ['liquidations', 'HYPERLIQUID_LIQUIDATION_AGG', 'HOUR'],
    ['triggers', 'HYPERLIQUID_TRIGGER_LIQUIDITY_AGG', 'MINUTE'],
  ]) {
    await crypto.getByLabel('OpenMarket quick example').selectOption(preset);
    await load();
    await crypto.getByRole('img', { name: /heatmap$/ }).waitFor();
    assert.equal(queries.at(-1).searchParams.get('type'), type);
    assert.equal(queries.at(-1).searchParams.get('interval'), interval);
    assert.equal(
      queries.at(-1).searchParams.get('transform.normalize.quote'),
      'USD',
    );
  }
  env.OPENMARKET_API_KEY = '';
  await crypto
    .getByRole('button', { name: 'Refresh instruments', exact: true })
    .click();
  await crypto
    .getByRole('status')
    .filter({ hasText: 'OpenMarket data is not configured yet.' })
    .waitFor();
  assert.equal(
    await crypto
      .getByRole('button', { name: 'Load dataset', exact: true })
      .isDisabled(),
    true,
  );
  env.OPENMARKET_API_KEY = 'private-openmarket-fixture-only';
  await crypto
    .getByRole('button', { name: 'Refresh instruments', exact: true })
    .click();
  await crypto
    .getByLabel('OpenMarket dataset', { exact: true })
    .selectOption('IMPLIED_VOLATILITY_OPTION_SUMMARY_AGG');
  await crypto
    .getByRole('alert')
    .filter({ hasText: 'plan or permissions' })
    .waitFor();
  for (const [preset, expected] of [
    [
      'politics',
      {
        winRate: '90',
        maxTotalTradeCount: '20',
        primaryCategory: 'Politics',
        sortBy: 'REALIZED_PNL',
      },
    ],
    ['open', { openPositionCount: '5', sortBy: 'TOTAL_SIZE' }],
    [
      'active',
      {
        minTotalTradeCount: '5000',
        winRate: '55',
        sortBy: 'TOTAL_POSITION_COUNT',
      },
    ],
    [
      'roi',
      { winRate: '70', minTotalTradeCount: '50', sortBy: 'ROI', limit: '10' },
    ],
  ]) {
    await poly.getByLabel('Polymarket quick example').selectOption(preset);
    await poly
      .getByRole('button', { name: 'Load analytics', exact: true })
      .click();
    await poly.getByText('total realized pnl', { exact: true }).waitFor();
    for (const [key, value] of Object.entries(expected))
      assert.equal(queries.at(-1).searchParams.get(key), value);
  }
  await poly.screenshot({ path: artifacts + '/polymarket-desktop.png' });
  await poly.getByRole('button', { name: 'Next', exact: true }).click();
  await poly.getByText('Offset 10', { exact: true }).waitFor();
  assert.equal(
    await poly.getByRole('button', { name: 'Next', exact: true }).isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await poly.screenshot({ path: artifacts + '/polymarket-mobile.png' });
  await poly
    .getByLabel('Polymarket analytics view')
    .selectOption('trader-profile');
  const wallet = '0x' + '1'.repeat(40);
  await poly.getByLabel('Polymarket wallet').fill(wallet);
  await poly
    .getByRole('button', { name: 'Load analytics', exact: true })
    .click();
  await poly.getByText(wallet, { exact: true }).waitFor();
  assert.equal(queries.at(-1).searchParams.get('userWallet'), wallet);
  denyPolymarket = true;
  await poly.getByLabel('Polymarket wallet').fill('0x' + '2'.repeat(40));
  await poly
    .getByRole('button', { name: 'Load analytics', exact: true })
    .click();
  await poly
    .getByRole('alert')
    .filter({ hasText: 'plan or permissions' })
    .waitFor();
  assert.equal(
    await poly.getByText('total realized pnl', { exact: true }).count(),
    0,
  );
  assert.ok(sessionReads > 0);
  assert.ok(
    !(await page.locator('body').innerText()).includes(
      'private-openmarket-fixture-only',
    ),
  );
  assert.deepEqual(errors, []);
  const report = {
    mode: 'isolated-provider-and-app-session-fixtures',
    checks: [
      'OpenMarket same-origin API cookie',
      'analytics session cookie',
      'cross-exchange USD volume without price candles',
      '1000 rendered orderbook levels',
      'recommended 4K and HD buckets',
      'USD liquidation and minute TP/SL presets',
      'unconfigured state and recovery',
      'advanced permissions fallback',
      'four Polymarket leaderboard presets',
      '10-row pagination and last page',
      'wallet trading profile',
      'Polymarket permission fallback',
      'desktop and 390px mobile without overflow',
      'no provider key in browser',
    ],
    browserErrors: errors,
    realOrders: 0,
    mainnetSubmissions: 0,
  };
  await writeFile(
    artifacts + '/ui-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
