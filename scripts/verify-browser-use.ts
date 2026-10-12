import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { WorkspaceStore } from '../src/server/workspace.js';
import { browserUseConfigFromEnv } from '../src/server/browser-use-config.js';
import { BrowserUseService } from '../src/server/browser-use-service.js';

const config = browserUseConfigFromEnv(process.env);
if (!config.browserUseApiKey)
  throw new Error('BROWSERUSE_API_KEY is required.');
const workspace = new WorkspaceStore(':memory:', 'browser-use-verification');
const id = workspace.dots()[0].id;
const service = new BrowserUseService(workspace, config, () => false);
mkdirSync('artifacts/verification', { recursive: true });
try {
  await service.permission(id, true);
  const cdp = config.cdpUrl ? await service.checkCdp(id) : undefined;
  console.log(
    'Supplied CDP connection:',
    cdp?.connected ? 'connected' : 'unavailable',
  );
  const page = await service.withStandaloneBrowser(id, async (cdpUrl) => {
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 20000 });
    try {
      const page = await browser.contexts()[0].newPage();
      try {
        await page.goto('https://example.com', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        const title = await page.title();
        if (title !== 'Example Domain')
          throw new Error('Unexpected page title.');
        await page.screenshot({
          path: 'artifacts/verification/browser-use-page.png',
        });
        return { title, url: page.url() };
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
  console.log('Standalone browser navigated and explicitly stopped.');
  const recording = await service.waitForRecording(id);
  console.log(
    'Recording:',
    recording.recordingUrl
      ? 'ready'
      : recording.recordingAvailable === false
        ? 'unavailable'
        : 'still processing',
  );
  if (recording.recordingUrl) {
    const response = await fetch(recording.recordingUrl, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(`Recording download returned HTTP ${response.status}.`);
    writeFileSync(
      'artifacts/verification/browser-use-recording.mp4',
      Buffer.from(await response.arrayBuffer()),
    );
  }
  const state = await service.createRun(id, {
    task: 'Open https://example.com and return the exact page title. Do not visit any other site or change any account state.',
  });
  console.log('Created gpt-6-luna browser task.');
  const result = await service.waitForRun(
    id,
    state.run!.id,
    AbortSignal.timeout(180000),
    175000,
  );
  let continued;
  if (
    result.status === 'completed' &&
    result.result?.includes('Example Domain')
  ) {
    const followup = await service.createRun(id, {
      task: 'Return the title you found in the previous task. Do not navigate anywhere.',
      followup: true,
    });
    continued = await service.waitForRun(
      id,
      followup.run!.id,
      AbortSignal.timeout(180000),
      175000,
    );
  }
  const evidence = {
    success:
      result.status === 'completed' &&
      !!continued?.result?.includes('Example Domain'),
    suppliedCdp: cdp,
    page,
    standaloneStopped: recording.status === 'stopped',
    recordingDownloaded: !!recording.recordingUrl,
    recordingAvailable: recording.recordingAvailable,
    run: {
      status: result.status,
      result: result.result,
      error: result.error,
      cost: result.totalCostUsd,
    },
    followup: continued
      ? {
          status: continued.status,
          result: continued.result,
          cost: continued.totalCostUsd,
          sameSession: result.sessionId === continued.sessionId,
        }
      : {
          skipped: true,
          reason: 'The initial run did not complete successfully.',
        },
  };
  writeFileSync(
    'artifacts/verification/browser-use-results.json',
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
  if (!evidence.success) process.exitCode = 1;
} finally {
  try {
    await service.stopAll();
  } finally {
    workspace.close();
  }
}
