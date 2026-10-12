/** Disposable PostgreSQL + actual React app + temporary signing wallet. */
import { strict as assert } from 'node:assert';
import { chromium } from 'playwright';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import bs58 from 'bs58';
import { createHybridAuth } from '../src/server/better-auth.js';
import { PostgresUserDatabase } from '../src/server/user-database.js';
import { PrivyAuth } from '../src/server/privy-auth.js';
import { UserWorkspaces } from '../src/server/user-workspaces.js';
import type { SignInChallenge } from '../src/shared/auth-types.js';
const connection = process.env.HYBRID_TEST_POSTGRES_URL;
if (!connection)
  throw Error('A disposable HYBRID_TEST_POSTGRES_URL is required.');
const temp = mkdtempSync(join(tmpdir(), 'chatgptee-hybrid-browser-'));
const directory = 'artifacts/hybrid-auth';
mkdirSync(directory, { recursive: true });
const db = new PostgresUserDatabase(connection);
assert.equal(
  (
    await db.pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    )
  ).rowCount,
  0,
);
await db.initialize();
const app = new Hono();
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await once(server, 'listening');
const info = server.address();
if (!info || typeof info === 'string') throw Error('Missing fixture port');
const origin = 'http://127.0.0.1:' + info.port;
const hybrid = await createHybridAuth({
  users: db,
  stateDir: temp,
  origin,
  env: { NODE_ENV: 'development', PRIVY_SOCIAL_PROVIDERS: '' },
  privy: new PrivyAuth({ appId: 'fixture-app', appSecret: 'fixture-secret' }),
});
const workspaces = new UserWorkspaces(
  join(temp, 'users'),
  {
    model: 'fixture',
    baseUrl: 'https://invalid.example/v1',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  },
  [origin],
);
app.route('/api/auth', hybrid.routes);
app.all('/api/*', async (c) => {
  const user = await hybrid.user(c);
  return user
    ? workspaces.app(user).fetch(c.req.raw)
    : c.json({ error: 'Sign in.' }, 401);
});
const browserDist = process.env.HYBRID_BROWSER_DIST || './dist/client';
app.use('/*', serveStatic({ root: browserDist }));
app.get('*', serveStatic({ path: browserDist + '/index.html' }));
const pair = generateKeyPairSync('ed25519');
const publicKey = [
  ...pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
];
const address = bs58.encode(new Uint8Array(publicKey));
const browser = await chromium.launch({
  headless: true,
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const errors: string[] = [];
const checks: string[] = [];
try {
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('button', { name: /Continue with (Google|X|GitHub)/ })
      .count(),
    3,
  );
  assert.equal(
    await page
      .getByRole('button', { name: /Continue with Google/ })
      .isDisabled(),
    true,
  );
  assert.equal(
    await page.getByText('Sign in with Privy', { exact: true }).count(),
    1,
  );
  checks.push(
    'Both Privy and Better Auth choices appear; unconfigured social providers stay disabled',
  );
  await page.screenshot({
    path: directory + '/sign-in-desktop.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: directory + '/sign-in-mobile.png',
    animations: 'disabled',
  });
  checks.push('Mobile login fits without horizontal overflow');
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
  assert.equal(session.user.walletAddress, address);
  const cookie = (await context.cookies()).find(
    (x) => x.name === 'chatgptee.session_token',
  );
  assert(cookie?.httpOnly && cookie.sameSite === 'Lax');
  assert(
    !(await page.evaluate(() => document.cookie.includes('session_token'))),
  );
  checks.push(
    'Genuine temporary Ed25519 proof creates a private Better Auth cookie and workspace',
  );
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Your account', exact: true })
    .waitFor();
  await page.getByRole('button', { name: /Link Google/ }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: /Link (Google|X|GitHub)/ }).count(),
    3,
  );
  await page.screenshot({
    path: directory + '/account-desktop.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: directory + '/account-mobile.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  checks.push(
    'Account linking controls are available inside the authenticated workspace',
  );
  await page
    .getByRole('button', { name: 'Close account settings', exact: true })
    .click();
  await page.reload();
  await page.getByRole('button', { name: 'ChatGPTEE', exact: true }).waitFor();
  const restored = await page.evaluate(async () =>
    (await fetch('/api/auth/session')).json(),
  );
  assert.equal(restored.user.id, session.user.id);
  checks.push('Reload restores the same workspace identity');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(async () => (await fetch('/api/workspace')).status),
    401,
  );
  assert.equal(
    (await context.cookies()).some((x) => x.name === 'chatgptee.session_token'),
    false,
  );
  checks.push(
    'Sign-out removes the cookie and immediately blocks private workspace APIs',
  );
  assert.deepEqual(errors, []);
  const report = {
    passed: checks.length,
    checks,
    pageErrors: errors,
    scope:
      'Isolated PostgreSQL, temporary real wallet signatures, actual React app. Real Privy and social callbacks remain unverified.',
  };
  writeFileSync(
    directory + '/browser-check.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  workspaces.stopRunners();
  await workspaces.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  rmSync(temp, { recursive: true, force: true });
}
