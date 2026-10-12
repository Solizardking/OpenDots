/** Called by the real-account registration verifier. Live and fixture checks stay distinct. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export async function verifySolanaWorkspace(
  page,
  context,
  { directory, address, alternateAddress, quoteUsesLocalFixture = false },
) {
  const report = {
    checkedAt: new Date().toISOString(),
    checks: [],
    fixtures: [],
    limitations: [],
    liveRelayStatus: false,
    liveLaunchesObserved: 0,
    liveDflowQuote: false,
    transactionsSigned: 0,
    transactionsBroadcast: 0,
    approvedTransactions: 0,
  };
  const origin = new URL(page.url()).origin;
  const session = () =>
    page.evaluate(async () => (await fetch('/api/auth/session')).json());
  const accountId = (await session()).user.id;
  await page.evaluate(() => {
    const originalClose = WebSocket.prototype.close;
    const closing = new Set();
    window.registrationRelayCloseStates = () =>
      [...closing].map((socket) => socket.readyState);
    WebSocket.prototype.close = function (...args) {
      if (this.url === 'wss://clawd-ws.fly.dev/ws') closing.add(this);
      return Reflect.apply(originalClose, this, args);
    };
  });
  const sockets = [];
  const onSocket = (socket) => {
    if (socket.url() !== 'wss://clawd-ws.fly.dev/ws') return;
    const record = {
      fixture: false,
      closed: false,
      statuses: [],
      launches: [],
    };
    sockets.push(record);
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString());
        if (frame.type === 'status')
          record.statuses.push(frame.connected === true);
        if (frame.type === 'token-launch')
          record.launches.push({ mint: frame.mint, symbol: frame.symbol });
      } catch {
        /* Ignore malformed public feed frames. */
      }
    });
    socket.on('close', () => {
      record.closed = true;
    });
  };
  page.on('websocket', onSocket);
  const open = async () => {
    const button = page
      .locator('.sidebar-bottom')
      .getByRole('button', { name: /Pump\.fun/ });
    if (!(await button.isVisible()))
      await page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .click();
    await button.click();
    await page
      .getByRole('dialog', { name: 'Solana workspace', exact: true })
      .waitFor();
  };
  const drawer = () =>
    page.getByRole('dialog', { name: 'Solana workspace', exact: true });
  const close = () =>
    drawer().getByRole('button', { name: 'Close drawer', exact: true }).click();
  const fits = async (label) => {
    const size = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      drawer: document.querySelector('.solana-workspace')?.clientWidth,
      drawerContent: document.querySelector('.solana-workspace')?.scrollWidth,
    }));
    assert(
      size.document <= size.viewport,
      `${label} overflows the viewport (${size.document}/${size.viewport}).`,
    );
    assert(
      size.drawerContent <= size.drawer + 1,
      `${label} content overflows its drawer (${size.drawerContent}/${size.drawer}).`,
    );
    report.checks.push(label + ' fits without horizontal overflow');
  };
  try {
    await open();
    await drawer()
      .getByText('Live launch feed', { exact: true })
      .waitFor({ timeout: 30000 });
    await drawer()
      .locator('.solana-launch-card')
      .first()
      .waitFor({ timeout: 30000 });
    report.liveRelayStatus = sockets.some((socket) =>
      socket.statuses.includes(true),
    );
    const realLaunches = sockets.flatMap((socket) => socket.launches);
    report.liveLaunchesObserved = realLaunches.length;
    report.liveLaunchExamples = realLaunches.slice(0, 3);
    assert(report.liveRelayStatus && report.liveLaunchesObserved > 0);
    await fits('Desktop Pump.fun drawer');
    await page.screenshot({
      path: directory + '/pump-live-desktop.png',
      animations: 'disabled',
    });
    report.checks.push(
      'Sidebar opens the global Pump.fun drawer with a real connected relay and real launches',
    );
    report.livePumpTokenInspection = false;
    report.pumpInspectionAttempts = [];
    let transactionContext;
    if (!quoteUsesLocalFixture) {
      const availableMints = await drawer()
        .locator('.solana-launch-card .solana-mint code')
        .allTextContents();
      for (const mint of availableMints.slice(0, 2)) {
        const item = drawer()
          .locator('.solana-launch-card')
          .filter({
            has: page.locator('.solana-mint code', { hasText: mint }),
          });
        const contextReady = transactionContext
          ? undefined
          : page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname ===
                  '/api/markets/pump/context' &&
                response.request().method() === 'POST',
            );
        await item
          .getByRole('button', { name: 'Review trade', exact: true })
          .click();
        if (contextReady) {
          const contextHttp = await contextReady;
          assert.equal(contextHttp.status(), 200);
          transactionContext = await contextHttp.json();
          assert(transactionContext.id);
        }
        await drawer().getByLabel('Pump token mint', { exact: true }).waitFor();
        assert.equal(
          await drawer()
            .getByLabel('Pump token mint', { exact: true })
            .inputValue(),
          mint,
        );
        const inspectedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname.endsWith(
              `/connected/token/${mint}`,
            ) && response.request().method() === 'GET',
          { timeout: 30000 },
        );
        await drawer()
          .getByRole('button', { name: 'Inspect coin & balance', exact: true })
          .click();
        const inspectedHttp = await inspectedResponse;
        const inspected = await inspectedHttp.json();
        report.pumpInspectionAttempts.push({
          mint,
          status: inspectedHttp.status(),
          ...(inspectedHttp.ok()
            ? {}
            : { error: inspected.error || 'Unavailable' }),
        });
        if (inspectedHttp.ok()) {
          assert.equal(inspected.mint, mint);
          assert.equal(inspected.address, address);
          assert(['Pump bonding curve', 'PumpSwap'].includes(inspected.venue));
          assert(Number.isInteger(inspected.decimals));
          assert(Number.isInteger(inspected.quoteDecimals));
          assert(inspected.quoteMint && inspected.quoteLabel);
          assert(/^\d+(?:\.\d+)?$/.test(inspected.balance));
          assert(/^\d+(?:\.\d+)?$/.test(inspected.solBalance));
          await drawer()
            .locator('.pump-token-info')
            .filter({ hasText: inspected.venue })
            .waitFor();
          report.livePumpTokenInspection = true;
          report.livePumpToken = inspected;
          await page.screenshot({
            path: directory + '/pump-mainnet-token-inspection.png',
            animations: 'disabled',
          });
          report.checks.push(
            'A real feed launch opens trade inspection with current mainnet venue, decimals, quote asset and wallet balances',
          );
        }
        await drawer()
          .getByRole('button', { name: 'Close Pump.fun', exact: true })
          .click();
        if (report.livePumpTokenInspection) break;
      }
      if (!report.livePumpTokenInspection)
        report.limitations.push(
          'Real Pump token inspection failed for two observed launch mints; see pumpInspectionAttempts.',
        );
    }
    const contextResponse = transactionContext
      ? undefined
      : page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/markets/pump/context' &&
            response.request().method() === 'POST',
        );
    await drawer()
      .getByRole('button', { name: 'Launch or trade', exact: true })
      .click();
    if (contextResponse) {
      const prepared = await contextResponse;
      assert.equal(prepared.status(), 200);
      transactionContext = await prepared.json();
    }
    assert(transactionContext.id);
    report.transactionContextCreated = true;
    await drawer().getByLabel('Pump coin name', { exact: true }).waitFor();
    report.checks.push(
      'Launch/trade creates a transaction context without sending a chat or model request',
    );
    await drawer()
      .getByRole('button', { name: 'Close Pump.fun', exact: true })
      .click();
    const quoteForm = drawer().getByRole('region', {
      name: 'DFlow spot quotes',
      exact: true,
    });
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    await quoteForm.getByLabel('DFlow token mint', { exact: true }).fill(mint);
    const quoteResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/markets/dflow/quote' &&
        response.request().method() === 'POST',
    );
    await quoteForm
      .getByRole('button', { name: 'Get fresh quote', exact: true })
      .click();
    const quoteHttp = await quoteResponse;
    const quoteData = await quoteHttp.json();
    report.liveDflowStatus = quoteHttp.status();
    if (quoteHttp.ok()) {
      await quoteForm
        .getByRole('article', { name: 'DFlow quote', exact: true })
        .waitFor();
      assert.equal(quoteData.source, 'DFlow');
      assert.equal(quoteData.executionAvailable, false);
      assert.equal(quoteData.mint, mint);
      assert.equal(quoteData.side, 'buy');
      assert.equal(
        quoteData.inputMint,
        'So11111111111111111111111111111111111111112',
      );
      assert.equal(quoteData.outputMint, mint);
      assert.equal(quoteData.inAmount, '100000000');
      assert.equal(quoteData.slippageBps, 50);
      assert(BigInt(quoteData.outAmount) > 0n);
      assert(BigInt(quoteData.minimumOutput) <= BigInt(quoteData.outAmount));
      assert(quoteData.platformFeeBps > 0 && quoteData.platformFeeBps <= 1000);
      assert(/^\d+(?:\.\d+)?$/.test(quoteData.platformFeeSol));
      assert(
        quoteData.observedAt <= Date.now() &&
          Date.now() - quoteData.observedAt < 10000,
      );
      assert(quoteData.expiresAt > Date.now());
      report.liveDflowQuote = !quoteUsesLocalFixture;
      report.quoteUsesLocalFixture = quoteUsesLocalFixture;
      report.liveQuote = {
        mint: quoteData.mint,
        inputAmount: quoteData.inAmount,
        outputAmount: quoteData.outAmount,
        minimumOutput: quoteData.minimumOutput,
        observedAt: quoteData.observedAt,
        expiresAt: quoteData.expiresAt,
        platformFeeSol: quoteData.platformFeeSol,
        platformFeeBps: quoteData.platformFeeBps,
      };
      await page.screenshot({
        path:
          directory +
          (quoteUsesLocalFixture
            ? '/dflow-fixture-quote.png'
            : '/dflow-live-quote.png'),
        animations: 'disabled',
      });
      if (quoteUsesLocalFixture)
        report.fixtures.push(
          'Local preflight provider fixture displays a fresh quote and its fees',
        );
      else
        report.checks.push(
          'DFlow form displays fresh real provider amounts and fees',
        );
      await quoteForm
        .getByLabel('DFlow quote amount', { exact: true })
        .fill('0.2');
      await quoteForm
        .getByRole('article', { name: 'DFlow quote', exact: true })
        .waitFor({ state: 'hidden' });
      report.checks.push('Editing the amount removes the previous DFlow quote');
    } else
      report.limitations.push(
        `Real DFlow quote failed (${quoteHttp.status()}): ${quoteData.error || 'Unavailable'}`,
      );
    const failureRoute = async (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: 'UI fixture: DFlow provider unavailable. Please retry.',
        },
      });
    await page.route('**/api/markets/dflow/quote', failureRoute);
    await quoteForm
      .getByRole('button', { name: 'Get fresh quote', exact: true })
      .click();
    await quoteForm
      .getByRole('alert')
      .filter({
        hasText: 'UI fixture: DFlow provider unavailable. Please retry.',
      })
      .waitFor();
    assert.equal(
      await quoteForm
        .getByRole('article', { name: 'DFlow quote', exact: true })
        .count(),
      0,
    );
    report.fixtures.push(
      'Injected provider503 is shown visibly and does not preserve a stale quote',
    );
    await page.unroute('**/api/markets/dflow/quote', failureRoute);
    await close();
    await page.waitForFunction(
      () => !document.querySelector('.solana-workspace'),
    );
    for (
      let attempt = 0;
      attempt < 100 && sockets.some((socket) => !socket.closed);
      attempt++
    )
      await page.waitForTimeout(100);
    const closeStates = await page.evaluate(() =>
      window.registrationRelayCloseStates(),
    );
    report.relayCleanup = {
      observedSockets: sockets.length,
      closeRequests: closeStates.length,
      nativeStates: closeStates,
      completedHandshakes: sockets.filter((socket) => socket.closed).length,
    };
    assert(sockets.length > 0 && closeStates.length > 0);
    assert(
      closeStates.every((state) => state === 2 || state === 3),
      'Unmount must leave its native relay socket closing or closed.',
    );
    const countAfterClose = sockets.length;
    await page.waitForTimeout(2000);
    assert.equal(
      sockets.length,
      countAfterClose,
      'Unmount must not reconnect the relay.',
    );
    report.liveRelayClientCleanup = true;
    report.checks.push(
      'Closing the drawer invokes native socket close and prevents relay reconnects',
    );
    let mockSocket,
      mockOpened = 0,
      mockClosed = 0;
    await page.routeWebSocket('wss://clawd-ws.fly.dev/ws', (socket) => {
      mockSocket = socket;
      mockOpened++;
      report.fixtureSocketsOpened = mockOpened;
      socket.onClose(() => {
        mockClosed++;
        report.fixtureSocketsClosed = mockClosed;
      });
      setTimeout(() => {
        try {
          socket.send(JSON.stringify({ type: 'status', connected: true }));
          socket.send(
            JSON.stringify({
              type: 'token-launch',
              mint: '7omrj8qc8ahqTF2vEuJKZkBTmunrFYxybE2ytJyCpump',
              name: 'UI fixture Alpha',
              symbol: 'QA-A',
              hasGithub: true,
              marketCapSol: 2,
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'token-launch',
              mint: '6WH8G9fBvo5HNkxkcD5Agf6eqD15YXK24o8qDkTiV5R4',
              name: 'UI fixture Beta',
              symbol: 'QA-B',
              hasGithub: false,
              marketCapSol: 3,
            }),
          );
        } catch {
          /* StrictMode may have already closed its first socket. */
        }
      }, 150);
    });
    // Playwright injects WebSocket routing when the document starts.
    await page.reload();
    await page.getByRole('button', { name: 'Sign out', exact: true }).waitFor();
    await page.waitForFunction(
      (address) =>
        [...document.querySelectorAll('.wallet-adapter-button')].some(
          (button) => button.textContent?.includes(address.slice(0, 4)),
        ),
      address,
    );
    await open();
    await drawer().getByText('UI fixture Alpha', { exact: true }).waitFor();
    assert.equal(await drawer().locator('.solana-launch-card').count(), 2);
    await drawer()
      .getByLabel('Search Pump.fun launches', { exact: true })
      .fill('Alpha');
    assert.equal(await drawer().locator('.solana-launch-card').count(), 1);
    await drawer().getByLabel('Has GitHub', { exact: true }).check();
    assert.equal(await drawer().locator('.solana-launch-card').count(), 1);
    await drawer()
      .getByLabel('Search Pump.fun launches', { exact: true })
      .fill('Beta');
    await drawer()
      .getByText('No launches match these filters.', { exact: true })
      .waitFor();
    await drawer().getByLabel('Has GitHub', { exact: true }).uncheck();
    assert.equal(await drawer().locator('.solana-launch-card').count(), 1);
    await drawer()
      .getByLabel('Search Pump.fun launches', { exact: true })
      .fill('');
    report.fixtures.push(
      'Deterministic launch fixtures verify name search and the GitHub filter independently',
    );
    await drawer()
      .getByLabel('Search Pump.fun launches', { exact: true })
      .fill('Alpha');
    await drawer().getByLabel('Has GitHub', { exact: true }).check();
    const beforePause = mockClosed;
    await drawer()
      .getByRole('button', { name: 'Pause feed', exact: true })
      .click();
    await drawer().getByText('Feed paused', { exact: true }).waitFor();
    for (let attempt = 0; attempt < 20 && mockClosed === beforePause; attempt++)
      await page.waitForTimeout(100);
    assert(mockClosed > beforePause);
    const beforeResume = mockOpened;
    await drawer()
      .getByRole('button', { name: 'Resume feed', exact: true })
      .click();
    await drawer().getByText('Live launch feed', { exact: true }).waitFor();
    assert(mockOpened > beforeResume);
    assert.equal(
      await drawer()
        .getByLabel('Search Pump.fun launches', { exact: true })
        .inputValue(),
      'Alpha',
    );
    assert(
      await drawer().getByLabel('Has GitHub', { exact: true }).isChecked(),
    );
    assert.equal(await drawer().locator('.solana-launch-card').count(), 1);
    await drawer()
      .getByLabel('Search Pump.fun launches', { exact: true })
      .fill('');
    await drawer().getByLabel('Has GitHub', { exact: true }).uncheck();
    report.fixtures.push(
      'Pause closes the socket and Resume reconnects without losing filters',
    );
    await drawer()
      .getByRole('button', { name: 'Launch or trade', exact: true })
      .click();
    await drawer()
      .getByLabel('Pump coin name', { exact: true })
      .fill('UI fixture Coin');
    await drawer().getByLabel('Pump coin symbol', { exact: true }).fill('QA');
    await drawer()
      .getByLabel('Pump metadata URI', { exact: true })
      .fill('https://example.com/ui-fixture.json');
    let review,
      declined = 0,
      approved = 0;
    await page.route('**/pump/connected/launch', (route) => {
      review = {
        id: randomUUID(),
        threadId: transactionContext.id,
        dotId: transactionContext.dotId,
        walletId: 'browser',
        walletName: 'UI fixture connected wallet',
        address,
        signerMode: 'connected',
        status: 'prepared',
        network: 'solana-mainnet',
        kind: 'launch',
        name: 'UI fixture Coin',
        symbol: 'QA',
        uri: 'https://example.com/ui-fixture.json',
        venue: 'Pump bonding curve',
        mint: '7omrj8qc8ahqTF2vEuJKZkBTmunrFYxybE2ytJyCpump',
        quoteMint: 'So11111111111111111111111111111111111111112',
        quoteLabel: 'SOL',
        inputAmount: '0',
        expectedOutput: '0',
        minimumOutput: '0',
        maximumQuote: '0',
        slippageBps: 100,
        networkFeeSol: '0.000005',
        estimatedSolDebit: '0.015',
        balanceSol: '1',
        expiresAt: Date.now() + 90000,
        lastValidBlockHeight: 999999999,
        transactionBase64: 'UI fixture only; never signed',
        transactionHash: 'a'.repeat(64),
        instructions: [],
      };
      return route.fulfill({ json: review });
    });
    await page.route('**/pump/requests/*', (route) =>
      route.fulfill({ json: review }),
    );
    await page.route('**/pump/requests/*/decline', (route) => {
      declined++;
      review.status = 'declined';
      return route.fulfill({ json: review });
    });
    await page.route(
      /\/pump\/requests\/[^/]+\/(?:approve|submit)$/,
      (route) => {
        approved++;
        return route.abort();
      },
    );
    await drawer()
      .getByRole('button', { name: 'Prepare for review', exact: true })
      .click();
    const card = drawer().getByRole('region', {
      name: 'Review Pump.fun transaction',
      exact: true,
    });
    const approve = card.getByRole('button', {
      name: 'Review in wallet & submit',
      exact: true,
    });
    await approve.waitFor();
    assert(await approve.isDisabled());
    await card
      .getByLabel(
        'I reviewed the wallet, token, amounts and mainnet transaction',
        { exact: true },
      )
      .check();
    assert(await approve.isEnabled());
    await page.screenshot({
      path: directory + '/pump-review-fixture-desktop.png',
      animations: 'disabled',
    });
    await drawer()
      .getByLabel('Pump coin name', { exact: true })
      .fill('UI fixture edited');
    await card.waitFor({ state: 'hidden' });
    for (let attempt = 0; attempt < 20 && declined === 0; attempt++)
      await page.waitForTimeout(100);
    assert.equal(declined, 1);
    assert.equal(approved, 0);
    report.fixtures.push(
      'Mock unsigned launch review requires explicit review; editing the draft declines and invalidates it without approval',
    );
    await drawer()
      .getByRole('button', { name: 'Close Pump.fun', exact: true })
      .click();
    const walletTab = drawer()
      .getByRole('group', { name: 'Solana workspace section', exact: true })
      .getByRole('button', { name: 'Wallets & assets', exact: true });
    await walletTab.click();
    const wallet = drawer().getByRole('region', {
      name: 'Connected Solana wallet',
      exact: true,
    });
    await wallet.getByText('Account wallet:', { exact: false }).waitFor();
    await page.evaluate(() => window.registrationSwitchTradingWallet());
    report.fixtureWalletState = await page.evaluate(() =>
      window.registrationFixtureState(),
    );
    await wallet
      .getByText(
        'You are using a different wallet for transaction signing. Your account stays the same.',
        { exact: false },
      )
      .waitFor();
    assert.equal((await session()).user.id, accountId);
    assert(
      (await wallet.innerText()).includes(address) &&
        (await wallet.innerText()).includes(alternateAddress),
    );
    if (!quoteUsesLocalFixture) {
      const actualBalance = await page.evaluate(async (address) => {
        const response = await fetch(
          `/api/markets/pump/wallet/${encodeURIComponent(address)}/balance`,
        );
        return { status: response.status, data: await response.json() };
      }, alternateAddress);
      report.connectedWalletBalance = actualBalance;
      if (actualBalance.status === 200) {
        assert.equal(actualBalance.data.address, alternateAddress);
        assert.equal(actualBalance.data.network, 'solana-mainnet');
        assert(/^\d+$/.test(actualBalance.data.lamports));
        await wallet
          .getByText(`${actualBalance.data.balanceSol} SOL`, { exact: true })
          .waitFor();
        report.checks.push(
          'The connected wallet panel displays its actual mainnet balance through the private server proxy',
        );
      } else {
        report.limitations.push(
          `Connected wallet mainnet balance failed (${actualBalance.status}): ${actualBalance.data.error || 'Unavailable'}`,
        );
      }
    }
    await fits('Desktop connected-wallet drawer');
    await page.screenshot({
      path: directory + '/wallet-account-vs-signing.png',
      animations: 'disabled',
    });
    await wallet
      .getByRole('button', { name: 'Disconnect wallet', exact: true })
      .click();
    assert.equal((await session()).user.id, accountId);
    await wallet
      .getByRole('button', { name: /^(?:Connect|Select Wallet)$/ })
      .click();
    const walletChoice = page
      .getByRole('dialog')
      .filter({ has: page.getByRole('button', { name: /Phantom/ }) });
    if (await walletChoice.isVisible())
      await walletChoice.getByRole('button', { name: /Phantom/ }).click();
    await wallet
      .getByRole('button', { name: 'Disconnect wallet', exact: true })
      .waitFor();
    report.checks.push(
      'Wallet tab distinguishes account and transaction wallet; switch/disconnect preserve the account',
    );
    await page.evaluate(() => window.registrationResetTradingWallet());
    await close();
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await drawer().getByText('UI fixture Alpha', { exact: true }).waitFor();
    await fits('Mobile Pump.fun drawer');
    await page.screenshot({
      path: directory + '/pump-fixture-mobile.png',
      animations: 'disabled',
    });
    await drawer()
      .getByRole('group', { name: 'Solana workspace section', exact: true })
      .getByRole('button', { name: 'Wallets & assets', exact: true })
      .click();
    await drawer()
      .getByRole('heading', { name: 'Your Solana wallet', exact: true })
      .waitFor();
    await fits('Mobile connected-wallet drawer');
    await page.screenshot({
      path: directory + '/wallet-mobile.png',
      animations: 'disabled',
    });
    await close();
    await page.setViewportSize({ width: 1440, height: 960 });
    report.passed = report.limitations.length === 0;
    report.reviewUiUsesFixtures = true;
    report.providerFailureUiUsesFixture = true;
    report.feedFilterUiUsesFixtures = true;
    if (report.limitations.length) throw Error(report.limitations.join('; '));
    return report;
  } catch (error) {
    report.passed = false;
    report.error = error.message;
    await page
      .screenshot({
        path: directory + '/solana-workspace-failure.png',
        animations: 'disabled',
      })
      .catch(() => {});
    throw error;
  } finally {
    page.off('websocket', onSocket);
    writeFileSync(
      directory + '/solana-workspace-verification.json',
      JSON.stringify(report, null, 2) + '\n',
    );
  }
}
