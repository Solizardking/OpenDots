import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { getRequestListener } from '@hono/node-server';
import { createApp } from '../src/server/app.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace.ts';
import { Platform } from '../src/server/platform.ts';
import { Runner } from '../src/server/runner.ts';
import { BirdeyeService } from '../src/server/birdeye-service.ts';
import { BirdeyeStream } from '../src/server/birdeye-stream.ts';

// Real chat research components, routes, provider parser, alert persistence and
// SSE relay. Upstream/API key/owner identity are isolated fixtures; no trades.
const mint = 'So11111111111111111111111111111111111111112';
const env = { BIRDEYE_API_KEY: 'private-birdeye-fixture-only' };
const unixNow = Math.floor(Date.now() / 1000);
const errors = [],
  upstream = [],
  subscriptions = [],
  browserRequests = [];
let calls = 0;
const service = new BirdeyeService({
  env,
  fetchImpl: async (input, options) => {
    const url = new URL(input);
    upstream.push(url.pathname);
    assert.equal(options.headers['X-API-KEY'], 'private-birdeye-fixture-only');
    assert.equal(options.headers['x-chain'], 'solana');
    const address = url.searchParams.get('address');
    let data;
    if (url.pathname === '/wallet/v2/current-net-worth') {
      assert.equal(url.searchParams.get('limit'), '100');
      data = {
        total_value: '1250',
        items: [
          {
            address: mint,
            symbol: 'SOL',
            amount: '10',
            balance: '10000000000',
            value: '1250',
            price: '125',
          },
        ],
        pagination: { total: 1 },
      };
    } else if (url.pathname === '/wallet/v2/net-worth')
      data = {
        history: [
          { timestamp: unixNow - 86400, net_worth: 1100 },
          { timestamp: unixNow, net_worth: 1250 },
        ],
      };
    else if (url.pathname === '/wallet/v2/pnl/details')
      return Response.json({
        data: {
          summary: {
            unique_tokens: 2,
            counts: { win_rate: 0.5 },
            pnl: {
              realized_profit_usd: '7',
              unrealized_usd: '3',
              total_usd: '10',
            },
          },
          tokens: [
            {
              address: mint,
              symbol: 'SOL',
              pnl: {
                realized_profit_usd: '7',
                unrealized_usd: '3',
                total_usd: '10',
              },
              pricing: { current_price: 125 },
            },
          ],
        },
      });
    else if (url.pathname === '/defi/v3/search')
      data = {
        items: [
          {
            type: 'token',
            result: [
              {
                address: mint,
                symbol: 'SOL',
                name: 'Solana',
                liquidity: 1000000,
              },
            ],
          },
        ],
      };
    else if (url.pathname === '/defi/token_overview')
      data = {
        address,
        name: 'Solana',
        symbol: 'SOL',
        price: 125,
        marketCap: 100000000,
        liquidity: 1000000,
        v24hUSD: 500000,
        holder: 1200,
        global_fees_paid: 55,
      };
    else if (url.pathname === '/defi/token_security')
      data = {
        ownerAddress: null,
        freezeAuthority: null,
        freezeable: false,
        mutableMetadata: false,
        transferFeeEnable: false,
        top10HolderPercent: 0.1,
      };
    else if (url.pathname === '/defi/token_creation_info')
      data = { blockUnixTime: unixNow - 864000 };
    else if (url.pathname === '/token/v1/holder-profile')
      return new Response('fixture provider account secrets', { status: 403 });
    else if (url.pathname === '/defi/v3/ohlcv') {
      const type = url.searchParams.get('type') ?? '15m';
      const step = type === '1H' ? 3600 : type === '1m' ? 60 : 900;
      const end = Number(url.searchParams.get('time_to') ?? unixNow);
      const base = Math.floor(end / step) * step;
      data = {
        items: Array.from({ length: 12 }, (_, i) => ({
          unix_time: base - (12 - i) * step,
          o: 119 + i / 2,
          h: 120 + i / 2,
          l: 118 + i / 2,
          c: 119.5 + i / 2,
          v: 500,
          v_usd: 60000,
        })),
      };
    } else if (url.pathname === '/defi/multi_price')
      data = { [mint]: { value: 125, updateUnixTime: unixNow } };
    else if (url.pathname === '/utils/v1/credits')
      data = {
        remaining: { total: 50000 },
        api: { used: 100 },
        ws: { used: 0 },
      };
    else if (url.pathname === '/defi/v2/tokens/top_traders')
      data = {
        items: [
          {
            address: mint,
            volumeUsd: 2500,
            volumeBuyUSD: 2000,
            volumeSellUSD: 500,
          },
        ],
      };
    else data = { items: [] };
    calls++;
    return Response.json({ success: true, data });
  },
});
class Socket extends EventEmitter {
  readyState = 0;
  timers = [];
  constructor() {
    super();
    this.timers.push(
      setTimeout(() => {
        this.readyState = 1;
        this.emit('open');
      }, 15),
    );
  }
  send(value) {
    const message = JSON.parse(value);
    subscriptions.push(message.type);
    if (message.type === 'SUBSCRIBE_PRICE')
      this.timers.push(
        setTimeout(
          () =>
            this.emit(
              'message',
              JSON.stringify({
                type: 'PRICE_DATA',
                data: {
                  address: mint,
                  unixTime: Math.floor(unixNow / 60) * 60,
                  o: 124,
                  h: 126,
                  l: 123,
                  c: 125,
                  v: 100,
                  vUsd: 12500,
                },
              }),
            ),
          25,
        ),
      );
  }
  ping() {
    this.emit('pong');
  }
  close() {
    this.timers.forEach(clearTimeout);
    this.readyState = 3;
    this.emit('close', 1000);
  }
  terminate() {
    this.close();
  }
}
const stream = new BirdeyeStream({
  env,
  service,
  socketFactory: () => new Socket(),
});
const store = new Store(':memory:');
const workspace = new WorkspaceStore(':memory:', 'birdeye-fixture-owner');
workspace.bindThread(
  'birdeye-fixture',
  workspace.dots()[0].id,
  'Birdeye research',
);
const config = {
  baseUrl: 'https://model.invalid',
  runtimeUrl: '',
  voiceName: 'marin',
  slackUsers: [],
  birdeye: service,
  birdeyeStream: stream,
};
const platform = new Platform(store, workspace, config);
const research = { mode: 'sample', baseUrl: config.baseUrl };
const app = createApp({
  store,
  runner: new Runner(store, research),
  config: research,
  platform,
  ownerToken: 'fixture-owner',
});
const handler = getRequestListener(app.fetch);
const cacheDir = await mkdtemp(join(tmpdir(), 'dots-birdeye-ui-'));
const artifacts = 'artifacts/birdeye-fixtures';
await mkdir(artifacts, { recursive: true });
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
      name: 'birdeye-fixture',
      enforce: 'pre',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url, 'http://fixture').pathname;
          if (path === '/') {
            res.setHeader('Content-Type', 'text/html');
            return res.end(
              '<!doctype html><html class="solana-brand" data-theme="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Birdeye research fixture</title></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/birdeye-entry.tsx"></script></body></html>',
            );
          }
          if (path.startsWith('/api/')) {
            assert.equal(req.headers['x-api-key'], undefined);
            assert.ok(
              !req.url.includes(
                env.BIRDEYE_API_KEY || 'private-birdeye-fixture-only',
              ),
            );
            browserRequests.push(path);
            return handler(req, res, next);
          }
          next();
        });
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() =>
    sessionStorage.setItem('opendots-token', 'fixture-owner'),
  );
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  const panel = page.getByRole('region', {
    name: 'Birdeye research',
    exact: true,
  });
  await panel
    .getByRole('button', { name: 'Run research', exact: true })
    .waitFor();
  await panel.getByLabel('Birdeye wallet address').fill(mint);
  await panel
    .getByRole('button', { name: 'Run research', exact: true })
    .click();
  await panel.getByRole('img', { name: /Wallet equity/ }).waitFor();
  await panel
    .getByRole('img', { name: /Wallet equity/ })
    .scrollIntoViewIfNeeded();
  assert.match(await panel.innerText(), /1,250/);
  assert.match(await panel.innerText(), /50\.00%/);
  assert.ok(
    !(await panel
      .locator('table')
      .first()
      .innerText()
      .then((text) => text.includes('10000000000'))),
  );
  await panel.screenshot({ path: artifacts + '/portfolio-desktop.png' });
  await panel
    .getByRole('button', { name: 'Ask Dot about this', exact: true })
    .click();
  assert.match(
    await page.getByLabel('Message your Dot').inputValue(),
    /Research with Birdeye/,
  );
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await panel
    .getByLabel('Birdeye research workflow')
    .selectOption('investigation');
  await panel.getByLabel('Birdeye token or wallet address').fill(mint);
  await panel
    .getByRole('button', { name: 'Run research', exact: true })
    .click();
  await panel.getByText('Partial coverage', { exact: true }).waitFor();
  assert.match(await panel.innerText(), /denied this endpoint/);
  assert.ok(
    !(await panel
      .innerText()
      .then((text) => text.includes('fixture provider account secrets'))),
  );
  await panel
    .getByRole('button', { name: 'Open in ChatGPT', exact: true })
    .click();
  const share = panel.locator('a[href^="https://chatgpt.com/"]');
  await share.waitFor();
  assert.match(await share.getAttribute('href'), /chatgpt\.com/);
  assert.ok(
    !(await share
      .getAttribute('href')
      .then((href) => href.includes('fixture-owner'))),
  );
  await panel
    .getByRole('button', { name: 'Watch & alerts', exact: true })
    .click();
  await panel.getByLabel('Price in USD', { exact: true }).fill('150');
  await panel.getByRole('button', { name: 'Save alert', exact: true }).click();
  await panel.locator('.birdeye-alert-row').waitFor();
  assert.equal(platform.birdeyeMonitor.list('birdeye-fixture').length, 1);
  await panel
    .getByRole('button', { name: 'Start live feed', exact: true })
    .click();
  await panel.getByText('live', { exact: true }).first().waitFor();
  assert.equal(stream.status().clients, 1);
  await panel
    .getByRole('button', { name: 'Stop live feed', exact: true })
    .click();
  await page.waitForTimeout(150);
  assert.equal(stream.status().clients, 0);
  assert.equal(platform.birdeyeSubscriptions.size, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await panel.screenshot({ path: artifacts + '/investigation-mobile.png' });
  env.BIRDEYE_API_KEY = '';
  await panel
    .getByRole('button', { name: 'Refresh Birdeye status', exact: true })
    .click();
  await panel
    .getByText('Set BIRDEYE_API_KEY on the server to enable Birdeye.', {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await panel
      .getByRole('button', { name: 'Run research', exact: true })
      .isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  const report = {
    verifiedAt: new Date().toISOString(),
    verification: 'isolated-provider-fixtures',
    realComponentsAndRoutes: true,
    desktopAndMobile: true,
    scaledHoldings: true,
    ratioWinRate: true,
    composerDraft: true,
    partialEntitlementVisible: true,
    tokenOnlySharing: true,
    alertPersistence: true,
    authenticatedSse: true,
    disconnectCleanup: true,
    missingKeyVisible: true,
    browserErrors: errors,
    upstreamCalls: calls,
    endpoints: [...new Set(upstream)],
    browserApiRequests: [...new Set(browserRequests)],
    socketSubscriptions: [...new Set(subscriptions)],
    transactionsSigned: 0,
    transactionsBroadcast: 0,
  };
  await writeFile(
    artifacts + '/verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await platform.stop();
  await stream.stop();
  await server.close();
  workspace.close();
  store.close();
  await rm(cacheDir, { recursive: true, force: true });
}
