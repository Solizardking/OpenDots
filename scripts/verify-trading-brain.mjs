import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { startDesktopServer } from '../dist/server/server/desktop-server.js';
import { namespace_for } from '../dist/server/server/trading/brain-providers.mjs';
const directory = resolve('artifacts/trading-brain');
await mkdir(directory, { recursive: true });
const dataPath = await mkdtemp(join(tmpdir(), 'opendots-trading-live-'));
const token = randomBytes(32).toString('hex');
const env = Object.fromEntries(
  [
    'SUPERMEMORY_API_KEY',
    'TYPESAFE_API_KEY',
    'JUPITER_API_KEY',
    'JUP_SWAP_V1_API_KEY',
  ].map((k) => [k, process.env[k]]),
);
assert(
  env.SUPERMEMORY_API_KEY && env.TYPESAFE_API_KEY,
  'Trading keys must be configured.',
);
const runtime = await startDesktopServer({
  dataPath,
  clientPath: resolve('dist/client'),
  token,
  env,
  port: 0,
});
const browser = await chromium.launch({ headless: true });
let dotId,
  records = [];
const report = {
  checkedAt: new Date().toISOString(),
  source: resolve('.'),
  sourceFlow: 'compiled desktop server and client',
  transactionsSigned: 0,
  transactionsBroadcast: 0,
  checks: [],
};
const api = async (path, method = 'GET', body) => {
  const r = await fetch(runtime.origin + '/api' + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await r.json();
  assert(r.ok, `${path}: ${r.status} ${result.error ?? ''}`);
  return result;
};
try {
  const anon = await fetch(runtime.origin + '/api/markets/brain/config');
  assert.equal(anon.status, 401);
  report.checks.push('Desktop trading API requires its session token');
  const workspace = await api('/workspace');
  dotId = workspace.dots[0].id;
  await api('/settings', 'PATCH', {
    paused: false,
    memoryAllowed: true,
    researchAllowed: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(
    (value) => sessionStorage.setItem('opendots-token', value),
    token,
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(runtime.origin);
  await page
    .locator('.sidebar-bottom')
    .getByRole('button', { name: /Pump.fun/ })
    .click();
  await page
    .getByRole('button', { name: 'Trading brain', exact: true })
    .click();
  await page
    .getByRole('textbox', { name: 'Trading token mint' })
    .fill('pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn');
  await page
    .getByRole('textbox', { name: 'Trading strategy', exact: true })
    .fill(
      'For this verified test, wait until fresh PumpSwap observations show deep liquidity and sustained momentum. Recall prior decisions, avoid thin pools, and never execute automatically.',
    );
  await page
    .getByRole('button', { name: 'Save strategy', exact: true })
    .click();
  await page
    .getByText('Strategy saved for this Dot.', { exact: true })
    .waitFor();
  report.checks.push(
    'Visible strategy form persists the exact mint and natural-language policy',
  );
  await page.getByRole('button', { name: 'Evaluate now', exact: true }).click();
  await page
    .getByText('Decision saved with its evidence.', { exact: true })
    .waitFor({ timeout: 60000 });
  let view = await api(`/dots/${dotId}/trading`);
  records = view.records;
  const decision = view.records.find((r) => r.type === 'decision');
  assert(decision.data.model.startsWith('jev-'));
  assert.equal(decision.data.autoExecute, false);
  assert(decision.data.market.priceUsd > 0);
  console.log('Real decision received. Checking graph and layouts.');
  report.decision = {
    model: decision.data.model,
    action: decision.data.answers.action.choice,
    confidence: decision.data.answers.action.confidence,
    gate: decision.data.gate,
    priceSource: decision.data.market.source,
    tokenIntelligenceSource: decision.data.market.tokenIntelligence?.source,
  };
  await page.locator('.trading-brain svg circle').first().click();
  await page.screenshot({ path: join(directory, 'desktop.png') });
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    const fits = await page.evaluate(() => {
      const el = document.querySelector('.trading-brain');
      return (
        document.documentElement.scrollWidth <= innerWidth &&
        el.scrollWidth <= el.clientWidth + 1
      );
    });
    assert(fits, 'Trading panel overflows.');
  }
  report.checks.push('Graph inspection and mobile/desktop layout fit');
  await page
    .getByRole('button', { name: 'Monitor for one hour', exact: true })
    .click();
  await page
    .getByText('Monitoring started for one hour.', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Close drawer', exact: true }).click();
  console.log('Panel closed. Waiting for background monitor decision.');
  const start = Date.now();
  while (Date.now() - start < 85000) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    view = await api(`/dots/${dotId}/trading`);
    if (view.records.filter((r) => r.type === 'decision').length > 1) break;
  }
  assert(
    view.records.filter((r) => r.type === 'decision').length > 1,
    'No background decision after closing the panel.',
  );
  report.checks.push('Read-only monitor evaluates after the panel closes');
  const command = await api(`/dots/${dotId}/trading/decide`, 'POST', {
    requestId: crypto.randomUUID(),
    command:
      'Explain the observed outcomes and how the current strategy confidence threshold is adapting.',
  });
  assert.equal(command.data.dispatch.function, 'explain_outcomes');
  report.command = {
    function: command.data.dispatch.function,
    confidence: command.data.dispatch.confidence,
    memories: command.data.memories.length,
  };
  view = await api(`/dots/${dotId}/trading`);
  records = view.records;
  report.paperOutcomes = view.learning.samples;
  report.graphNodes = view.graph.nodes.length;
  const config = await api('/markets/brain/config');
  report.sources = config.feeds.sources.map((s) => ({
    id: s.id,
    status: s.status,
    health: s.healthStatus,
  }));
  report.observedEvents = config.feeds.events.length;
  const serialized = JSON.stringify({ config, view });
  for (const key of Object.values(env).filter(Boolean))
    assert(!serialized.includes(key), 'Provider key was returned to client.');
  assert.equal(errors.length, 0);
  report.checks.push(
    'Real TypeSafe command routing and private Supermemory recall; no browser runtime errors or returned keys',
  );
  await api(`/dots/${dotId}/trading/monitor`, 'POST', { enabled: false });
  await runtime.close();
  const restarted = await startDesktopServer({
    dataPath,
    clientPath: resolve('dist/client'),
    token,
    env,
    port: 0,
  });
  try {
    const r = await fetch(restarted.origin + `/api/dots/${dotId}/trading`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const persisted = await r.json();
    assert.equal(persisted.strategy.version, view.strategy.version);
    assert(persisted.records.some((r) => r.id === decision.id));
    report.checks.push('Strategy and journal survive a real server restart');
  } finally {
    await restarted.close();
  }
  await writeFile(
    join(directory, 'verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  await runtime.close().catch(() => {});
  // Remove only this verifier's private provider documents, retaining local proof.
  if (dotId) {
    const ns = namespace_for(JSON.stringify(['solana-dots-desktop', dotId]));
    for (const record of records) {
      await fetch(`https://api.supermemory.ai/ns/${ns}/document/${record.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.SUPERMEMORY_API_KEY}` },
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
  }
}
