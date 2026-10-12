/** Live browser + Neon verification with an ephemeral test wallet, never a user key. */
import { chromium, type Cookie } from 'playwright';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import bs58 from 'bs58';
import { PostgresUserDatabase } from '../src/server/user-database.js';
import type { SignInChallenge } from '../src/shared/auth-types.js';

const origin = process.env.VERIFY_ORIGIN ?? 'http://localhost:3460';
const directory =
  process.env.VERIFY_ARTIFACTS ?? 'artifacts/solana-dots-rebrand';
mkdirSync(directory, { recursive: true });
const pair = generateKeyPairSync('ed25519');
const publicKey = [
  ...pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
];
const address = bs58.encode(new Uint8Array(publicKey));
const db = new PostgresUserDatabase(process.env.DATABASE_URL!);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const errors: string[] = [];
const networkFailures: {
  hostname: string;
  path: string;
  method: string;
  status: number | null;
  expected: boolean;
  failure?: string;
}[] = [];
const report: Record<string, unknown> = { origin };
let privyId: string | undefined;
let betterAuth = false;
const schema = new Map<string, Set<string>>();
const authTableNames = [
  'solana_dots_users',
  'chatgptee_auth_user',
  'chatgptee_auth_account',
  'chatgptee_auth_session',
  'chatgptee_auth_verification',
];
function safeLocation(value: string) {
  try {
    const url = new URL(value);
    return {
      hostname: url.hostname,
      path: url.pathname.replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
        '[redacted]',
      ),
    };
  } catch {
    return { hostname: 'unknown', path: 'unknown' };
  }
}
function safeDiagnostic(value: string) {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
      const location = safeLocation(match);
      return `${location.hostname}${location.path}`;
    })
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[redacted token]',
    );
}
async function inspectAuthSchema() {
  const result = await db.pool.query<{
    table_name: string;
    column_name: string;
  }>(
    'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1)',
    [authTableNames],
  );
  schema.clear();
  for (const row of result.rows) {
    const columns = schema.get(row.table_name) ?? new Set<string>();
    columns.add(row.column_name);
    schema.set(row.table_name, columns);
  }
  if (betterAuth) {
    for (const [table, columns] of [
      ['chatgptee_auth_user', ['id', 'solanaWallet']],
      ['chatgptee_auth_account', ['userId', 'providerId', 'accountId']],
      ['chatgptee_auth_session', ['userId']],
      ['chatgptee_auth_verification', ['id', 'identifier', 'value']],
    ] as const)
      if (!columns.every((column) => schema.get(table)?.has(column)))
        throw new Error(
          'Better Auth schema is missing required identity fields.',
        );
    const foreignKeys = await db.pool.query<{
      table_name: string;
      relation: string;
    }>(
      "SELECT conrelid::regclass::text AS table_name,pg_get_constraintdef(oid) AS relation FROM pg_constraint WHERE contype='f' AND conrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1))",
      [['chatgptee_auth_account', 'chatgptee_auth_session']],
    );
    report.betterAuthSchema = {
      tables: authTableNames.filter((table) => schema.has(table)),
      foreignKeys: foreignKeys.rows,
    };
  }
}
async function fixtureIdentity() {
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
    const accounts = await db.pool.query<{ userId: string }>(
      'SELECT "userId" FROM chatgptee_auth_account WHERE "providerId"=$1 AND "accountId"=$2',
      ['solana', address],
    );
    for (const account of accounts.rows) ids.add(account.userId);
  }
  const subjects = new Set<string>(
    row?.privy_user_id ? [row.privy_user_id] : [],
  );
  if (schema.has('chatgptee_auth_account') && ids.size) {
    const accounts = await db.pool.query<{ accountId: string }>(
      'SELECT "accountId" FROM chatgptee_auth_account WHERE "providerId"=$1 AND "userId"=ANY($2)',
      ['privy', [...ids]],
    );
    for (const account of accounts.rows) subjects.add(account.accountId);
  }
  return { row, betterAuthIds: [...ids], privySubjects: [...subjects] };
}
async function protectedSessionCookie(label: string) {
  const name = betterAuth
    ? `${new URL(origin).protocol === 'https:' ? '__Secure-' : ''}chatgptee.session_token`
    : 'solana-dots-session';
  const cookie = (await context.cookies()).find((value) => value.name === name);
  const lifetime = cookie ? cookie.expires - Date.now() / 1000 : 0;
  const expectedLifetime = (betterAuth ? 7 : 1) * 86400;
  const protectedCookie =
    !!cookie &&
    cookie.httpOnly &&
    cookie.sameSite === (betterAuth ? 'Lax' : 'Strict') &&
    cookie.path === (betterAuth ? '/' : '/api') &&
    (new URL(origin).protocol !== 'https:' || cookie.secure) &&
    Math.abs(lifetime - expectedLifetime) < 120;
  report[`${label}CookieProtected`] = protectedCookie;
  report[`${label}CookieContract`] = {
    name,
    httpOnly: cookie?.httpOnly,
    secure: cookie?.secure,
    sameSite: cookie?.sameSite,
    path: cookie?.path,
    expectedLifetimeSeconds: expectedLifetime,
    observedLifetimeSeconds: Math.round(lifetime),
  };
  if (!protectedCookie || !cookie)
    throw new Error(
      'Session cookie did not match the active authentication contract.',
    );
  return cookie;
}
async function replaySessionCookie(cookie: Cookie) {
  // Send the original captured credential independently of the browser jar.
  const response = await fetch(new URL('/api/auth/session', origin), {
    headers: { Origin: origin, Cookie: `${cookie.name}=${cookie.value}` },
  });
  const result = await response.json();
  return { status: response.status, result };
}
async function cookieAuthorized(cookie: Cookie, userId: string) {
  const { status, result } = await replaySessionCookie(cookie);
  return (
    status === 200 &&
    result.user?.id === userId &&
    result.user?.walletAddress === address &&
    result.owner === false
  );
}
async function cookieRevoked(cookie: Cookie) {
  const { status, result } = await replaySessionCookie(cookie);
  return status === 200 && result.user === null && result.owner === false;
}
async function cleanupFixture() {
  await inspectAuthSchema();
  const identity = await fixtureIdentity();
  privyId ??= identity.privySubjects[0];
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    if (identity.betterAuthIds.length) {
      // Validate ownership before cascading through identity/account/session records.
      const users = await client.query<{
        id: string;
        solanaWallet: string | null;
      }>(
        'SELECT id,"solanaWallet" FROM chatgptee_auth_user WHERE id=ANY($1) FOR UPDATE',
        [identity.betterAuthIds],
      );
      if (users.rows.some((user) => user.solanaWallet !== address))
        throw new Error(
          'Fixture cleanup refused an identity with another wallet.',
        );
      const foreignWallets = await client.query(
        'SELECT id FROM chatgptee_auth_account WHERE "userId"=ANY($1) AND "providerId"=$2 AND "accountId"<>$3',
        [identity.betterAuthIds, 'solana', address],
      );
      if (foreignWallets.rowCount)
        throw new Error(
          'Fixture cleanup refused an identity with other wallet accounts.',
        );
      if (schema.get('solana_dots_users')?.has('better_auth_user_id')) {
        const foreignWorkspaces = await client.query(
          'SELECT id FROM solana_dots_users WHERE better_auth_user_id=ANY($1) AND wallet_address IS DISTINCT FROM $2',
          [identity.betterAuthIds, address],
        );
        if (foreignWorkspaces.rowCount)
          throw new Error(
            'Fixture cleanup refused an identity with another workspace.',
          );
      }
      for (const table of ['chatgptee_auth_session', 'chatgptee_auth_account'])
        if (schema.has(table))
          await client.query(`DELETE FROM ${table} WHERE "userId"=ANY($1)`, [
            identity.betterAuthIds,
          ]);
      await client.query('DELETE FROM chatgptee_auth_user WHERE id=ANY($1)', [
        identity.betterAuthIds,
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
    await client.query(
      "DELETE FROM solana_dots_auth_challenges WHERE input->>'address'=$1",
      [address],
    );
    await client.query(
      'DELETE FROM solana_dots_users WHERE wallet_address=$1',
      [address],
    );
    await client.query('COMMIT');
    const remaining = await fixtureIdentity();
    report.neonFixtureRemoved =
      !remaining.row && remaining.betterAuthIds.length === 0;
    if (!report.neonFixtureRemoved)
      throw new Error(
        'Fixture identity remained in the database after cleanup.',
      );
    report.betterAuthFixturesRemoved = betterAuth
      ? identity.betterAuthIds.length
      : 'not used';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (privyId && /^did:privy:[a-z0-9]+$/.test(privyId)) {
    const headers = {
      'privy-app-id': process.env.PRIVY_APP_ID!,
      Authorization: `Basic ${Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString('base64')}`,
    };
    const endpoint = `https://auth.privy.io/api/v1/users/${encodeURIComponent(privyId)}`;
    const existing = await fetch(endpoint, { headers });
    if (existing.status === 404) report.privyFixtureRemoved = true;
    else {
      if (!existing.ok)
        throw new Error(
          'Could not verify Privy fixture ownership before cleanup.',
        );
      const user = await existing.json();
      if (
        user.id !== privyId ||
        user.linked_accounts?.length !== 1 ||
        user.linked_accounts[0].type !== 'wallet' ||
        user.linked_accounts[0].chain_type !== 'solana' ||
        user.linked_accounts[0].address !== address
      )
        throw new Error(
          'Fixture cleanup refused a Privy identity with other accounts.',
        );
      const result = await fetch(endpoint, { method: 'DELETE', headers });
      report.privyFixtureRemoved = result.ok || result.status === 404;
      if (!report.privyFixtureRemoved)
        throw new Error('Privy fixture removal failed.');
    }
  }
}
try {
  // tsx preserves function names with a helper; serialized browser callbacks need it too.
  await context.addInitScript('window.__name = (fn) => fn;');
  await context.exposeFunction('qaSignMessage', (bytes: number[]) => [
    ...sign(null, Buffer.from(bytes), pair.privateKey),
  ]);
  await context.exposeFunction(
    'qaSignIn',
    (input: SignInChallenge['input']) => {
      const message = createSignInMessageText({ ...input, address });
      return {
        message: [...new TextEncoder().encode(message)],
        signature: [...sign(null, Buffer.from(message), pair.privateKey)],
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
        listeners.forEach((callback) => callback({ accounts }));
      const qa = window as unknown as {
        qaSignMessage: (bytes: number[]) => Promise<number[]>;
        qaSignIn: (
          input: unknown,
        ) => Promise<{ message: number[]; signature: number[] }>;
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
          'solana:signAndSendTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signAndSendTransaction: async () => {
              throw new Error(
                'This authentication fixture never sends transactions.',
              );
            },
          },
          'solana:signTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signTransaction: async () => {
              throw new Error(
                'This authentication fixture never signs transactions.',
              );
            },
          },
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
                  const result = await qa.qaSignIn(input);
                  accounts = [account];
                  notify();
                  return {
                    account,
                    signedMessage: new Uint8Array(result.message),
                    signature: new Uint8Array(result.signature),
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
      address,
      publicKey,
      icon: `data:image/svg+xml;base64,${readFileSync('public/brand/solana-logomark.svg').toString('base64')}`,
    },
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(safeDiagnostic(error.message)));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    const location = safeLocation(response.url());
    const marker = request.headers()['x-chatgptee-verification'];
    const expected =
      location.hostname === new URL(origin).hostname &&
      ((marker === 'private-api' &&
        location.path === '/api/state' &&
        response.status() === 401) ||
        (marker === 'private-mcp' &&
          location.path.endsWith('/connections') &&
          response.status() === 400));
    networkFailures.push({
      ...location,
      method: request.method(),
      status: response.status(),
      expected,
    });
    if (!expected)
      errors.push(
        `Unexpected HTTP ${response.status()} ${request.method()} ${location.hostname}${location.path}`,
      );
  });
  page.on('requestfailed', (request) => {
    const location = safeLocation(request.url());
    const failure = safeDiagnostic(
      request.failure()?.errorText ?? 'Request failed',
    );
    // Reloading a page intentionally aborts its outstanding browser requests.
    const expected = failure === 'net::ERR_ABORTED';
    networkFailures.push({
      ...location,
      method: request.method(),
      status: null,
      expected,
      failure,
    });
    if (!expected)
      errors.push(
        `Unexpected network failure ${request.method()} ${location.hostname}${location.path}: ${failure}`,
      );
  });
  page.on('console', (message) => {
    // Explicit access-boundary checks intentionally produce rejected responses.
    if (
      message.type() === 'error' &&
      !(
        (message.location().url.endsWith('/api/state') &&
          message.text().includes('401')) ||
        (process.env.VERIFY_PUBLIC_MCP === '1' &&
          message.location().url.includes('/connections') &&
          message.text().includes('400'))
      )
    )
      errors.push(
        `${safeDiagnostic(message.text())} (${safeLocation(message.location().url).hostname}${safeLocation(message.location().url).path})`,
      );
  });
  await page.goto(origin);
  const configResponse = await context.request.get(
    new URL('/api/auth/config', origin).toString(),
  );
  if (!configResponse.ok())
    throw new Error('Could not read the active authentication configuration.');
  const publicConfig = await configResponse.json();
  betterAuth = publicConfig.betterAuth === true;
  report.authEngine = betterAuth
    ? 'Privy + Better Auth'
    : 'legacy Solana + Privy';
  await inspectAuthSchema();
  const previous = await fixtureIdentity();
  if (previous.row || previous.betterAuthIds.length)
    throw new Error(
      'Generated fixture unexpectedly matched an existing identity.',
    );
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .waitFor();
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/sign-in-desktop.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .waitFor();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/sign-in-mobile.png`,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .click();
  await page.getByRole('button', { name: /Phantom/ }).click();
  await page
    .getByRole('button', { name: 'Sign in with this wallet', exact: true })
    .click();
  await page.getByRole('button', { name: 'ChatGPTEE', exact: true }).waitFor();
  const session = await page.evaluate(async () =>
    (await fetch('/api/auth/session')).json(),
  );
  if (session.user?.walletAddress !== address)
    throw new Error('Signed wallet does not match the authenticated user.');
  report.nativeSignIn = true;
  if (session.owner !== false)
    throw new Error('Wallet authentication unexpectedly granted owner access.');
  const sessionCookie = await protectedSessionCookie('session');
  const nativeIdentity = await fixtureIdentity();
  report.neonUserCreated = nativeIdentity.row?.id === session.user.id;
  report.nativeNeonUserId = nativeIdentity.row?.id;
  if (!report.neonUserCreated)
    throw new Error(
      'Native session did not resolve to its Neon workspace identity.',
    );
  if (betterAuth && nativeIdentity.betterAuthIds.length !== 1)
    throw new Error(
      'Native sign-in did not create one mapped Better Auth identity.',
    );
  if (process.env.VERIFY_PUBLIC_MCP === '1') {
    report.privateMcpBlocked = await page.evaluate(async () => {
      const workspace = await (await fetch('/api/workspace')).json();
      const path = `/api/dots/${workspace.dots[0].id}/connections`;
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ChatGPTEE-Verification': 'private-mcp',
        },
        body: JSON.stringify({
          name: 'Private network boundary verification',
          url: 'http://127.0.0.1:4310/healthz',
        }),
      });
      const result = await response.json();
      const connections = await (await fetch(path)).json();
      return (
        response.status === 400 &&
        result.error.includes('private network') &&
        connections.length === 0
      );
    });
    if (!report.privateMcpBlocked)
      throw new Error(
        'Public wallet workspace did not block a private MCP URL.',
      );
  }
  await page
    .getByRole('button', { name: 'Open settings', exact: true })
    .click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/workspace-dark-desktop.png`,
  });
  await page
    .getByRole('button', { name: 'Open settings', exact: true })
    .click();
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  report.themeSwitching =
    (await page.locator('html').getAttribute('data-theme')) === 'light';
  await page
    .getByRole('button', { name: 'Edit specialist', exact: true })
    .click();
  await page.getByLabel('Role instructions', { exact: true }).waitFor();
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/dot-editor.png`,
  });
  report.dotEditorPreserved = true;
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Memories', exact: true }).click();
  await page.getByRole('button', { name: 'Add memory', exact: true }).click();
  await page
    .getByLabel('Preference or context', { exact: true })
    .fill('Keep explanations concise.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Keep explanations concise.', { exact: true }).waitFor();
  report.memoryCreated = true;
  await page
    .locator('.spaces-nav')
    .getByRole('button', { name: 'Everyday', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'New page', exact: true })
    .first()
    .click();
  await page
    .getByLabel('Page title', { exact: true })
    .fill('ChatGPTEE verification');
  await page
    .getByLabel('Page content', { exact: true })
    .fill('A private page saved through the existing editor.');
  await page.getByText('All changes saved', { exact: true }).waitFor();
  report.pageAutosaved = await page.evaluate(async () => {
    const workspace = await (await fetch('/api/workspace')).json();
    const pages = await (
      await fetch(`/api/spaces/${workspace.spaces[0].id}/pages`)
    ).json();
    return pages.some(
      (page: { title: string; content: string }) =>
        page.title === 'ChatGPTEE verification' &&
        page.content.includes('A private page saved'),
    );
  });
  if (!report.pageAutosaved)
    throw new Error('Saved page was missing from its workspace.');
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/spaces-editor.png`,
  });
  await page.getByRole('button', { name: 'ChatGPTEE', exact: true }).click();
  await page.getByLabel('Start a conversation', { exact: true }).waitFor();
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/workspace-light-desktop.png`,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByLabel('Start a conversation', { exact: true }).waitFor();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  report.mobileSingleHeader = (await page.locator('.topbar').count()) === 1;
  report.mobileHeaderBounds = await page.locator('.topbar').boundingBox();
  if (!report.mobileSingleHeader)
    throw new Error('Mobile workspace rendered duplicate headers.');
  const mobileViewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowElements: [...document.querySelectorAll('body *')]
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: element.getAttribute('class') ?? '',
          ariaLabel: element.getAttribute('aria-label'),
          left: bounds.left,
          right: bounds.right,
          width: bounds.width,
        };
      })
      .filter((element) => element.right > window.innerWidth + 0.5)
      .slice(0, 30),
  }));
  report.mobileViewport = mobileViewport;
  report.mobileFitsViewport =
    mobileViewport.scrollWidth <= mobileViewport.innerWidth;
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/workspace-mobile.png`,
  });
  await page
    .getByRole('button', { name: 'Open navigation', exact: true })
    .click();
  await page.screenshot({
    animations: 'disabled',
    path: `${directory}/mobile-navigation.png`,
  });
  await page
    .getByRole('button', { name: 'Close navigation', exact: true })
    .click();
  await page.setViewportSize({ width: 1440, height: 960 });
  if (process.env.VERIFY_CHAT === '1') {
    const assistantCount = await page
      .locator('.chat-transcript .chat-bubble.assistant')
      .count();
    await page
      .getByLabel('Start a conversation', { exact: true })
      .fill('What is 2 + 2? Reply with only the number.');
    await page
      .getByRole('button', { name: 'Start conversation', exact: true })
      .click();
    await page.waitForFunction(
      (previousCount) =>
        document.querySelectorAll('.chat-transcript .chat-bubble.assistant')
          .length > previousCount &&
        !document.querySelector('.chat-transcript .thinking') &&
        !document.querySelector('button[aria-label="Stop response"]'),
      assistantCount,
      { timeout: 90000 },
    );
    if (await page.locator('.chat-error[role="alert"]').count())
      throw new Error('The visible chat turn ended with an error.');
    const assistantReply = (
      await page
        .locator('.chat-transcript .chat-bubble.assistant')
        .last()
        .innerText()
    ).trim();
    report.liveChatReply = assistantReply;
    report.liveChatResponse = /^4[.!]?$/.test(assistantReply);
    if (!report.liveChatResponse)
      throw new Error('The final assistant message did not answer 2 + 2.');
    await page.screenshot({
      animations: 'disabled',
      path: `${directory}/live-chat.png`,
    });
    const scheduled = await page.evaluate(async () => {
      const workspace = await (await fetch('/api/workspace')).json();
      const response = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dotId: workspace.dots[0].id,
          title: 'Scheduled verification',
        }),
      });
      if (!response.ok)
        throw new Error('Could not create scheduled conversation.');
      const thread = await response.json();
      const taskResponse = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: thread.id,
          prompt: 'What is 3 + 5? Reply with only the number.',
        }),
      });
      if (!taskResponse.ok) throw new Error('Could not create scheduled task.');
      return taskResponse.json();
    });
    try {
      let detail;
      for (let attempt = 0; attempt < 180; attempt++) {
        detail = await page.evaluate(
          async (id: string) => (await fetch(`/api/tasks/${id}`)).json(),
          scheduled.id,
        );
        if (detail.task.status === 'completed') break;
        if (detail.task.status === 'failed')
          throw new Error('Scheduled task failed: ' + detail.task.error);
        await page.waitForTimeout(500);
      }
      if (detail.task.status !== 'completed')
        throw new Error('Scheduled task did not complete in 90 seconds.');
      report.scheduledTaskState = detail.task;
      report.scheduledResults = detail.runs.map(
        (run: { result: unknown; error: unknown }) => ({
          result: run.result,
          error: run.error,
        }),
      );
      report.liveScheduledTask =
        detail.runs[0]?.status === 'completed' &&
        detail.runs[0]?.finishedAt !== null &&
        detail.runs[0]?.error === null &&
        detail.runs[0]?.result?.sample === false &&
        /^8[.!]?$/.test(detail.runs[0]?.result?.text?.trim() ?? '');
      if (!report.liveScheduledTask)
        throw new Error(
          'The scheduled run did not return a completed live answer to 3 + 5.',
        );
    } finally {
      await page.evaluate(async (id: string) => {
        await fetch(`/api/tasks/${id}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel' }),
        });
      }, scheduled.id);
    }
  }
  await page.reload();
  await page.getByRole('button', { name: 'ChatGPTEE', exact: true }).waitFor();
  report.sessionRestored = true;
  report.nativeCookieAuthorizedBeforeLogout = await cookieAuthorized(
    sessionCookie,
    session.user.id,
  );
  if (!report.nativeCookieAuthorizedBeforeLogout)
    throw new Error(
      'The captured native cookie did not authorize its Neon user before logout.',
    );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .waitFor();
  report.logoutRevoked = await cookieRevoked(sessionCookie);
  if (!report.logoutRevoked)
    throw new Error(
      'The original native session cookie still authorized access after logout.',
    );
  report.privateApiBlocked = await page.evaluate(
    async () =>
      (
        await fetch('/api/state', {
          headers: { 'X-ChatGPTEE-Verification': 'private-api' },
        })
      ).status === 401,
  );
  if (!report.privateApiBlocked)
    throw new Error('Private APIs remained accessible after logout.');
  if (process.env.VERIFY_PRIVY !== '0') {
    await page.getByText('Sign in with Privy', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Continue with Privy', exact: true })
      .click();
    await page.getByRole('button', { name: /Phantom/ }).click();
    await page
      .getByRole('button', { name: 'ChatGPTEE', exact: true })
      .waitFor({ timeout: 60000 });
    report.privySignIn = true;
    const providerSession = await page.evaluate(async () =>
      (await fetch('/api/auth/session')).json(),
    );
    const providerCookie = await protectedSessionCookie('privySession');
    const providerIdentity = await fixtureIdentity();
    report.sameUserAcrossSignInMethods =
      providerSession.user?.id === session.user.id &&
      providerSession.user?.walletAddress === address &&
      providerSession.owner === false &&
      providerIdentity.row?.id === nativeIdentity.row?.id &&
      (!betterAuth ||
        (providerIdentity.betterAuthIds.length === 1 &&
          providerIdentity.betterAuthIds[0] ===
            nativeIdentity.betterAuthIds[0]));
    if (!report.sameUserAcrossSignInMethods)
      throw new Error(
        'Native and Privy sign-in resolved to different Neon identities.',
      );
    privyId = providerIdentity.privySubjects[0];
    report.privyIdentityStored = !!privyId;
    if (!report.privyIdentityStored)
      throw new Error(
        'Privy sign-in did not persist its verified provider identity.',
      );
    report.privyCookieAuthorizedBeforeLogout = await cookieAuthorized(
      providerCookie,
      session.user.id,
    );
    if (!report.privyCookieAuthorizedBeforeLogout)
      throw new Error(
        'The captured Privy cookie did not authorize its Neon user before logout.',
      );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page
      .getByRole('button', { name: 'Connect Solana wallet', exact: true })
      .waitFor();
    report.privyLogoutRevoked = await cookieRevoked(providerCookie);
    if (!report.privyLogoutRevoked)
      throw new Error(
        'The original Privy session cookie remained valid after logout.',
      );
  } else {
    report.privySignIn = 'pending supplied client allowed origins';
  }
  report.browserErrors = [...errors];
  if (errors.length)
    throw new Error('Browser logged errors during verification.');
} catch (error) {
  report.error =
    error instanceof Error
      ? safeDiagnostic(error.message)
      : 'Verification failed.';
  const pages = context.pages();
  if (pages[0]) {
    await pages[0].screenshot({
      path: `${directory}/verification-failure.png`,
    });
    writeFileSync(
      `${directory}/verification-failure.txt`,
      await pages[0].locator('body').innerText(),
    );
  }
  report.browserErrors = [...errors];
  process.exitCode = 1;
} finally {
  report.browserErrors = [...errors];
  report.networkFailures = networkFailures.map((failure) => ({ ...failure }));
  // Stop SDK callbacks before deleting the generated user's records.
  await context.close();
  await browser.close();
  // Remove only this randomly generated wallet's identity and dependent sessions.
  try {
    await cleanupFixture();
  } catch (error) {
    report.cleanupError =
      error instanceof Error
        ? safeDiagnostic(error.message)
        : 'Fixture cleanup failed.';
    process.exitCode = 1;
  }
  await db.close();
  writeFileSync(
    `${directory}/auth-browser-verification.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
}
