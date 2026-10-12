/** Normal-host registration, real temporary wallet proofs, session reload and revocation.
 * No environment file/database credentials, persisted keys or transaction approvals.
 */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import bs58 from 'bs58';
import { verifySolanaWorkspace } from './verify-solana-workspace-ui.mjs';
import { verifyJupiterWorkspace } from './verify-jupiter-workspace-ui.mjs';
import { verifyMessagingUi } from './verify-messaging-ui.mjs';
import { verifyOpenMarketWorkspace } from './verify-openmarket-workspace.mjs';

const origin = new URL(
  process.env.REGISTRATION_ORIGIN || 'https://chatgptee.ai',
).origin;
const directory =
  process.env.REGISTRATION_ARTIFACTS || 'artifacts/registration-live';
const requireEntry = process.env.REGISTRATION_REQUIRE_ENTRY !== '0';
const verifyPrivy = process.env.REGISTRATION_VERIFY_PRIVY !== '0';
mkdirSync(directory, { recursive: true });
const pair = generateKeyPairSync('ed25519');
const publicKey = [
  ...pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
];
const address = bs58.encode(new Uint8Array(publicKey));
const alternatePublicKey = [
  ...generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32),
];
const alternateAddress = bs58.encode(new Uint8Array(alternatePublicKey));
const counters = {
  authenticationMessagesSigned: 0,
  transactionSignatureAttempts: 0,
  transactionBroadcastAttempts: 0,
};
const report = {
  checkedAt: new Date().toISOString(),
  origin,
  passed: false,
  allRequestedChecksPassed: false,
  freshWallet: address,
  privateKeyPersisted: false,
  existingCustomerWalletUsed: false,
  environmentFileRead: false,
  browserConfigOverrides: false,
  holderGateRequired: false,
  transactionsSigned: 0,
  transactionsBroadcast: 0,
  responses: [],
  pageErrors: [],
  checks: [],
  limitations: [],
};
if (
  process.env.REGISTRATION_EXPECTED_RELEASE_ID ||
  process.env.REGISTRATION_EXPECTED_SOURCE_HASH
) {
  report.releaseIdentity = {};
  for (const [surface, path] of [
    ['frontend', '/opendots-release.json'],
    ['backend', '/healthz'],
  ]) {
    const response = await fetch(origin + path, {
      headers: { 'Cache-Control': 'no-cache' },
    });
    assert.equal(response.status, 200);
    const identity = await response.json();
    if (process.env.REGISTRATION_EXPECTED_RELEASE_ID)
      assert.equal(
        identity.releaseId,
        process.env.REGISTRATION_EXPECTED_RELEASE_ID,
      );
    if (process.env.REGISTRATION_EXPECTED_SOURCE_HASH)
      assert.equal(
        identity.sourceHash,
        process.env.REGISTRATION_EXPECTED_SOURCE_HASH,
      );
    report.releaseIdentity[surface] = {
      releaseId: identity.releaseId,
      sourceHash: identity.sourceHash,
    };
  }
}
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 960 },
});
const diagnostic = (value) =>
  String(value)
    .replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        return url.origin + url.pathname;
      } catch {
        return '[redacted URL]';
      }
    })
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted token]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted API key]');
const signAuthentication = (bytes) => {
  const message = Buffer.from(bytes).toString();
  assert(
    bytes.length <= 4096 &&
      message.includes(new URL(origin).hostname) &&
      /sign in|sign-in/i.test(message),
    'Fixture signs only an origin-bound authentication message.',
  );
  counters.authenticationMessagesSigned++;
  return [...sign(null, Buffer.from(bytes), pair.privateKey)];
};
await context.exposeFunction('registrationSignMessage', signAuthentication);
await context.exposeFunction('registrationSignIn', (input) => {
  assert.equal(input.domain, new URL(origin).host);
  const message = createSignInMessageText({ ...input, address });
  const bytes = [...new TextEncoder().encode(message)];
  return { message: bytes, signature: signAuthentication(bytes) };
});
await context.exposeFunction('registrationBlockTransaction', (send) => {
  if (send) counters.transactionBroadcastAttempts++;
  else counters.transactionSignatureAttempts++;
  throw Error(
    'Registration verification never signs or broadcasts transactions.',
  );
});
await context.addInitScript(
  ({ address, publicKey, alternateAddress, alternatePublicKey, icon }) => {
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
    let selectedAccount = account;
    let accounts = [];
    const listeners = new Set();
    const notify = () =>
      listeners.forEach((listener) => listener({ accounts }));
    window.registrationSwitchTradingWallet = () => {
      selectedAccount = {
        ...account,
        address: alternateAddress,
        publicKey: new Uint8Array(alternatePublicKey),
      };
      accounts = [selectedAccount];
      notify();
    };
    window.registrationResetTradingWallet = () => {
      selectedAccount = account;
      if (accounts.length) {
        accounts = [account];
        notify();
      }
    };
    window.registrationDisconnectTradingWallet = () => {
      accounts = [];
      notify();
    };
    window.registrationFixtureState = () => ({
      selectedAddress: selectedAccount.address,
      accounts: accounts.map((value) => value.address),
      listeners: listeners.size,
    });
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
            accounts = [selectedAccount];
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
          on: (_event, listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        'solana:signMessage': {
          version: '1.0.0',
          signMessage: async (...inputs) =>
            Promise.all(
              inputs.map(async (input) => ({
                signedMessage: input.message,
                signature: new Uint8Array(
                  await window.registrationSignMessage([...input.message]),
                ),
                signatureType: 'ed25519',
              })),
            ),
        },
        'solana:signIn': {
          version: '1.0.0',
          signIn: async (...inputs) =>
            Promise.all(
              inputs.map(async (input) => {
                const result = await window.registrationSignIn(input);
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
        'solana:signTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signTransaction: () => window.registrationBlockTransaction(false),
        },
        'solana:signAndSendTransaction': {
          version: '1.0.0',
          supportedTransactionVersions: ['legacy', 0],
          signAndSendTransaction: () =>
            window.registrationBlockTransaction(true),
        },
      },
    };
    // Register after the shell mounts so development StrictMode cleanup does
    // not destroy the initial adapter's Wallet Standard event subscription.
    let ready = false;
    const pendingApis = new Set();
    const register = (api) => {
      if (ready) api.register(wallet);
      else pendingApis.add(api);
    };
    window.addEventListener('wallet-standard:app-ready', (event) =>
      register(event.detail),
    );
    setTimeout(() => {
      ready = true;
      pendingApis.forEach((api) => api.register(wallet));
      window.dispatchEvent(
        new CustomEvent('wallet-standard:register-wallet', {
          detail: register,
        }),
      );
    }, 1000);
  },
  {
    address,
    publicKey,
    alternateAddress,
    alternatePublicKey,
    icon:
      'data:image/svg+xml;base64,' +
      readFileSync('public/brand/solana-logomark.svg').toString('base64'),
  },
);
const page = await context.newPage();
page.on('pageerror', (error) =>
  report.pageErrors.push(diagnostic(error.message)),
);
page.on('response', async (response) => {
  const url = new URL(response.url());
  if (
    (url.origin === origin && url.pathname.startsWith('/api/auth/')) ||
    /\/siws\/(init|authenticate)$/.test(url.pathname)
  ) {
    const item = {
      hostname: url.hostname,
      path: url.pathname,
      method: response.request().method(),
      status: response.status(),
    };
    report.responses.push(item);
    if (url.pathname.endsWith('/siws/authenticate') && response.ok()) {
      const data = await response.json().catch(() => ({}));
      report.newPrivyAccountCreated =
        data.is_new_user ?? data.new_user ?? data.newUser;
    }
  }
});
const session = () =>
  page.evaluate(async () => (await fetch('/api/auth/session')).json());
const privateStatus = () =>
  page.evaluate(async () => (await fetch('/api/workspace')).status);
const cookieContract = async (label) => {
  const cookie = (await context.cookies()).find((value) =>
    /chatgptee\.session_token$/.test(value.name),
  );
  assert(
    cookie?.httpOnly && cookie.sameSite === 'Lax' && cookie.path === '/',
    'Private application cookie must be HttpOnly and SameSite Lax.',
  );
  assert(cookie.secure === (new URL(origin).protocol === 'https:'));
  report[label + 'Cookie'] = {
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: cookie.path,
    remainingLifetimeSeconds: Math.round(cookie.expires - Date.now() / 1000),
  };
  assert(
    !(await page.evaluate(() => document.cookie.includes('session_token'))),
    'Application session credential cannot be read by JavaScript.',
  );
  return cookie;
};
const logout = async (cookie) => {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .waitFor();
  assert.equal((await session()).user, null);
  assert.equal(await privateStatus(), 401);
  const replay = await fetch(origin + '/api/auth/session', {
    headers: { Origin: origin, Cookie: cookie.name + '=' + cookie.value },
  });
  assert.equal(replay.status, 200);
  assert.equal(
    (await replay.json()).user,
    null,
    'The previous session must be revoked server-side.',
  );
};
try {
  for (const path of ['/register', '/signup', '/login', '/signin']) {
    const response = await page.goto(origin + path);
    assert.equal(response.status(), 200);
    await page
      .getByRole('button', { name: 'Connect Solana wallet', exact: true })
      .waitFor();
    if (requireEntry && ['/register', '/signup'].includes(path))
      await page
        .getByRole('heading', { name: 'Create your account.', exact: true })
        .waitFor();
    if (requireEntry && ['/login', '/signin'].includes(path))
      await page
        .getByRole('link', { name: 'Create an account', exact: true })
        .waitFor();
  }
  report.checks.push(
    'Registration and sign-in aliases load through the normal hostname',
  );
  await page.goto(origin + '/register');
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .waitFor();
  const config = await page.evaluate(async () =>
    (await fetch('/api/auth/config')).json(),
  );
  report.publicConfig = {
    privyAppId: config.privyAppId,
    privyClientId: config.privyClientId,
    betterAuth: config.betterAuth,
    privySocialProviders: config.privySocialProviders,
  };
  assert.equal(config.betterAuth, true);
  assert.equal((await session()).user, null);
  assert.equal(await privateStatus(), 401);
  for (const label of ['Google', 'X', 'GitHub'])
    await page
      .getByRole('button', {
        name:
          process.env.REGISTRATION_UI_PREFLIGHT === '1'
            ? new RegExp('^Continue with ' + label)
            : 'Continue with ' + label,
        exact: true,
      })
      .waitFor();
  await page.screenshot({
    path: directory + '/register-desktop.png',
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.screenshot({
    path: directory + '/register-mobile.png',
    animations: 'disabled',
  });
  report.checks.push(
    'Public desktop and mobile registration exposes wallet and social sign-in choices',
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await page
    .getByRole('button', { name: 'Connect Solana wallet', exact: true })
    .click();
  await page.getByRole('button', { name: /Phantom/ }).click();
  await page
    .getByRole('button', {
      name: requireEntry
        ? 'Create account with this wallet'
        : 'Sign in with this wallet',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Sign out', exact: true })
    .waitFor({ timeout: 60000 });
  const native = await session();
  assert.equal(native.user?.walletAddress, address);
  assert.equal(native.owner, false);
  assert.equal(await privateStatus(), 200);
  const nativeCookie = await cookieContract('native');
  report.account = {
    id: native.user.id,
    walletAddress: native.user.walletAddress,
    owner: native.owner,
  };
  report.checks.push(
    'A newly generated wallet creates an authenticated private workspace without a holding requirement',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.waitForFunction(
    (address) =>
      [...document.querySelectorAll('.wallet-adapter-button')].some(
        (button) =>
          button.textContent?.includes(address.slice(0, 4)) &&
          button.textContent?.includes(address.slice(-4)),
      ),
    address,
  );
  assert.equal((await session()).user?.id, native.user.id);
  await page.screenshot({
    path: directory + '/workspace-after-reload.png',
    animations: 'disabled',
  });
  report.checks.push(
    'Reload restores the same authenticated account and workspace',
  );
  if (process.env.REGISTRATION_VERIFY_OPENMARKET === '1') {
    report.openMarket = await verifyOpenMarketWorkspace(page, {directory});
    report.checks.push('Authenticated OpenMarket desktop/mobile flow and live provider states verified');
  }
  if (process.env.REGISTRATION_VERIFY_MESSAGING === '1') {
    report.messaging = await verifyMessagingUi(page, { directory });
    report.checks.push(
      'Phone call destination, separate browser voice, account messaging guards and truthful unavailable desktop/mobile UI passed',
    );
  }
  if (process.env.REGISTRATION_VERIFY_SOLANA_WORKSPACE === '1') {
    report.solanaWorkspace = await verifySolanaWorkspace(page, context, {
      directory,
      address,
      alternateAddress,
      quoteUsesLocalFixture: process.env.REGISTRATION_UI_PREFLIGHT === '1',
    });
    report.checks.push(
      'Global Solana workspace desktop/mobile, relay, quotes and explicitly marked review fixtures passed',
    );
  }
  if (process.env.REGISTRATION_VERIFY_JUPITER === '1') {
    report.jupiterWorkspace = await verifyJupiterWorkspace(page, context, {
      directory,
      address,
    });
    report.checks.push(
      'Jupiter real quotes, independent unfunded-wallet guard, inline completion/persistence and labelled review fixtures passed',
    );
  }
  if (
    process.env.REGISTRATION_VERIFY_SOLANA_WORKSPACE === '1' ||
    process.env.REGISTRATION_VERIFY_INLINE_QUOTE === '1'
  ) {
    const workspace = await page.evaluate(async () =>
      (await fetch('/api/workspace')).json(),
    );
    report.inlineDflowQuote = {
      attempted: false,
      verified: false,
      verificationScope: 'Real tool invocation and inline quote rendering',
      finalAssistantTurnCompletionVerified: false,
      explicitModelCancellationVerified: false,
      modelConfigured: workspace.setup.model === true,
      modelName: workspace.setup.modelName,
      missing: workspace.setup.missing,
    };
    if (
      workspace.setup.model === true &&
      workspace.setup.missing.length === 0
    ) {
      report.inlineDflowQuote.attempted = true;
      try {
        const prompt =
          'Read-only quote verification: call dflow_quote with mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, side buy, amount "0.1", slippageBps 100, and show the inline DFlow quote card. Do not prepare, sign, submit or broadcast any transaction.';
        const firstComposer = page.getByLabel('Start a conversation', {
          exact: true,
        });
        if (await firstComposer.isVisible()) {
          await firstComposer.fill(prompt);
          await page
            .getByRole('button', { name: 'Start conversation', exact: true })
            .click();
        } else {
          await page
            .getByLabel('Message your Dot', { exact: true })
            .fill(prompt);
          await page
            .getByRole('button', { name: 'Send message', exact: true })
            .click();
        }
        const inlineCard = page
          .locator('.chat-transcript')
          .getByRole('article', { name: 'DFlow quote', exact: true });
        await inlineCard
          .getByText('Estimated output', { exact: true })
          .waitFor({ timeout: 120000 });
        assert.equal(
          (await inlineCard.locator('code').innerText()).trim(),
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        );
        const value = async (label) =>
          (
            await inlineCard
              .getByText(label, { exact: true })
              .locator('..')
              .locator('dd')
              .innerText()
          ).trim();
        assert.equal(await value('Input'), '0.1 SOL');
        assert.equal(await value('Slippage'), '1%');
        assert(
          await inlineCard
            .getByText('Quote preview', { exact: true })
            .isVisible(),
        );
        const estimated = Number.parseFloat(await value('Estimated output'));
        const minimum = Number.parseFloat(await value('Minimum output'));
        assert(estimated > 0 && minimum > 0 && minimum <= estimated);
        assert((await inlineCard.innerText()).includes('Minimum output'));
        const fee = await inlineCard
          .getByText('Platform fee', { exact: true })
          .locator('..')
          .innerText();
        assert(/\d+(?:\.\d+)? SOL \(\d+(?:\.\d+)?%, included\)/.test(fee));
        report.inlineDflowQuote.displayedFee = fee;
        await page.screenshot({
          path: directory + '/gpt-inline-dflow-quote.png',
          animations: 'disabled',
        });
        report.inlineDflowQuote.verified = true;
        report.checks.push(
          'A real read-only chat request invokes dflow_quote and renders an inline quote card',
        );
        if (process.env.REGISTRATION_VERIFY_INLINE_COMPLETION === '1') {
          await page
            .getByRole('button', { name: 'Stop response', exact: true })
            .waitFor({ state: 'hidden', timeout: 120000 });
          await page
            .getByRole('button', { name: 'Send message', exact: true })
            .waitFor();
          assert.equal(await page.locator('.chat-error').count(), 0);
          const replies = await page
            .locator('.chat-bubble.assistant')
            .allTextContents();
          assert(replies.some((reply) => reply.trim().length > 0));
          report.inlineDflowQuote.finalAssistantReplies =
            replies.map(diagnostic);
          report.inlineDflowQuote.finalAssistantTurnCompletionVerified = true;
          await page.screenshot({
            path: directory + '/inline-quote-completed-turn.png',
            animations: 'disabled',
          });
          report.checks.push(
            'The real quote turn finishes with an assistant reply and restores the send control',
          );
          await page.reload();
          await page
            .getByRole('button', { name: 'Sign out', exact: true })
            .waitFor();
          assert.equal((await session()).user.id, native.user.id);
          await page.locator('.thread-list .nav-item').first().click();
          await page
            .locator('.chat-transcript')
            .getByRole('article', { name: 'DFlow quote', exact: true })
            .getByText('Estimated output', { exact: true })
            .waitFor();
          assert.deepEqual(
            (
              await page.locator('.chat-bubble.assistant').allTextContents()
            ).map(diagnostic),
            report.inlineDflowQuote.finalAssistantReplies,
          );
          report.inlineDflowQuote.replyAndCardPersistAfterReload = true;
          await page.screenshot({
            path: directory + '/inline-quote-after-reload.png',
            animations: 'disabled',
          });
          report.checks.push(
            'Reload reopens the saved quote card and completed assistant reply in the same account',
          );
        }
      } catch (error) {
        report.inlineDflowQuote.reason = diagnostic(error.message);
        report.inlineDflowQuote.visibleErrors = (
          await page.getByRole('alert').allTextContents()
        ).map(diagnostic);
        await page.screenshot({
          path: directory + '/gpt-inline-dflow-limitation.png',
          animations: 'disabled',
        });
      }
    } else {
      report.inlineDflowQuote.reason =
        'The account platform reports no configured chat model; no model credentials were added.';
    }
    if (!report.inlineDflowQuote.verified)
      report.limitations.push(
        'Inline GPT quote was not verified: ' + report.inlineDflowQuote.reason,
      );
  }
  await page.evaluate(() => window.registrationSwitchTradingWallet());
  report.fixtureWalletState = await page.evaluate(() =>
    window.registrationFixtureState(),
  );
  await page.waitForFunction(
    (address) =>
      [...document.querySelectorAll('.wallet-adapter-button')].some(
        (button) =>
          button.textContent?.includes(address.slice(0, 4)) &&
          button.textContent?.includes(address.slice(-4)),
      ),
    alternateAddress,
  );
  assert.equal((await session()).user?.id, native.user.id);
  assert.equal(await privateStatus(), 200);
  await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
  await page.evaluate(() => window.registrationDisconnectTradingWallet());
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.wallet-adapter-button')].some((button) =>
      /^(?:Connect|Select Wallet)$/.test(button.textContent?.trim() || ''),
    ),
  );
  assert.equal((await session()).user?.id, native.user.id);
  assert.equal(await privateStatus(), 200);
  report.checks.push(
    'Switching and disconnecting a transaction wallet preserves the authenticated account',
  );
  await page.evaluate(() => window.registrationResetTradingWallet());
  await logout(nativeCookie);
  report.checks.push(
    'Sign-out revokes the original cookie and blocks private workspace APIs',
  );
  if (process.env.REGISTRATION_VERIFY_MESSAGING === '1') {
    const privateMessagingStatuses = await page.evaluate(async () => {
      const statuses = [];
      for (const [path, method, body] of [
        ['/api/messaging/status', 'GET'],
        [
          '/api/messaging/link',
          'POST',
          {
            platform: 'telegram',
            dotId: '00000000-0000-4000-8000-000000000001',
          },
        ],
        ['/api/messaging/unlink', 'POST', { platform: 'telegram' }],
      ]) {
        const response = await fetch(path, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }),
        });
        statuses.push(response.status);
      }
      return statuses;
    });
    assert.deepEqual(privateMessagingStatuses, [401, 401, 401]);
    report.checks.push(
      'Sign-out also blocks private messaging status, link and unlink APIs',
    );
  }
  if (verifyPrivy) {
    await page.getByText('Sign in with Privy', { exact: true }).click();
    await page
      .getByRole('button', { name: 'Continue with Privy', exact: true })
      .click();
    await page.getByRole('button', { name: /Phantom/ }).click();
    await page
      .getByRole('button', { name: 'Sign out', exact: true })
      .waitFor({ timeout: 60000 });
    const privy = await session();
    assert.equal(privy.user?.id, native.user.id);
    assert.equal(privy.user?.walletAddress, address);
    assert.equal(privy.owner, false);
    const privyCookie = await cookieContract('privy');
    await page.reload();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    assert.equal((await session()).user?.id, native.user.id);
    report.realPrivyWalletCallback = true;
    report.checks.push(
      'Real Privy wallet callback and reload preserve the same native-wallet workspace',
    );
    await logout(privyCookie);
    report.checks.push(
      'Privy-backed application session is also revoked on sign-out',
    );
  }
  assert.equal(counters.transactionSignatureAttempts, 0);
  assert.equal(counters.transactionBroadcastAttempts, 0);
  assert.deepEqual(report.pageErrors, []);
  report.socialCallbacksVerified = false;
  report.passed = true;
  report.allRequestedChecksPassed =
    (!report.inlineDflowQuote || report.inlineDflowQuote.verified) &&
    (process.env.REGISTRATION_VERIFY_INLINE_COMPLETION !== '1' ||
      (report.inlineDflowQuote?.finalAssistantTurnCompletionVerified &&
        report.inlineDflowQuote?.replyAndCardPersistAfterReload)) &&
    (!report.solanaWorkspace ||
      (report.solanaWorkspace.liveDflowQuote &&
        report.solanaWorkspace.livePumpTokenInspection)) &&
    (!report.jupiterWorkspace || report.jupiterWorkspace.passed) &&
    (!report.messaging || report.messaging.passed);
} catch (error) {
  report.error = diagnostic(error.message);
  await page
    .screenshot({ path: directory + '/failure.png', animations: 'disabled' })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  report.walletCounters = counters;
  await context.close();
  await browser.close();
  writeFileSync(
    directory + '/registration-verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  writeFileSync(
    directory + '/registration-verification.md',
    `# Registration verification\n\nChecked: ${report.checkedAt}\n\nOrigin: ${origin}\n\nResult: ${report.passed ? 'Passed' : 'Failed'}\n\n${report.checks.map((check) => '- ' + check).join('\n')}\n\nOnly newly generated, in-memory wallet authentication signatures were used. No transaction was signed or broadcast. Social OAuth account callbacks remain unverified. No database credentials were used; the disposable test account remains registered.\n${report.limitations.length ? '\nLimitations:\n' + report.limitations.map((value) => '- ' + value).join('\n') + '\n' : ''}${report.error ? '\nFailure: ' + report.error + '\n' : ''}`,
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      allRequestedChecksPassed: report.allRequestedChecksPassed,
      inlineDflowQuote: report.inlineDflowQuote,
      checks: report.checks,
      walletCounters: counters,
      error: report.error,
      evidence: directory + '/registration-verification.json',
    }),
  );
}
