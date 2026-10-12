import { _electron, chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
const directory = process.env.DOTS_ARTIFACT_DIRECTORY || 'artifacts/solana-dots';
const release = JSON.parse(readFileSync(`${directory}/release/release.json`));
const checks = [], errors = [];
const appPath = process.env.DOTS_VERIFY_APP_PATH || release.appPath;
const app = await _electron.launch({ executablePath: appPath + '/Contents/MacOS/Solana Dots', timeout: 45000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
let browser, originalTheme, originalCompanion;
let originalDeviceIds = new Set();
const qaPhoneName = 'QA phone ' + Date.now().toString(36);
try {
  let page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('.wordmark');
  originalTheme = await page.evaluate(() => localStorage.getItem('opendots-theme'));
  originalCompanion = await page.evaluate(() => window.solanaDots.companion('state'));
  originalDeviceIds = new Set(originalCompanion.devices.map(device => device.id));
  assert.equal(await page.title(), 'ChatGPTEE');
  checks.push('signed app launches with isolated native bridge and local workspace');
  if (process.argv.includes('--import-workspace-config') || process.argv.includes('--import-local-config')) {
    const env = parseEnv(readFileSync(process.argv.includes('--import-workspace-config') ? '../.env' : '.env', 'utf8'));
    const secretNames = ['OPENROUTER_API_KEY','XAI_API_KEY','OPENAI_API_KEY','E2B_API_KEY','VOICE_API_KEY','BROWSER_USE_API_KEY','PARALLEL_API_KEY','MEM0_API_KEY','COPILOTKIT_INTELLIGENCE_API_KEY'];
    const names = [...secretNames,'VOICE_MODEL','VOICE_NAME','BROWSER_USE_MODEL','OPENAI_MODEL','XAI_IMAGE_MODEL','OPENROUTER_CLAUDE_MODEL','MEM0_BASE_URL','MEM0_ORG_ID','MEM0_PROJECT_ID'];
    const values = Object.fromEntries(names.filter(k => env[k]?.trim()).map(k => [k, env[k].trim()]));
    if (env.BROWSER_USE_API_KEY || env.BROWSERUSE_API_KEY) values.BROWSER_USE_API_KEY = env.BROWSER_USE_API_KEY || env.BROWSERUSE_API_KEY;
    values.MODEL_PROVIDER = env.MODEL_PROVIDER || 'openrouter';
    values.OPENROUTER_MODEL = env.OPENROUTER_MODEL || env.OPENROUTER_CLAUDE_MODEL || 'anthropic/claude-haiku-5.5';
    values.XAI_MODEL = env.XAI_MODEL || 'grok-4.7';
    // Explicit local setup: move the existing provider configuration into OS encryption.
    await page.evaluate(values => window.solanaDots.saveSettings(values), values).catch(() => {});
    await page.waitForSelector('.wordmark', { timeout: 30000 });
    const saved = await page.evaluate(() => window.solanaDots.settings());
    const providerKey = values.MODEL_PROVIDER === 'openrouter' ? 'OPENROUTER_API_KEY' : values.MODEL_PROVIDER === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY';
    assert(saved.configured.includes(providerKey));
    assert.equal(saved.values.MODEL_PROVIDER, values.MODEL_PROVIDER);
    assert(!Object.values(saved.values).some(value => secretNames.some(key => values[key] && value === values[key])));
    checks.push('existing local provider credentials saved to macOS Keychain and excluded from public settings');
  }
  await page.evaluate(() => { localStorage.setItem('opendots-theme','dark'); location.reload(); });
  await page.waitForSelector('.wordmark');
  await page.screenshot({ path: `${directory}/native-workspace-dark.png` });
  await page.getByRole('button', { name: 'Settings & setup', exact: true }).click();
  await page.waitForSelector('#dialog-title');
  await page.screenshot({ path: `${directory}/native-settings.png` });
  assert(await page.locator('.desktop-provider-settings').isVisible());
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  checks.push('settings drawer has secure provider connections and closes with Escape');
  await page.getByRole('button', { name: 'Show computer', exact: true }).click();
  await page.waitForSelector('.result-pane');
  await page.screenshot({ path: `${directory}/native-computer.png` });
  await page.getByRole('button', { name: 'Close result panel' }).click();
  checks.push('computer side panel opens and closes');
  await page.getByRole('button', { name: 'Open phone and messaging', exact: true }).click();
  if (!originalCompanion.enabled) await page.getByRole('button', { name: 'Enable Phone access' }).click();
  await page.getByRole('button', { name: 'Create pairing code' }).click();
  await page.waitForSelector('.pair-qr');
  const state = await page.evaluate(() => window.solanaDots.companion('state'));
  const origin = state.urls.find(url => !url.includes('127.0.0.1'));
  assert(origin && state.pairing);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const phone = await context.newPage();
  phone.on('pageerror', error => errors.push(error.message));
  assert.equal((await context.request.get(origin + '/api/workspace')).status(), 401);
  await phone.goto(origin + '/pair#' + state.pairing.token);
  await phone.getByLabel('Device name').fill(qaPhoneName);
  await phone.screenshot({ path: `${directory}/mobile-pair.png` });
  await phone.getByRole('button', { name: 'Pair with Mac' }).click();
  await phone.waitForSelector('.wordmark', { timeout: 20000, state: 'attached' });
  assert.equal((await context.request.get(origin + '/api/workspace')).status(), 200);
  assert.equal((await context.request.post(origin + '/api/wallets/fixture/sign', { data: { confirm: true } })).status(), 403);
  assert.equal((await context.request.patch(origin + '/api/settings', { data: { paused: true } })).status(), 403);
  assert.equal((await context.request.post(origin + '/api/companion/pair', { data: { credential: state.pairing.token, name: 'Replay' } })).status(), 400);
  checks.push('real LAN pairing unlocks phone workspace; token replay, wallet signing and settings mutation are denied');
  assert(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await phone.screenshot({ path: `${directory}/mobile-workspace.png` });
  await phone.getByRole('button', { name: 'Open navigation' }).click();
  await phone.screenshot({ path: `${directory}/mobile-navigation.png` });
  await phone.getByRole('button', { name: 'Close navigation' }).click();
  checks.push('390px phone layout fits viewport and navigation opens and closes');
  if (process.argv.includes('--phone-chat')) {
    const request = 'What is 2 + 2? Answer briefly.';
    const replyIndex = await phone.locator('.chat-bubble.assistant').count();
    await phone.locator('.composer textarea, .chat-composer textarea').fill(request);
    await phone.locator('.composer textarea, .chat-composer textarea').press('Enter');
    const reply = phone.locator('.chat-bubble.assistant').nth(replyIndex);
    await reply.waitFor({ state: 'visible', timeout: 60000 });
    await phone.waitForFunction(index => { const node = document.querySelectorAll('.chat-bubble.assistant')[index]; return node && (/4|four/i.test(node.textContent || '') || node.querySelector('ol')?.start === 4); }, replyIndex, { timeout: 60000 });
    await phone.waitForFunction(() => !document.querySelector('button[aria-label="Stop response"]'), undefined, { timeout: 60000 });
    const answer = await reply.evaluate(node => node.textContent.trim() || `${node.querySelector('ol')?.start}.`);
    assert.match(answer, /4|four/i);
    await phone.screenshot({ path: `${directory}/mobile-chat-live.png` });
    await page.keyboard.press('Escape');
    await page.locator('.thread-list .nav-item').filter({ hasText: request }).first().click();
    await page.waitForFunction(answer => [...document.querySelectorAll('.chat-bubble.assistant')].some(node => (node.textContent?.trim() || `${node.querySelector('ol')?.start}.`) === answer), answer, { timeout: 20000 });
    await page.screenshot({ path: `${directory}/native-mobile-synced.png` });
    await page.getByRole('button', { name: 'Open phone and messaging', exact: true }).click();
    checks.push('phone composer receives live model reply and same conversation opens on Mac');
  }
  const paired = await page.evaluate(() => window.solanaDots.companion('state'));
  const device = paired.devices.find(d => d.name === qaPhoneName && !originalDeviceIds.has(d.id)); assert(device);
  await page.screenshot({ path: `${directory}/native-phone-paired.png` });
  await page.getByRole('button', { name: 'Revoke ' + qaPhoneName }).click();
  assert.equal((await context.request.get(origin + '/api/workspace')).status(), 401);
  await page.getByRole('button', { name: 'Turn off Phone access' }).click();
  assert.equal((await page.evaluate(() => window.solanaDots.companion('state'))).enabled, false);
  checks.push('Mac revocation immediately rejects existing phone cookie; Phone listener shuts down');
  await page.keyboard.press('Escape');
  if (process.argv.includes('--live-chat')) {
    const request = 'What is 3 + 3? Answer briefly.';
    const box = page.getByPlaceholder('Message your Dot…');
    // Use the visible composer. This is one model request without tools or transactions.
    const textarea = await box.count() ? box : page.locator('.composer textarea, .chat-composer textarea');
    const replyIndex = await page.locator('.chat-bubble.assistant').count();
    await textarea.fill(request);
    await textarea.press('Enter');
    const reply = page.locator('.chat-bubble.assistant').nth(replyIndex);
    await reply.waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForFunction(index => { const node = document.querySelectorAll('.chat-bubble.assistant')[index]; return node && (/6|six/i.test(node.textContent || '') || node.querySelector('ol')?.start === 6); }, replyIndex, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('button[aria-label="Stop response"]'), undefined, { timeout: 60000 });
    await page.screenshot({ path: `${directory}/native-chat-live.png` });
    checks.push('normal desktop composer receives a live model reply');
  }
  writeFileSync(`${directory}/${process.env.DOTS_VERIFY_APP_PATH ? 'installed' : 'native'}-verification.json`, JSON.stringify({ checkedAt: new Date().toISOString(), appPath, releaseId: release.releaseId, sha256: release.sha256, inputsHash: release.inputsHash, checks, browserErrors: errors, physicalPhoneTested: false }, null, 2));
  assert.equal(errors.length, 0, 'Browser runtime errors occurred.');
  console.log(JSON.stringify({ checks, browserErrors: errors, physicalPhoneTested: false }));
} catch (error) {
  try { await (await app.firstWindow({ timeout: 1000 })).screenshot({ path: `${directory}/native-failure.png` }); } catch {}
  try { for (const context of browser?.contexts() || []) for (const page of context.pages()) await page.screenshot({ path: `${directory}/mobile-failure.png` }); } catch {}
  writeFileSync(`${directory}/verification-failure.json`, JSON.stringify({ checks, browserErrors: errors, error: error.message }, null, 2));
  throw error;
} finally {
  try {
    const page = await app.firstWindow({ timeout: 1000 });
    for (const device of (await page.evaluate(() => window.solanaDots.companion('state'))).devices.filter(device => device.name === qaPhoneName && !originalDeviceIds.has(device.id))) await page.evaluate(id => window.solanaDots.companion('revoke', id), device.id);
    await page.evaluate(() => window.solanaDots.companion('stop'));
    if (originalCompanion?.enabled) {
      await page.evaluate(() => window.solanaDots.companion('start'));
      if (originalCompanion.keepAwake) await page.evaluate(() => window.solanaDots.keepAwake(true));
    }
    if (originalTheme !== undefined) await page.evaluate(theme => theme === null ? localStorage.removeItem('opendots-theme') : localStorage.setItem('opendots-theme', theme), originalTheme);
  } catch {}
  await browser?.close(); await app.close();
}
