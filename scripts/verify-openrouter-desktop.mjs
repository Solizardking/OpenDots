// Build first with DOTS_ARTIFACT_DIRECTORY=artifacts/openrouter-desktop-verification.
// Run: node --env-file=.env scripts/verify-openrouter-desktop.mjs
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'artifacts/openrouter-desktop-verification');
const profile = mkdtempSync(join(tmpdir(), 'solana-dots-openrouter-'));
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
const defaultModel = 'meta/muse-wonder';
const model =
  process.env.OPENROUTER_MUSEMODEL?.trim() ||
  process.env.OPENROUTER_MODEL?.trim() ||
  defaultModel;
assert(apiKey, 'Configure OPENROUTER_API_KEY before verification.');
const redact = (value) => String(value).split(apiKey).join('[redacted]');
mkdirSync(output, { recursive: true });
const entry = join(profile, 'verify.mjs');
writeFileSync(
  entry,
  `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(profile)});\nawait import(${JSON.stringify(pathToFileURL(join(root, 'electron/main.mjs')).href)});\n`,
);
const errors = [];
const report = {
  verifiedAt: new Date().toISOString(),
  model,
  defaultModel,
  modelSetting: 'OPENROUTER_MUSEMODEL',
  nativeSettings: false,
  defaultModelObserved: false,
  keyEncrypted: false,
  credentialReturned: false,
  modelAfterRuntimeRestart: false,
  modelAfterAppRestart: false,
  liveComposerReply: false,
  conversationAfterAppRestart: false,
  browserErrors: errors,
  isolatedProfile: true,
};
const launch = () =>
  _electron.launch({
    args: [entry],
    cwd: root,
    timeout: 30000,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: tmpdir(),
      DO_NOT_TRACK: '1',
      DOTS_ARTIFACT_DIRECTORY: output,
      ELECTRON_RUN_AS_NODE: '',
    },
  });
let app, page;
try {
  app = await launch();
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(redact(error.message)));
  await page.waitForSelector('.wordmark');
  const openSettings = async () => {
    console.log(JSON.stringify({ openingNativeSettings: true }));
    await page
      .getByRole('button', { name: 'Settings & setup', exact: true })
      .click();
    await page.waitForSelector('#model-provider');
  };
  await openSettings();
  assert.equal(
    await page.locator('#model-provider').inputValue(),
    'openrouter',
  );
  assert.equal(await page.locator('#desktop-model').inputValue(), defaultModel);
  report.defaultModelObserved = true;
  if (model !== defaultModel) await page.locator('#desktop-model').fill(model);
  await page.locator('#provider-OPENROUTER_API_KEY').fill(apiKey);
  await page
    .getByRole('button', { name: 'Save provider connections', exact: true })
    .click();
  await page.waitForSelector('#model-provider', {
    state: 'hidden',
    timeout: 30000,
  });
  await page.waitForSelector('.wordmark');
  const settings = await page.evaluate(() => window.solanaDots.settings());
  assert(settings.configured.includes('OPENROUTER_API_KEY'));
  assert(!JSON.stringify(settings).includes(apiKey));
  console.log(
    JSON.stringify({ nativeKeySaved: true, credentialReturned: false }),
  );
  assert(
    !readFileSync(join(profile, 'credentials.bin')).includes(
      Buffer.from(apiKey),
    ),
  );
  report.keyEncrypted = true;
  await openSettings();
  assert.equal(await page.locator('#desktop-model').inputValue(), model);
  assert.equal(
    await page.locator('#provider-OPENROUTER_API_KEY').inputValue(),
    '',
  );
  await page.screenshot({ path: join(output, 'settings.png') });
  report.nativeSettings = true;
  // Saving an explicit model restarts the same SQLite workspace.
  await page.locator('#desktop-model').fill('');
  await page.locator('#desktop-model').fill(model);
  await page
    .getByRole('button', { name: 'Save provider connections', exact: true })
    .click();
  await page.waitForSelector('#model-provider', {
    state: 'hidden',
    timeout: 30000,
  });
  await page.waitForSelector('.wordmark');
  const restartedSettings = await page.evaluate(() =>
    window.solanaDots.settings(),
  );
  assert.equal(restartedSettings.values.OPENROUTER_MUSEMODEL, model);
  assert(restartedSettings.configured.includes('OPENROUTER_API_KEY'));
  assert(!JSON.stringify(restartedSettings).includes(apiKey));
  assert.equal(restartedSettings.values.OPENROUTER_MODEL, undefined);
  report.modelAfterRuntimeRestart = true;
  // Reopen the app to exercise Keychain decryption and disk-backed settings.
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(redact(error.message)));
  await page.waitForSelector('.wordmark');
  const reloadedSettings = await page.evaluate(() =>
    window.solanaDots.settings(),
  );
  assert.equal(reloadedSettings.values.OPENROUTER_MUSEMODEL, model);
  assert(reloadedSettings.configured.includes('OPENROUTER_API_KEY'));
  assert(!JSON.stringify(reloadedSettings).includes(apiKey));
  await openSettings();
  assert.equal(await page.locator('#desktop-model').inputValue(), model);
  assert.equal(
    await page.locator('#provider-OPENROUTER_API_KEY').inputValue(),
    '',
  );
  await page.keyboard.press('Escape');
  report.modelAfterAppRestart = true;
  console.log(JSON.stringify(report));
  const request = 'What is 3 + 3? Reply with just the word for the result.';
  await page.locator('.composer textarea').fill(request);
  await page.locator('.composer textarea').press('Enter');
  const result = await page.waitForFunction(
    () => {
      const visibleError = [
        ...document.querySelectorAll('.chat-error, [role="alert"]'),
      ].find(
        (node) =>
          node instanceof HTMLElement &&
          node.offsetParent !== null &&
          node.textContent?.trim(),
      );
      if (visibleError) return { error: visibleError.textContent?.trim() };
      return [...document.querySelectorAll('.chat-bubble.assistant')].some(
        (node) => /six/i.test(node.textContent || ''),
      )
        ? { reply: true }
        : false;
    },
    undefined,
    { timeout: 60000 },
  );
  const reply = await result.jsonValue();
  if (reply.error) throw Error(`Live Composer failed: ${redact(reply.error)}`);
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Stop response"]'),
    undefined,
    { timeout: 60000 },
  );
  report.liveComposerReply = true;
  await page.screenshot({ path: join(output, 'chat.png') });
  // Only successful live replies can provide conversation-history evidence.
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(redact(error.message)));
  await page.waitForSelector('.wordmark');
  await page
    .locator('.thread-list .nav-item')
    .filter({ hasText: request })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.chat-bubble.assistant')].some((node) =>
        /six/i.test(node.textContent || ''),
      ),
    undefined,
    { timeout: 20000 },
  );
  await page.screenshot({ path: join(output, 'chat-after-app-restart.png') });
  report.conversationAfterAppRestart = true;
  assert.equal(errors.length, 0);
  writeFileSync(
    join(output, 'verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} catch (error) {
  const message = redact(error);
  const visibleErrors = page
    ? await page
        .locator('.chat-error, [role="alert"]')
        .allTextContents()
        .then((values) => values.map(redact).filter(Boolean))
        .catch(() => [])
    : [];
  await page
    ?.screenshot({
      path: join(output, 'failure.png'),
      mask: [page.locator('input[type="password"]')],
    })
    .catch(() => {});
  writeFileSync(
    join(output, 'failure.json'),
    JSON.stringify({ ...report, error: message, visibleErrors }, null, 2) +
      '\n',
  );
  console.error(message);
  process.exitCode = 1;
} finally {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
}
