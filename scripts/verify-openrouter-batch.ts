/**
 * Live batch proof using only generated native-wallet fixtures and tiny prompts.
 * Pass DATABASE_URL and, preferably, a random 32-byte base64url
 * VERIFY_FIXTURE_SEED through child-process environment memory. Retain that seed
 * in the caller's memory to resume with VERIFY_RESUME=<receipt path>; it is never
 * written to the receipt, output, browser, or network. A pending run exits 2 and
 * preserves its owner identity/job. No OpenRouter API key is used by this script.
 */
import { strict as assert } from 'node:assert';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import bs58 from 'bs58';
import { PostgresUserDatabase } from '../src/server/user-database.js';
import type { AuthSession, SignInChallenge } from '../src/shared/auth-types.js';
import type {
  OpenRouterBatchJob,
  OpenRouterBatchState,
} from '../src/shared/openrouter-types.js';

const origin = new URL(process.env.VERIFY_ORIGIN ?? 'https://chatgptee.ai')
  .origin;
const directory = resolve(
  process.env.VERIFY_ARTIFACTS ?? 'artifacts/chatgptee-openrouter-batch',
);
const receiptPath = resolve(directory, 'batch-resume.json');
const timeoutMs = Number(process.env.VERIFY_BATCH_TIMEOUT_MS ?? 15 * 60_000);
assert(
  Number.isFinite(timeoutMs) &&
    timeoutMs >= 10_000 &&
    timeoutMs <= 24 * 60 * 60_000,
  'Use a batch timeout between ten seconds and 24 hours.',
);
assert(process.env.DATABASE_URL, 'Pass DATABASE_URL through process memory.');
mkdirSync(directory, { recursive: true });
const api = '/api/openrouter/batches';
const prompts = [
  'What is 2 + 2? Reply with only the number.',
  'What is 3 * 3? Reply with only the number.',
];
const maxTokens = 64;
const terminal = (status: string) =>
  ['completed', 'failed', 'expired', 'cancelled', 'deleted'].includes(status);
const credentialLooking = /\bsk-or-[A-Za-z0-9_-]{8,}\b/;
function checkPublicText(text: string) {
  assert(
    !credentialLooking.test(text),
    'A client-facing surface exposed credential-looking text.',
  );
}
function safeDiagnostic(value: string) {
  return value
    .replace(/(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/g, (match) => {
      try {
        const url = new URL(match);
        return `${url.hostname}${url.pathname}`;
      } catch {
        return '[redacted URL]';
      }
    })
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-or-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[redacted token]',
    );
}
async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_done, reject) => {
        timer = setTimeout(
          () => reject(Error(`${label} timed out.`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
type Receipt = {
  version: 1;
  origin: string;
  startedAt: string;
  walletAddress: string;
  isolatedWalletAddress: string;
  userId?: string;
  isolatedUserId?: string;
  requestId?: string;
  jobId?: string;
  jobStatus?: string;
  model?: string;
  baseModel?: string;
  maxTokens?: number;
  expectedAnswers?: string[];
  requestCounts?: OpenRouterBatchJob['requestCounts'];
  sourceHash?: string;
  resumeGate?: {
    previousSourceHash: string;
    sourceHash: string;
    path: string;
    reason: string;
    at: string;
  };
  ownerRetained: boolean;
  fixtureSeedWasSupplied: boolean;
  updatedAt: string;
};
const resumed = process.env.VERIFY_RESUME
  ? (JSON.parse(readFileSync(process.env.VERIFY_RESUME, 'utf8')) as Receipt)
  : undefined;
const suppliedSeed = process.env.VERIFY_FIXTURE_SEED;
assert(
  suppliedSeed,
  'Pass a random fixture seed through process memory and retain it for any pending resume.',
);
const seed = Buffer.from(suppliedSeed, 'base64url');
assert(
  seed.length === 32,
  'VERIFY_FIXTURE_SEED must encode exactly 32 random bytes.',
);
function wallet(walletSeed: Buffer) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      walletSeed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = [
    ...createPublicKey(privateKey)
      .export({ format: 'der', type: 'spki' })
      .subarray(-32),
  ];
  return {
    privateKey,
    publicKey,
    address: bs58.encode(new Uint8Array(publicKey)),
  };
}
const ownerWallet = wallet(seed);
const isolatedWallet = wallet(
  createHash('sha256').update(seed).update('batch-isolation-wallet').digest(),
);
if (resumed) {
  assert.equal(resumed.version, 1);
  assert.equal(resumed.origin, origin);
  assert.equal(
    resumed.walletAddress,
    ownerWallet.address,
    'Resume seed does not own the recorded wallet.',
  );
  assert.equal(resumed.isolatedWalletAddress, isolatedWallet.address);
  assert(resumed.requestId, 'Receipt does not identify a submitted request.');
}
const receipt: Receipt = resumed ?? {
  version: 1,
  origin,
  startedAt: new Date().toISOString(),
  walletAddress: ownerWallet.address,
  isolatedWalletAddress: isolatedWallet.address,
  ownerRetained: false,
  fixtureSeedWasSupplied: !!suppliedSeed,
  updatedAt: new Date().toISOString(),
};
const report: Record<string, unknown> = {
  origin,
  startedAt: new Date().toISOString(),
  resumed: !!resumed,
  fixtureWallet: ownerWallet.address,
  sourceTransition: resumed?.resumeGate,
  isolatedWallet: isolatedWallet.address,
  checks: {},
};
const checks = report.checks as Record<string, boolean>;
const browserErrors: string[] = [];
const networkFailures: {
  hostname: string;
  path: string;
  method: string;
  status: number | null;
  expected: boolean;
  failure?: string;
}[] = [];
let observedSubmission = !!resumed;
let deleted = false;
let job: OpenRouterBatchJob | undefined;
let primaryPage: Page | undefined;
const db = new PostgresUserDatabase(process.env.DATABASE_URL!);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.VERIFY_CHROME_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const contexts: BrowserContext[] = [];
const controlledAddresses = new Set<string>();
const inspectedResponses: Promise<void>[] = [];
function saveReceipt() {
  receipt.updatedAt = new Date().toISOString();
  if (job) {
    receipt.jobId = job.id;
    receipt.requestId = job.requestId;
    receipt.jobStatus = deleted ? 'deleted' : job.status;
    receipt.model = job.model;
    receipt.baseModel = job.baseModel;
    receipt.maxTokens = job.maxTokens;
    receipt.expectedAnswers = ['4', '9'];
    receipt.requestCounts = job.requestCounts;
  }
  const temporaryPath = `${receiptPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(receipt, null, 2) + '\n');
  renameSync(temporaryPath, receiptPath);
}
function saveReport() {
  report.browserErrors = [...browserErrors];
  report.networkFailures = networkFailures.map((item) => ({ ...item }));
  writeFileSync(
    resolve(directory, 'batch-verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
}
function observePage(page: Page) {
  page.on('pageerror', (error) =>
    browserErrors.push(safeDiagnostic(error.message)),
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      browserErrors.push(safeDiagnostic(message.text()));
  });
  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.hostname === 'openrouter.ai')
        browserErrors.push('The browser contacted OpenRouter directly.');
      if (url.origin !== origin || !url.pathname.startsWith(api)) return;
      if (url.pathname === api && request.method() === 'POST') {
        observedSubmission = true;
        receipt.ownerRetained = true;
        const submittedBody = request.postDataJSON() as { requestId?: unknown };
        if (
          typeof submittedBody.requestId === 'string' &&
          /^[a-f0-9-]{36}$/i.test(submittedBody.requestId)
        )
          receipt.requestId = submittedBody.requestId;
        saveReceipt();
      }
      checkPublicText(JSON.stringify(request.headers()));
      checkPublicText(request.postData() ?? '');
      if (url.pathname === api && request.method() === 'POST') {
        const body = request.postDataJSON() as {
          requestId: string;
          prompts: string[];
          maxTokens: number;
        };
        assert.deepEqual(body.prompts, prompts);
        assert.equal(body.maxTokens, maxTokens);
        assert.match(body.requestId, /^[a-f0-9-]{36}$/i);
        receipt.requestId = body.requestId;
        receipt.ownerRetained = true;
        saveReceipt();
      }
    } catch (error) {
      browserErrors.push(
        safeDiagnostic(
          error instanceof Error
            ? error.message
            : 'Could not inspect browser request.',
        ),
      );
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    const contentType = response.headers()['content-type'] ?? '';
    if (
      url.origin === origin &&
      url.pathname !== '/api/setup-telemetry' &&
      /(?:application\/json|javascript)/i.test(contentType)
    ) {
      const inspect = bounded(
        response.text(),
        5000,
        `Inspecting ${url.pathname}`,
      )
        .then(checkPublicText)
        .catch((error) => {
          if (
            !String(error).includes('closed') &&
            !String(error).includes('No resource')
          )
            browserErrors.push(
              safeDiagnostic(
                error instanceof Error
                  ? error.message
                  : 'Could not inspect batch response.',
              ),
            );
        });
      inspectedResponses.push(inspect);
    }
    if (response.status() >= 400) {
      networkFailures.push({
        hostname: url.hostname,
        path: url.pathname,
        method: response.request().method(),
        status: response.status(),
        expected: false,
      });
      browserErrors.push(
        `Unexpected HTTP ${response.status()} ${url.hostname}${url.pathname}`,
      );
    }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    const failure = safeDiagnostic(
      request.failure()?.errorText ?? 'Request failed',
    );
    const expected = failure === 'net::ERR_ABORTED';
    networkFailures.push({
      hostname: url.hostname,
      path: url.pathname,
      method: request.method(),
      status: null,
      expected,
      failure,
    });
    if (!expected)
      browserErrors.push(
        `Unexpected network failure ${url.hostname}${url.pathname}: ${failure}`,
      );
  });
}
async function installWallet(
  context: BrowserContext,
  fixture: ReturnType<typeof wallet>,
) {
  await context.addInitScript('window.__name = (fn) => fn;');
  await context.exposeFunction('qaSignMessage', (bytes: number[]) => [
    ...sign(null, Buffer.from(bytes), fixture.privateKey),
  ]);
  await context.exposeFunction(
    'qaSignIn',
    (input: SignInChallenge['input']) => {
      const message = createSignInMessageText({
        ...input,
        address: fixture.address,
      });
      return {
        message: [...new TextEncoder().encode(message)],
        signature: [...sign(null, Buffer.from(message), fixture.privateKey)],
      };
    },
  );
  await context.addInitScript(
    ({ address, publicKey, icon }) => {
      const account = {
        address,
        publicKey: new Uint8Array(publicKey),
        chains: ['solana:mainnet'],
        features: [
          'solana:signIn',
          'solana:signMessage',
          'solana:signTransaction',
          'solana:signAndSendTransaction',
        ],
      };
      let accounts: (typeof account)[] = [];
      const listeners = new Set<
        (event: { accounts: typeof accounts }) => void
      >();
      const notify = () =>
        listeners.forEach((listener) => listener({ accounts }));
      const qa = window as unknown as {
        qaSignMessage: (bytes: number[]) => Promise<number[]>;
        qaSignIn: (
          input: unknown,
        ) => Promise<{ message: number[]; signature: number[] }>;
      };
      const neverSignTransactions = async () => {
        throw Error(
          'This fixture only authenticates and never signs transactions.',
        );
      };
      const wallet = {
        version: '1.0.0',
        name: 'Phantom',
        icon,
        chains: ['solana:mainnet'],
        get accounts() {
          return accounts;
        },
        features: {
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              accounts = [account];
              notify();
              return { accounts };
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => {
              accounts = [];
              notify();
            },
          },
          'standard:events': {
            version: '1.0.0',
            on: (
              _event: string,
              callback: (event: { accounts: typeof accounts }) => void,
            ) => {
              listeners.add(callback);
              return () => listeners.delete(callback);
            },
          },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: neverSignTransactions,
          },
          'solana:signAndSendTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signAndSendTransaction: neverSignTransactions,
          },
          'solana:signMessage': {
            version: '1.0.0',
            signMessage: async (...inputs: { message: Uint8Array }[]) =>
              Promise.all(
                inputs.map(async (input) => ({
                  signedMessage: input.message,
                  signature: new Uint8Array(
                    await qa.qaSignMessage([...input.message]),
                  ),
                  signatureType: 'ed25519',
                })),
              ),
          },
          'solana:signIn': {
            version: '1.0.0',
            signIn: async (...inputs: unknown[]) =>
              Promise.all(
                inputs.map(async (input) => {
                  const output = await qa.qaSignIn(input);
                  accounts = [account];
                  notify();
                  return {
                    account,
                    signedMessage: new Uint8Array(output.message),
                    signature: new Uint8Array(output.signature),
                    signatureType: 'ed25519',
                  };
                }),
              ),
          },
        },
      };
      const register = (api: { register: (...wallets: unknown[]) => void }) =>
        api.register(wallet);
      window.addEventListener('wallet-standard:app-ready', (event) =>
        register((event as CustomEvent).detail),
      );
      window.dispatchEvent(
        new CustomEvent('wallet-standard:register-wallet', {
          detail: register,
        }),
      );
    },
    {
      address: fixture.address,
      publicKey: fixture.publicKey,
      icon: `data:image/svg+xml;base64,${readFileSync('public/brand/solana-logomark.svg').toString('base64')}`,
    },
  );
}
const schema = new Map<string, Set<string>>();
async function inspectSchema() {
  const result = await db.pool.query<{
    table_name: string;
    column_name: string;
  }>(
    'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1)',
    [
      [
        'solana_dots_users',
        'solana_dots_auth_challenges',
        'chatgptee_auth_user',
        'chatgptee_auth_account',
        'chatgptee_auth_session',
        'chatgptee_auth_verification',
      ],
    ],
  );
  for (const row of result.rows) {
    const columns = schema.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    schema.set(row.table_name, columns);
  }
}
async function identity(address: string) {
  const mapped = schema.get('solana_dots_users')?.has('better_auth_user_id');
  const result = await db.pool.query<{
    id: string;
    privy_user_id: string | null;
    better_auth_user_id: string | null;
  }>(
    `SELECT id,privy_user_id,${mapped ? 'better_auth_user_id' : 'NULL::text AS better_auth_user_id'} FROM solana_dots_users WHERE wallet_address=$1`,
    [address],
  );
  const row = result.rows[0];
  const ids = new Set<string>(
    row?.better_auth_user_id ? [row.better_auth_user_id] : [],
  );
  if (schema.has('chatgptee_auth_user')) {
    const users = await db.pool.query<{ id: string }>(
      'SELECT id FROM chatgptee_auth_user WHERE "solanaWallet"=$1',
      [address],
    );
    for (const user of users.rows) ids.add(user.id);
  }
  if (schema.has('chatgptee_auth_account')) {
    const users = await db.pool.query<{ userId: string }>(
      'SELECT "userId" FROM chatgptee_auth_account WHERE "providerId"=$1 AND "accountId"=$2',
      ['solana', address],
    );
    for (const user of users.rows) ids.add(user.userId);
  }
  return { row, authIds: [...ids] };
}
async function cleanupFixture(address: string, expectedUserId?: string) {
  if (!controlledAddresses.has(address)) return false;
  const found = await identity(address);
  if (!found.row && !found.authIds.length) return true;
  assert(
    !found.row || found.row.id === expectedUserId,
    'Cleanup refused a different workspace identity.',
  );
  assert(
    !found.row?.privy_user_id,
    'Native fixture unexpectedly has a Privy identity; cleanup was refused.',
  );
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (found.authIds.length) {
      const users = await client.query<{ solanaWallet: string | null }>(
        'SELECT "solanaWallet" FROM chatgptee_auth_user WHERE id=ANY($1) FOR UPDATE',
        [found.authIds],
      );
      assert(
        users.rows.every((user) => user.solanaWallet === address),
        'Cleanup refused another wallet identity.',
      );
      const foreign = await client.query(
        'SELECT id FROM chatgptee_auth_account WHERE "userId"=ANY($1) AND ("providerId"<>$2 OR "accountId"<>$3)',
        [found.authIds, 'solana', address],
      );
      assert.equal(
        foreign.rowCount,
        0,
        'Cleanup refused an identity with other linked accounts.',
      );
      if (schema.get('solana_dots_users')?.has('better_auth_user_id')) {
        const workspaces = await client.query(
          'SELECT id FROM solana_dots_users WHERE better_auth_user_id=ANY($1) AND wallet_address IS DISTINCT FROM $2',
          [found.authIds, address],
        );
        assert.equal(
          workspaces.rowCount,
          0,
          'Cleanup refused another workspace.',
        );
      }
      await client.query(
        'DELETE FROM chatgptee_auth_session WHERE "userId"=ANY($1)',
        [found.authIds],
      );
      await client.query(
        'DELETE FROM chatgptee_auth_account WHERE "userId"=ANY($1)',
        [found.authIds],
      );
      await client.query('DELETE FROM chatgptee_auth_user WHERE id=ANY($1)', [
        found.authIds,
      ]);
    }
    if (schema.has('chatgptee_auth_verification')) {
      const values = await client.query<{ id: string; value: string }>(
        'SELECT id,value FROM chatgptee_auth_verification WHERE identifier ~ $1 AND position($2 in value)>0',
        ['^(clawd|chatgptee)-solana:', address],
      );
      const ids = values.rows
        .filter((row) => {
          try {
            return JSON.parse(row.value).input?.address === address;
          } catch {
            return false;
          }
        })
        .map((row) => row.id);
      if (ids.length)
        await client.query(
          'DELETE FROM chatgptee_auth_verification WHERE id=ANY($1)',
          [ids],
        );
    }
    if (schema.has('solana_dots_auth_challenges'))
      await client.query(
        "DELETE FROM solana_dots_auth_challenges WHERE input->>'address'=$1",
        [address],
      );
    await client.query(
      'DELETE FROM solana_dots_users WHERE wallet_address=$1 AND id=$2',
      [address, expectedUserId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const remaining = await identity(address);
  assert(
    !remaining.row && !remaining.authIds.length,
    'Fixture remained after cleanup.',
  );
  return true;
}
async function requestJson<T>(
  context: BrowserContext,
  path: string,
  method = 'GET',
  body?: unknown,
  requestOrigin = origin,
) {
  const response = await context.request.fetch(
    new URL(path, origin).toString(),
    {
      method,
      headers: { Origin: requestOrigin, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { data: body } : {}),
      timeout: 30_000,
    },
  );
  const text = await bounded(response.text(), 5000, `Reading ${path}`);
  checkPublicText(text);
  assert(
    /application\/json/i.test(response.headers()['content-type'] ?? ''),
    `Expected JSON from ${method} ${path}; received HTTP ${response.status()} with a different content type.`,
  );
  return { status: response.status(), body: JSON.parse(text) as T };
}
async function signIn(
  fixture: ReturnType<typeof wallet>,
  expectedExisting?: string,
) {
  const before = await identity(fixture.address);
  if (expectedExisting)
    assert.equal(
      before.row?.id,
      expectedExisting,
      'Resume workspace identity changed.',
    );
  else
    assert(
      !before.row && !before.authIds.length,
      'Generated fixture matched an existing account.',
    );
  controlledAddresses.add(fixture.address);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  contexts.push(context);
  await installWallet(context, fixture);
  const page = await context.newPage();
  observePage(page);
  await page.goto(origin);
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .click();
  await page.getByRole('button', { name: /Phantom/ }).click();
  await page
    .getByRole('button', { name: 'Sign in with this wallet', exact: true })
    .click();
  await page.getByRole('button', { name: 'ChatGPTEE', exact: true }).waitFor();
  const session = await requestJson<AuthSession>(context, '/api/auth/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.owner, false);
  assert.equal(session.body.user?.walletAddress, fixture.address);
  const userId = session.body.user!.id;
  const persisted = await identity(fixture.address);
  assert.equal(
    persisted.row?.id,
    userId,
    'Native session did not match the Neon workspace user.',
  );
  return { context, page, userId };
}
async function openPanel(page: Page) {
  await page
    .getByRole('button', { name: 'Claude batches', exact: true })
    .click();
  const panel = page.getByRole('dialog', {
    name: 'Claude batches',
    exact: true,
  });
  await panel.getByLabel('Prompts', { exact: true }).waitFor();
  await panel
    .getByLabel('Prompts', { exact: true })
    .waitFor({ state: 'visible' });
  return panel;
}
async function verifyRelease(stage: 'before' | 'after') {
  const expectedSourceHash =
    resumed?.resumeGate?.sourceHash ?? process.env.VERIFY_SOURCE_HASH;
  if (!expectedSourceHash) return;
  assert.match(expectedSourceHash, /^[a-f0-9]{64}$/);
  const releaseUrl = new URL(
    resumed?.resumeGate?.path ??
      process.env.VERIFY_RELEASE_PATH ??
      '/hybrid-auth-release.json',
    origin,
  );
  assert.equal(releaseUrl.origin, origin);
  assert(
    [
      '/openrouter-release.json',
      '/agent-access-release.json',
      '/hybrid-auth-release.json',
    ].includes(releaseUrl.pathname),
  );
  const response = await bounded(
    fetch(releaseUrl, { signal: AbortSignal.timeout(10_000) }),
    12_000,
    'Checking deployed release',
  );
  assert.equal(response.status, 200);
  const release = (await bounded(
    response.json(),
    5000,
    'Reading deployed release',
  )) as { sourceHash?: string };
  assert.equal(release.sourceHash, expectedSourceHash);
  receipt.sourceHash = release.sourceHash;
  checks[stage === 'before' ? 'releaseHash' : 'releaseHashAfter'] = true;
}
async function verifyViewportGeometry(page: Page) {
  const measurements = [];
  for (const width of [390, 375, 360, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await bounded(
      page.evaluate(
        () =>
          new Promise<void>((done) => {
            window.scrollTo(0, 0);
            requestAnimationFrame(() => requestAnimationFrame(() => done()));
          }),
      ),
      5000,
      'Settling mobile viewport',
    );
    const measurement = await bounded(
      page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        buttons: [
          ...document.querySelectorAll<HTMLButtonElement>('.topbar button'),
        ]
          .filter((button) => {
            const rectangle = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return (
              rectangle.width > 0 &&
              rectangle.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none'
            );
          })
          .map((button) => {
            const rectangle = button.getBoundingClientRect();
            return {
              name:
                button.getAttribute('aria-label') ?? button.textContent?.trim(),
              left: rectangle.left,
              right: rectangle.right,
              top: rectangle.top,
              bottom: rectangle.bottom,
              withinViewport:
                rectangle.left >= 0 &&
                rectangle.right <= window.innerWidth &&
                rectangle.top >= 0 &&
                rectangle.bottom <= window.innerHeight,
            };
          }),
      })),
      5000,
      'Measuring mobile viewport',
    );
    measurements.push(measurement);
    report.mobileViewportGeometry = measurements;
    assert.equal(measurement.innerWidth, width);
    assert(
      measurement.scrollWidth <= measurement.innerWidth,
      `The ${width}px viewport has horizontal overflow.`,
    );
    assert(
      measurement.buttons.length >= 5,
      'The mobile topbar is missing controls.',
    );
    assert(
      measurement.buttons.every((button) => button.withinViewport),
      `A topbar control extends outside the ${width}px viewport.`,
    );
    for (const name of ['Sign out', 'Pair with phone'])
      assert(measurement.buttons.some((button) => button.name === name));
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  checks.mobileTopbarGeometry = true;
}
let owner: Awaited<ReturnType<typeof signIn>> | undefined;
try {
  await inspectSchema();
  const health = await fetch(new URL('/healthz', origin));
  assert.equal(health.status, 200, 'Normal hostname health check failed.');
  checks.normalHostname = true;
  await verifyRelease('before');
  const unauthenticated = await fetch(new URL(api, origin), {
    headers: { Origin: origin },
  });
  checkPublicText(await unauthenticated.text());
  assert.equal(unauthenticated.status, 401);
  checks.unauthenticatedBlocked = true;
  owner = await signIn(ownerWallet, resumed?.userId);
  primaryPage = owner.page;
  receipt.userId = owner.userId;
  report.userId = owner.userId;
  checks.nativeSignInAndNeon = true;
  await verifyViewportGeometry(owner.page);
  let panel = await openPanel(owner.page);
  const initial = await requestJson<OpenRouterBatchState>(owner.context, api);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.configured, true);
  assert.equal(
    initial.body.configuredModel.replace(/:batch$/, ''),
    'anthropic/claude-haiku-5.5',
  );
  checks.batchPanelAndConfiguredModel = true;
  if (resumed) {
    job = initial.body.jobs.find(
      (item) => item.requestId === resumed.requestId,
    );
    assert(job, 'Saved batch was not found; do not submit a replacement.');
    if (resumed.jobId) assert.equal(job.id, resumed.jobId);
  } else {
    assert.equal(
      initial.body.jobs.length,
      0,
      'New fixture unexpectedly has batch jobs.',
    );
    await panel
      .getByLabel('Prompts', { exact: true })
      .fill(prompts.join('\n\n'));
    await panel
      .getByLabel('Maximum output tokens per request', { exact: true })
      .fill(String(maxTokens));
    const submitted = owner.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === api &&
        response.request().method() === 'POST',
    );
    await panel
      .getByRole('button', { name: 'Submit batch', exact: true })
      .click();
    const response = await submitted;
    const text = await response.text();
    checkPublicText(text);
    const output = JSON.parse(text) as
      OpenRouterBatchJob | { job?: OpenRouterBatchJob };
    job = 'id' in output ? output : output.job;
    assert(job, 'The submission did not return its durable batch job.');
    saveReceipt();
    assert.equal(
      response.status(),
      202,
      `Batch submission returned HTTP ${response.status()}.`,
    );
  }
  assert.match(job.id, /^[a-f0-9-]{36}$/i);
  assert.equal(job.requestCounts.total, 2);
  assert.equal(job.maxTokens, maxTokens);
  assert.equal(job.requestId, receipt.requestId);
  assert.deepEqual(
    job.prompts.map((item) => item.prompt),
    prompts,
  );
  report.jobId = job.id;
  report.requestId = job.requestId;
  checks.submittedTwoTinyPrompts = true;
  await owner.page.screenshot({
    animations: 'disabled',
    path: resolve(directory, 'batch-queued-desktop.png'),
  });
  await owner.page.reload();
  await owner.page
    .getByRole('button', { name: 'ChatGPTEE', exact: true })
    .waitFor();
  panel = await openPanel(owner.page);
  const reloaded = await requestJson<OpenRouterBatchState>(owner.context, api);
  assert.equal(
    reloaded.body.jobs.find((item) => item.requestId === job!.requestId)?.id,
    job.id,
  );
  checks.reloadPreservedLocalJob = true;
  const retry = await requestJson<OpenRouterBatchJob>(
    owner.context,
    api,
    'POST',
    { requestId: job.requestId, prompts, maxTokens },
  );
  assert([200, 202].includes(retry.status));
  assert.equal(retry.body.id, job.id);
  const retriedList = await requestJson<OpenRouterBatchState>(
    owner.context,
    api,
  );
  assert.equal(
    retriedList.body.jobs.filter((item) => item.requestId === job!.requestId)
      .length,
    1,
  );
  checks.idempotentRetrySameJob = true;
  const crossOrigin = await requestJson(
    owner.context,
    api,
    'POST',
    { requestId: job.requestId, prompts, maxTokens },
    'https://batch-verification.invalid',
  );
  assert.equal(crossOrigin.status, 403);
  checks.crossOriginBlocked = true;
  const isolated = await signIn(isolatedWallet);
  receipt.isolatedUserId = isolated.userId;
  report.isolatedUserId = isolated.userId;
  assert.notEqual(isolated.userId, owner.userId);
  const foreign = await requestJson(isolated.context, `${api}/${job.id}`);
  assert.equal(foreign.status, 404);
  const foreignDeletion = await requestJson(
    isolated.context,
    `${api}/${job.id}`,
    'DELETE',
    {},
  );
  assert.equal(foreignDeletion.status, 404);
  const privateList = await requestJson<OpenRouterBatchState>(
    isolated.context,
    api,
  );
  assert.equal(privateList.status, 200);
  assert.equal(privateList.body.jobs.length, 0);
  checks.secondWalletCannotReadJob = true;
  await isolated.context.close();
  await cleanupFixture(isolatedWallet.address, isolated.userId);
  report.isolatedFixtureRemoved = true;
  saveReceipt();
  const deadline = Date.now() + timeoutMs;
  const ownedJobId = job.id;
  let lastStatus = '';
  let lastProgressAt = 0;
  for (;;) {
    const polled: {
      status: number;
      body: OpenRouterBatchJob | { job?: OpenRouterBatchJob; error?: string };
    } = await requestJson<
      OpenRouterBatchJob | { job?: OpenRouterBatchJob; error?: string }
    >(owner.context, `${api}/${ownedJobId}`);
    const current: OpenRouterBatchJob | undefined =
      'id' in polled.body ? polled.body : polled.body.job;
    if (current) {
      job = current;
      saveReceipt();
    }
    assert(job, 'The saved batch disappeared while polling.');
    assert.equal(
      polled.status,
      200,
      `Polling returned HTTP ${polled.status}; the saved job was not resubmitted.`,
    );
    assert.equal(job.id, receipt.jobId);
    if (job.status !== lastStatus || Date.now() - lastProgressAt > 60_000) {
      console.log(
        JSON.stringify({
          phase: 'polling',
          jobId: job.id,
          status: job.status,
          requestCounts: job.requestCounts,
        }),
      );
      lastStatus = job.status;
      lastProgressAt = Date.now();
    }
    if (terminal(job.status) && job.status !== 'completed')
      throw Error(`The batch ended with status ${job.status}.`);
    if (job.status === 'completed' && job.results !== null) break;
    if (Date.now() >= deadline) {
      report.pending = true;
      receipt.ownerRetained = true;
      saveReceipt();
      report.pendingReason =
        'OpenRouter has not returned both completed results within the verification window.';
      process.exitCode = 2;
      break;
    }
    await new Promise<void>((done) => setTimeout(done, 10_000));
  }
  assert(job, 'The verifier has no saved batch result.');
  report.finalStatus = job.status;
  report.requestCounts = job.requestCounts;
  if (!report.pending) {
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.requestCounts, { total: 2, completed: 2, failed: 0 });
    assert.equal(job.results?.length, 2);
    assert.deepEqual(
      job.results!.map((item) => item.text?.trim()),
      ['4', '9'],
    );
    assert(
      job.results!.every(
        (item) => item.error === null && item.statusCode === 200,
      ),
    );
    checks.twoActualAssistantAnswers = true;
    await panel
      .getByRole('button', { name: 'Close drawer', exact: true })
      .click();
    panel = await openPanel(owner.page);
    const article = panel.locator('article').filter({ hasText: prompts[0] });
    await article.waitFor();
    for (const prompt of prompts)
      await article.getByText(prompt, { exact: true }).click();
    await article.locator('.batch-output').filter({ hasText: /^4$/ }).waitFor();
    await article.locator('.batch-output').filter({ hasText: /^9$/ }).waitFor();
    checkPublicText(await owner.page.locator('body').innerText());
    checks.visibleAssistantResults = true;
    await owner.page.screenshot({
      animations: 'disabled',
      path: resolve(directory, 'batch-completed-desktop.png'),
    });
    await owner.page.setViewportSize({ width: 390, height: 844 });
    await owner.page.screenshot({
      animations: 'disabled',
      path: resolve(directory, 'batch-completed-mobile.png'),
    });
    await owner.page.setViewportSize({ width: 1440, height: 960 });
    const removed = owner.page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `${api}/${job!.id}` &&
        response.request().method() === 'DELETE',
    );
    await article
      .getByRole('button', { name: 'Delete finished batch', exact: true })
      .click();
    const removal = await removed;
    const removalText = await removal.text();
    checkPublicText(removalText);
    assert.equal(removal.status(), 200);
    assert.deepEqual(JSON.parse(removalText), { deleted: true, id: job.id });
    deleted = true;
    await article.waitFor({ state: 'detached' });
    const afterDelete = await requestJson<OpenRouterBatchState>(
      owner.context,
      api,
    );
    assert(!afterDelete.body.jobs.some((item) => item.id === job!.id));
    assert.equal(
      (await requestJson(owner.context, `${api}/${job.id}`)).status,
      410,
    );
    const deletedReplay = await requestJson(owner.context, api, 'POST', {
      requestId: job.requestId,
      prompts,
      maxTokens,
    });
    assert.equal(deletedReplay.status, 410);
    checks.terminalDeletionAndUiRemoval = true;
    await owner.page.screenshot({
      animations: 'disabled',
      path: resolve(directory, 'batch-deleted-desktop.png'),
    });
  }
  await verifyRelease('after');
  await Promise.all(inspectedResponses);
  assert.equal(
    browserErrors.length,
    0,
    'The live browser recorded unexpected errors.',
  );
  checks.noClientCredentialLookingText = true;
  report.passed = !report.pending;
} catch (error) {
  report.passed = false;
  report.error = safeDiagnostic(
    error instanceof Error ? error.message : 'Batch verification failed.',
  );
  process.exitCode = 1;
  if (primaryPage && !primaryPage.isClosed()) {
    await primaryPage
      .screenshot({
        path: resolve(directory, 'batch-verification-failure.png'),
      })
      .catch(() => undefined);
  }
} finally {
  // Resolve an ambiguous UI response through local ownership, never a new POST.
  if (observedSubmission && !job && owner) {
    try {
      const list = await requestJson<OpenRouterBatchState>(owner.context, api);
      if (list.status === 200)
        job = list.body.jobs.find(
          (item) => item.requestId === receipt.requestId,
        );
    } catch {
      /* Preserve the owner while acceptance cannot be ruled out. */
    }
  }
  // A failed terminal batch can be removed; withheld completed results stay resumable.
  if (
    !deleted &&
    job &&
    terminal(job.status) &&
    (job.status !== 'completed' || job.results !== null) &&
    owner
  ) {
    try {
      const removal = await requestJson<{ deleted?: boolean; id?: string }>(
        owner.context,
        `${api}/${job.id}`,
        'DELETE',
        {},
      );
      deleted =
        removal.status === 200 &&
        removal.body.deleted === true &&
        removal.body.id === job.id;
      report.failedRunTerminalJobRemoved = deleted;
    } catch {
      /* An unconfirmed deletion keeps its fixture owner. */
    }
  }
  receipt.ownerRetained = observedSubmission && !deleted;
  saveReceipt();
  report.browserErrors = [...browserErrors];
  saveReport();
  for (const context of contexts)
    await bounded(context.close(), 10_000, 'Closing browser context').catch(
      () => undefined,
    );
  let browserStopped = false;
  try {
    await bounded(browser.close(), 10_000, 'Closing browser');
    browserStopped = true;
  } catch {
    report.browserShutdownError =
      'Browser shutdown could not be confirmed; fixture cleanup was deferred.';
    receipt.ownerRetained = true;
    process.exitCode = 1;
  }
  await Promise.all(inspectedResponses);
  try {
    if (!receipt.ownerRetained && browserStopped) {
      report.ownerFixtureRemoved = await cleanupFixture(
        ownerWallet.address,
        receipt.userId,
      );
    } else {
      report.ownerFixtureRemoved = false;
      report.resumeReceipt = receiptPath;
      report.resumeRequiresOriginalSeed = true;
    }
    if (!report.isolatedFixtureRemoved && browserStopped)
      report.isolatedFixtureRemoved = await cleanupFixture(
        isolatedWallet.address,
        receipt.isolatedUserId,
      );
  } catch (error) {
    report.cleanupError = safeDiagnostic(
      error instanceof Error ? error.message : 'Fixture cleanup failed.',
    );
    process.exitCode = 1;
  }
  await db.close();
  saveReceipt();
  report.finishedAt = new Date().toISOString();
  report.cleanupScope =
    'Generated Neon users and native identity/session records only; server workspace files and cached runtimes are retained.';
  saveReport();
  console.log(JSON.stringify(report));
}
