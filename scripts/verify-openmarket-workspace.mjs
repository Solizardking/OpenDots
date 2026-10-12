import assert from 'node:assert/strict';

// Real authenticated UI and provider responses. No response fixtures or wallet actions.
export async function verifyOpenMarketWorkspace(page, { directory }) {
  const report = {
    checkedAt: new Date().toISOString(),
    passed: false,
    checks: [],
    providerResponses: [],
    limitations: [],
    transactionsSigned: 0,
    transactionsBroadcast: 0,
  };
  const drawer = () =>
    page.getByRole('dialog', { name: 'Solana workspace', exact: true });
  const panel = () =>
    drawer().getByRole('region', { name: 'OpenMarket analytics', exact: true });
  const open = async () => {
    const entry = page
      .locator('.sidebar-bottom')
      .getByRole('button', { name: /OpenMarket/ });
    if (!(await entry.isVisible()))
      await page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .click();
    await entry.click();
    await panel().waitFor();
  };
  const close = () =>
    drawer().getByRole('button', { name: 'Close drawer', exact: true }).click();
  const load = async (name, route, button, required = false) => {
    const waiting = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/markets/openmarket/' + route,
    );
    await panel().getByRole('button', { name: button, exact: true }).click();
    const response = await waiting,
      body = await response.json();
    report.providerResponses.push({
      name,
      status: response.status(),
      source: body.source,
      observedAt: body.observedAt,
      ...(body.error ? { error: body.error } : {}),
    });
    if (required)
      assert.equal(response.status(), 200, name + ': ' + body.error);
    else if (response.status() === 403) {
      assert.match(body.error, /plan or permissions/);
      await panel()
        .getByRole('alert')
        .filter({ hasText: 'plan or permissions' })
        .waitFor();
      report.limitations.push(name + ': OpenMarket plan/permissions');
    } else assert.equal(response.status(), 200, name + ': ' + body.error);
    return { response, body };
  };
  const fits = async (name) => {
    const size = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      drawer: document.querySelector('.solana-workspace')?.clientWidth,
      contents: document.querySelector('.solana-workspace')?.scrollWidth,
    }));
    assert(
      size.document <= size.viewport && size.contents <= size.drawer + 1,
      name + ': ' + JSON.stringify(size),
    );
    report.checks.push(name + ' fits without horizontal overflow');
  };
  await open();
  await panel()
    .getByRole('button', { name: 'Load dataset', exact: true })
    .waitFor();
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.openmarket-panel button')].find(
      (b) => b.textContent === 'Load dataset',
    );
    return b && !b.disabled;
  });
  const candles = await load('BTC candles', 'points', 'Load dataset', true);
  assert.equal(candles.body.source, 'OpenMarket');
  assert(
    candles.body.data.series
      .flatMap((s) => s.points)
      .some((p) => p.Point.close > 0),
  );
  await panel()
    .getByLabel('Interactive price chart', { exact: true })
    .waitFor();
  await panel()
    .getByRole('img', { name: /OHLCV candlestick/ })
    .press('ArrowLeft');
  report.checks.push('Real BTC candles and keyboard inspection');
  await panel()
    .getByLabel('OpenMarket quick example')
    .selectOption('orderbook');
  const book = await load(
    '1000-level orderbook',
    'points',
    'Load dataset',
    true,
  );
  assert.equal(book.body.query.maxDepth, '1000');
  const levels = book.body.data.series
    .flatMap((s) => s.points)
    .flatMap((p) => [p.Point.bids, p.Point.asks])
    .filter(Array.isArray)
    .map((v) => v.length / 2);
  assert.equal(Math.max(...levels), 1000);
  const chart = panel().getByRole('img', { name: /heatmap$/ });
  await chart.waitFor();
  assert((await chart.locator('rect').count()) >= 1000);
  report.checks.push(
    'Real 1000-level orderbook rendered from the exact discovered instrument',
  );
  await fits('Desktop OpenMarket drawer');
  await drawer().screenshot({
    path: directory + '/openmarket-desktop.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await fits('Mobile OpenMarket drawer');
  await drawer().screenshot({
    path: directory + '/openmarket-mobile.png',
    animations: 'disabled',
  });
  await close();
  await open();
  await panel()
    .getByLabel('OpenMarket quick example')
    .selectOption('cross-exchange');
  const volume = await load(
    'Cross-exchange USD volume',
    'points',
    'Load dataset',
  );
  if (volume.response.ok()) {
    assert.equal(
      volume.body.query['transform.groupBy.type'],
      'GROUP_BY_TYPE_SUM',
    );
    await panel()
      .getByRole('img', { name: /Cross-exchange volume/ })
      .waitFor();
  }
  for (const [preset, name] of [
    ['liquidations', 'Hyperliquid liquidations'],
    ['triggers', 'Hyperliquid TP/SL'],
  ]) {
    await panel().getByLabel('OpenMarket quick example').selectOption(preset);
    await load(name, 'points', 'Load dataset');
  }
  await panel()
    .getByRole('button', { name: 'Polymarket', exact: true })
    .click();
  for (const preset of ['politics', 'roi', 'open', 'active']) {
    await panel().getByLabel('Polymarket quick example').selectOption(preset);
    const result = await load(
      'Polymarket ' + preset,
      'leaderboard',
      'Load analytics',
    );
    const params = new URL(result.response.url()).searchParams;
    if (preset === 'politics')
      assert.equal(params.get('primaryCategory'), 'Politics');
    if (preset === 'roi') {
      assert.equal(params.get('sortBy'), 'ROI');
      assert.equal(params.get('limit'), '10');
    }
    if (preset === 'open') assert.equal(params.get('openPositionCount'), '5');
    if (preset === 'active')
      assert.equal(params.get('minTotalTradeCount'), '5000');
  }
  await fits('Mobile Polymarket drawer');
  await drawer().screenshot({
    path: directory + '/polymarket-mobile.png',
    animations: 'disabled',
  });
  await close();
  await page.setViewportSize({ width: 1440, height: 960 });
  report.checks.push(
    'Advanced datasets report actual provider permission states',
    'All four supplied Polymarket examples',
    'Mobile sidebar opens and closes the existing drawer',
  );
  report.passed = true;
  return report;
}
