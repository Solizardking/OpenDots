// Native UI + live read-only chat. Approval UI uses clearly marked fixture responses; no mainnet broadcast.
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { _electron } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output =
  process.env.DOTS_ARTIFACT_DIRECTORY || join(root, 'artifacts/pumpfun-0.2.2');
const profile = mkdtempSync(join(tmpdir(), 'solana-dots-pump-'));
const values = { ...process.env };
for (const path of [
  join(root, '../.env'),
  join(root, '.env'),
  join(root, '.env.local'),
])
  if (existsSync(path))
    Object.assign(values, parseEnv(readFileSync(path, 'utf8')));
const provider =
  values.MODEL_PROVIDER?.trim() ||
  (values.OPENROUTER_API_KEY
    ? 'openrouter'
    : values.XAI_API_KEY
      ? 'xai'
      : 'openai');
assert(['openrouter', 'xai', 'openai'].includes(provider));
const keyName =
  provider === 'openrouter'
    ? 'OPENROUTER_API_KEY'
    : provider === 'xai'
      ? 'XAI_API_KEY'
      : 'OPENAI_API_KEY';
const modelName =
  provider === 'openrouter'
    ? 'OPENROUTER_MUSEMODEL'
    : provider === 'xai'
      ? 'XAI_MODEL'
      : 'OPENAI_MODEL';
const model =
  values[modelName]?.trim() ||
  (provider === 'openrouter'
    ? values.OPENROUTER_MODEL?.trim() || 'meta/muse-wonder'
    : provider === 'xai'
      ? 'grok-4.7'
      : 'gpt-5-mini');
assert(
  values[keyName],
  'A local model provider configuration is needed for native chat verification.',
);
const rpc =
  values.SOLANA_RPC_URL ||
  values.HELIUS_RPC_URL ||
  values.RPC_URL ||
  'https://api.mainnet-beta.solana.com';
mkdirSync(output, { recursive: true });
const entry = join(profile, 'verify.mjs');
writeFileSync(
  entry,
  `import { app } from 'electron';\napp.setPath('userData', ${JSON.stringify(profile)});\nawait import(${JSON.stringify(pathToFileURL(join(output, 'runtime/electron/main.mjs')).href)});\n`,
);
const errors = [],
  checks = [];
const fixturePassword = 'fixture-pump-ui-encryption-passphrase';
let app, page;
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
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('.wordmark');
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page
      .evaluate((settings) => window.solanaDots.saveSettings(settings), {
        MODEL_PROVIDER: provider,
        [keyName]: values[keyName],
        [modelName]: model,
        SOLANA_RPC_URL: rpc,
      })
      .catch((error) => {
        if (!/Execution context was destroyed/.test(error.message)) throw error;
      }),
  ]);
  await page.waitForSelector('.wordmark');
  await page.getByRole('button', { name: /Edit specialist/ }).click();
  await page
    .getByText('Create or import an encrypted wallet', { exact: true })
    .click();
  await page.getByLabel('Wallet name', { exact: true }).fill('Pump QA wallet');
  await page
    .getByLabel('Encryption passphrase (at least 12 characters)', {
      exact: true,
    })
    .fill(fixturePassword);
  await page
    .getByRole('button', { name: 'Create wallet', exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelector('#dot-wallet')?.value,
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForSelector('#dot-wallet', { state: 'hidden' });
  checks.push('wallet created and assigned through the normal Dot settings UI');
  const mint = '8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump';
  await page
    .getByLabel('Start a conversation', { exact: true })
    .fill(
      `Use inspect_pump_token to inspect this Pump.fun coin: ${mint}. Tell me its quote asset, trading venue and my wallet token balance. Do not prepare or execute a transaction.`,
    );
  await page
    .getByRole('button', { name: 'Start conversation', exact: true })
    .click();
  await page.waitForSelector('.chat-composer');
  await page.waitForFunction(
    () =>
      !document.querySelector('button[aria-label="Stop response"]') &&
      [...document.querySelectorAll('.chat-bubble.assistant')].some((node) =>
        /PumpSwap/i.test(node.textContent || ''),
      ),
    undefined,
    { timeout: 60000 },
  );
  checks.push(
    'live model used the native Pump tool and returned the real mainnet PumpSwap venue',
  );
  await page
    .getByRole('button', { name: 'Launch or trade on Pump.fun', exact: true })
    .click();
  await page.getByLabel('Pump coin name').fill('QA Coin');
  await page.getByLabel('Pump coin symbol').fill('QA');
  await page.getByLabel('Pump metadata URI').fill('ipfs://qa-fixture-metadata');
  await page.screenshot({ path: join(output, 'native-pump-launch.png') });
  await page.getByRole('button', { name: 'Buy', exact: true }).click();
  await page.getByLabel('Pump token mint').fill(mint);
  await page
    .getByRole('button', { name: 'Inspect coin & balance', exact: true })
    .click();
  await page.waitForSelector('.pump-token-info');
  assert.match(
    await page.locator('.pump-token-info').innerText(),
    /PumpSwap.*Quote: SOL/,
  );
  await page
    .getByRole('button', { name: 'Prepare for review', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.pump-error')].some((node) =>
        /simulation failed|wallet fund/i.test(node.textContent || ''),
      ),
    undefined,
    { timeout: 30000 },
  );
  await page.screenshot({ path: join(output, 'native-pump-unfunded.png') });
  checks.push(
    'visible buy flow inspected the real coin and blocked unfunded transaction simulation',
  );
  // Test only the review UI with a fabricated server record, using no real signing or RPC send.
  const id = randomUUID();
  const fixture = {
    id,
    status: 'prepared',
    network: 'solana-mainnet',
    kind: 'buy',
    venue: 'PumpSwap',
    walletName: 'UI fixture wallet',
    address: '11111111111111111111111111111111',
    mint,
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteLabel: 'SOL',
    inputAmount: '0.01',
    expectedOutput: '100',
    minimumOutput: '99',
    maximumQuote: '0.01',
    slippageBps: 100,
    networkFeeSol: '0.000005',
    estimatedSolDebit: '0.012',
    balanceSol: '1',
    expiresAt: Date.now() + 75000,
    lastValidBlockHeight: 999999,
    transactionBase64: 'UI fixture only',
    transactionHash: 'a'.repeat(64),
    instructions: [],
  };
  let approvals = 0,
    declines = 0;
  await page.route('**/pump/trade', (route) => {
    fixture.id = randomUUID();
    fixture.status = 'prepared';
    delete fixture.signature;
    return route.fulfill({ json: fixture });
  });
  await page.route('**/pump/requests/*', (route) =>
    route.fulfill({ json: fixture }),
  );
  await page.route('**/pump/requests/*/approve', async (route) => {
    const body = route.request().postDataJSON();
    assert.equal(body.confirm, true);
    assert.equal(body.transactionHash, fixture.transactionHash);
    assert.equal(body.credential.value, fixturePassword);
    approvals++;
    fixture.status = 'submitted';
    fixture.signature = 'UIFixtureOnlyNoBroadcast';
    await route.fulfill({ json: fixture });
  });
  await page.route('**/pump/requests/*/decline', (route) => {
    declines++;
    fixture.status = 'declined';
    return route.fulfill({ json: fixture });
  });
  await page
    .getByRole('button', { name: 'Prepare for review', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Approve & submit', exact: true })
    .waitFor();
  assert(
    await page
      .getByRole('button', { name: 'Approve & submit', exact: true })
      .isDisabled(),
  );
  await page
    .getByLabel('Unlock wallet for Pump transaction')
    .fill(fixturePassword);
  assert(
    await page
      .getByRole('button', { name: 'Approve & submit', exact: true })
      .isDisabled(),
  );
  await page
    .getByLabel('I reviewed the wallet, token, amounts and mainnet transaction')
    .check();
  assert(
    await page
      .getByRole('button', { name: 'Approve & submit', exact: true })
      .isEnabled(),
  );
  await page.screenshot({
    path: join(output, 'native-pump-review-fixture.png'),
  });
  await page.getByRole('button', { name: 'Decline', exact: true }).click();
  assert.equal(declines, 1);
  assert.equal(approvals, 0);
  checks.push(
    'fixture review shows server amounts and requires credential plus explicit review; decline performs no approval',
  );
  // A new fixture prepares another review and exercises the visible approve button once.
  await page
    .getByRole('button', { name: 'Prepare for review', exact: true })
    .click();
  await page.waitForSelector('.pump-unlock');
  await page
    .getByLabel('Unlock wallet for Pump transaction')
    .fill(fixturePassword);
  await page
    .getByLabel('I reviewed the wallet, token, amounts and mainnet transaction')
    .check();
  await page
    .getByRole('button', { name: 'Approve & submit', exact: true })
    .click();
  await page.getByText('submitted', { exact: true }).waitFor();
  assert.equal(approvals, 1);
  assert.equal(
    await page.getByLabel('Unlock wallet for Pump transaction').count(),
    0,
  );
  checks.push(
    'fixture approval posts only the reviewed hash and wallet credential once; submitted receipt is distinct from confirmed',
  );
  await page
    .getByRole('button', { name: 'Close Pump.fun', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Launch or trade on Pump.fun', exact: true })
    .click();
  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  await page.getByLabel('Pump token mint').fill(mint);
  await page
    .getByRole('button', { name: 'Inspect coin & balance', exact: true })
    .click();
  await page.waitForSelector('.pump-token-info');
  await page.getByLabel('Pump trade amount').fill('1');
  await page.unroute('**/pump/trade');
  await page
    .getByRole('button', { name: 'Prepare for review', exact: true })
    .click();
  await page.waitForSelector('.pump-error');
  checks.push(
    'sell amount and actual wallet balance checked before a transaction can be approved',
  );
  const session = await page.evaluate(() => window.solanaDots.session());
  const token = session.token;
  const privateUrls = [rpc, values[keyName], token, fixturePassword];
  assert(
    !(await page.evaluate(
      (secrets) =>
        secrets.some((secret) =>
          document
            .querySelector('.chat-transcript')
            ?.textContent?.includes(secret),
        ),
      privateUrls,
    )),
  );
  assert.equal(errors.length, 0);
  writeFileSync(
    join(output, 'native-pump-verification.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        checks,
        browserErrors: errors,
        model,
        liveMainnetReadVerified: true,
        fundedTransactionExecuted: false,
        reviewUiUsesFixture: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      checks,
      browserErrors: errors,
      fundedTransactionExecuted: false,
    }),
  );
} catch (error) {
  await page
    ?.screenshot({ path: join(output, 'native-pump-failure.png') })
    .catch(() => {});
  writeFileSync(
    join(output, 'native-pump-verification-failure.json'),
    JSON.stringify(
      { checks, browserErrors: errors, error: error.message },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await app?.close();
  rmSync(profile, { recursive: true, force: true });
}
