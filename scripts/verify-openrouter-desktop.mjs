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
assert(apiKey, 'Configure OPENROUTER_API_KEY before verification.');
mkdirSync(output, { recursive: true });
const entry = join(profile, 'verify.mjs');
writeFileSync(
  entry,
  `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(profile)});\nawait import(${JSON.stringify(pathToFileURL(join(root, 'electron/main.mjs')).href)});\n`,
);
const errors = [];
let app;
try {
  app = await _electron.launch({
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
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
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
  assert.equal(
    await page.locator('#desktop-model').inputValue(),
    'anthropic/claude-haiku-5.5',
  );
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
  await openSettings();
  assert.equal(
    await page.locator('#provider-OPENROUTER_API_KEY').inputValue(),
    '',
  );
  await page.screenshot({ path: join(output, 'settings.png') });
  await page.keyboard.press('Escape');
  const request = 'What is 3 + 3? Reply with just the word for the result.';
  await page.locator('.composer textarea').fill(request);
  await page.locator('.composer textarea').press('Enter');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.chat-bubble.assistant')].some((node) =>
        /six/i.test(node.textContent || ''),
      ),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () => !document.querySelector('button[aria-label="Stop response"]'),
    undefined,
    { timeout: 60000 },
  );
  await page.screenshot({ path: join(output, 'chat.png') });
  console.log(
    JSON.stringify({
      model: 'anthropic/claude-haiku-5.5',
      liveComposerReply: true,
    }),
  );
  // Saving an explicit model restarts the same SQLite workspace.
  await openSettings();
  await page.locator('#desktop-model').fill('');
  await page.locator('#desktop-model').fill('anthropic/claude-haiku-5.5');
  await page
    .getByRole('button', { name: 'Save provider connections', exact: true })
    .click();
  await page.waitForSelector('#model-provider', {
    state: 'hidden',
    timeout: 30000,
  });
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
  assert.equal(errors.length, 0);
  const report = {
    verifiedAt: new Date().toISOString(),
    model: 'anthropic/claude-haiku-5.5',
    nativeSettings: true,
    keyEncrypted: true,
    credentialReturned: false,
    liveComposerReply: true,
    conversationAfterRuntimeRestart: true,
    browserErrors: errors,
    isolatedProfile: true,
  };
  writeFileSync(
    join(output, 'verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} catch (error) {
  const message = String(error).split(apiKey).join('[redacted]');
  writeFileSync(
    join(output, 'failure.json'),
    JSON.stringify({ error: message, browserErrors: errors }, null, 2) + '\n',
  );
  console.error(message);
  process.exitCode = 1;
} finally {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
}
