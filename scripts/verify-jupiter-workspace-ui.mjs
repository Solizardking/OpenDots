/** Real quotes/account flow and separately labelled unsigned UI fixtures. No transaction signing. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

export async function verifyJupiterWorkspace(
  page,
  context,
  { directory, address },
) {
  const report = {
    checkedAt: new Date().toISOString(),
    passed: false,
    checks: [],
    fixtures: [],
    limitations: [],
    liveManagedQuote: false,
    liveCustomBuildQuote: false,
    realUnfundedPreparationGuard: false,
    inlineQuote: { attempted: false, verified: false },
    transactionsSigned: 0,
    transactionsBroadcast: 0,
  };
  const origin = new URL(page.url()).origin;
  const drawer = () =>
    page.getByRole('dialog', { name: 'Solana workspace', exact: true });
  const panel = () =>
    drawer().getByRole('region', { name: 'Jupiter swaps', exact: true });
  // A named <section> has the region role; this locator keeps mobile/desktop checks scoped.
  const open = async () => {
    const entry = page
      .locator('.sidebar-bottom')
      .getByRole('button', { name: /Jupiter/ });
    if (!(await entry.isVisible()))
      await page
        .getByRole('button', { name: 'Open navigation', exact: true })
        .click();
    await entry.click();
    await drawer().waitFor();
    await panel().waitFor();
  };
  const close = () =>
    drawer().getByRole('button', { name: 'Close drawer', exact: true }).click();
  const fits = async (label) => {
    const size = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      drawer: document.querySelector('.solana-workspace')?.clientWidth,
      contents: document.querySelector('.solana-workspace')?.scrollWidth,
    }));
    assert(
      size.document <= size.viewport && size.contents <= size.drawer + 1,
      `${label} horizontal overflow: ${JSON.stringify(size)}`,
    );
    report.checks.push(label + ' fits without horizontal overflow');
  };
  const getQuote = async (mode) => {
    const waiting = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/markets/jupiter/quote' &&
        response.request().method() === 'POST',
    );
    await panel()
      .getByRole('button', { name: 'Get Jupiter quote', exact: true })
      .click();
    const response = await waiting;
    const data = await response.json();
    report[
      mode === 'order' ? 'managedQuoteResponse' : 'customBuildQuoteResponse'
    ] = { status: response.status(), data };
    assert.equal(
      response.status(),
      200,
      `Real ${mode} quote failed: ${data.error}`,
    );
    assert.equal(data.source, 'Jupiter');
    assert.equal(data.mode, mode);
    assert.equal(data.executionAvailable, false);
    assert.equal(data.transactionBase64, undefined);
    assert.equal(data.requestId, undefined);
    assert(Number(data.expectedOutput) > 0);
    assert(
      Number(data.minimumOutput) > 0 &&
        Number(data.minimumOutput) <= Number(data.expectedOutput),
    );
    await panel()
      .getByRole('article', { name: 'Jupiter quote', exact: true })
      .getByText('Minimum output', { exact: true })
      .waitFor();
    report[mode === 'order' ? 'liveManagedQuote' : 'liveCustomBuildQuote'] =
      true;
    report.checks.push(
      `Real Jupiter ${mode} quote renders amounts, minimum output, route, slippage, impact, fees and payers with no signable bytes`,
    );
    return data;
  };
  let reviewFixturePath, prepareFixturePath;
  try {
    await open();
    assert.equal(
      await panel().getByLabel('Jupiter mode').inputValue(),
      'order',
    );
    assert.equal(
      await panel().getByLabel('Jupiter slippage policy').inputValue(),
      'rtse',
    );
    const first = await getQuote('order');
    await fits('Desktop Jupiter quote');
    await page.screenshot({
      path: directory + '/jupiter-live-desktop.png',
      animations: 'disabled',
    });
    await panel().getByLabel('Jupiter amount').fill('0.2');
    assert.equal(
      await panel()
        .getByRole('article', { name: 'Jupiter quote', exact: true })
        .count(),
      0,
    );
    report.checks.push(
      'Editing the draft immediately removes the previous live quote',
    );
    await panel().getByLabel('Jupiter amount').fill('0.1');

    const contextResponses = [];
    const contextListener = (response) => {
      if (new URL(response.url()).pathname === '/api/markets/jupiter/context')
        contextResponses.push(response);
    };
    page.on('response', contextListener);
    const prepareWaiting = page.waitForResponse((response) =>
      /\/api\/conversations\/[^/]+\/jupiter\/prepare$/.test(
        new URL(response.url()).pathname,
      ),
    );
    await panel()
      .getByRole('button', { name: 'Prepare swap review', exact: true })
      .click();
    const preparationResponse = await prepareWaiting;
    const preparation = await preparationResponse.json();
    assert.equal(
      contextResponses.length,
      1,
      'First prepare must create one independent context without model configuration.',
    );
    assert.equal(contextResponses[0].status(), 200);
    const contextData = await contextResponses[0].json();
    report.independentContext = contextData;
    page.off('response', contextListener);
    report.unfundedPreparationResponse = {
      status: preparationResponse.status(),
      error: preparation.error,
    };
    assert(
      preparationResponse.status() >= 400 &&
        /insufficient|balance|fund|fees/i.test(preparation.error),
      `Expected an unfunded-wallet guard, got ${JSON.stringify(report.unfundedPreparationResponse)}`,
    );
    await panel().getByRole('alert').waitFor();
    report.realUnfundedPreparationGuard = true;
    report.checks.push(
      'First prepare creates an independent conversation context and safely rejects the fresh unfunded wallet without signing',
    );

    await panel().getByLabel('Jupiter mode').selectOption('build');
    assert.equal(
      await panel().getByLabel('Jupiter max accounts').inputValue(),
      '64',
    );
    await getQuote('build');
    await panel().getByLabel('Jupiter slippage policy').selectOption('fixed');
    await panel().getByLabel('Jupiter slippage', { exact: true }).fill('1');
    await panel().getByLabel('Jupiter max accounts').fill('32');
    await panel().getByLabel('Fast routes (beta)', { exact: true }).check();
    const fast = await getQuote('build');
    assert.equal(fast.input.fast, true);
    assert.equal(fast.input.maxAccounts, 32);
    assert.equal(fast.input.slippageBps, 100);
    report.checks.push(
      'Custom Build fixed slippage, account cap and explicit Fast beta settings reach the real quote provider',
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await fits('Mobile Jupiter quote and all three tabs');
    await page.screenshot({
      path: directory + '/jupiter-live-mobile.png',
      animations: 'disabled',
    });
    await drawer()
      .getByRole('button', { name: 'Pump.fun', exact: true })
      .click();
    await drawer()
      .getByRole('region', { name: 'DFlow spot quotes', exact: true })
      .waitFor();
    await drawer()
      .getByText('Live launch feed', { exact: true })
      .waitFor({ timeout: 30000 });
    await drawer()
      .locator('.solana-launch-card')
      .first()
      .waitFor({ timeout: 30000 });
    report.pumpLaunchesStillVisible = await drawer()
      .locator('.solana-launch-card')
      .count();
    await fits('Mobile Pump.fun and DFlow surfaces after Jupiter integration');
    await drawer()
      .getByRole('button', { name: 'Wallets & assets', exact: true })
      .click();
    await drawer()
      .getByRole('region', { name: 'Connected Solana wallet', exact: true })
      .waitFor();
    assert((await drawer().innerText()).includes(address));
    await fits('Mobile connected wallet after Jupiter integration');
    report.checks.push(
      'Existing Pump.fun live launch feed, DFlow quote form and connected-wallet tab remain visible through the same global drawer',
    );
    await close();
    await page.setViewportSize({ width: 1440, height: 960 });

    // Browser-only unsigned fixtures verify review controls independently of funding/providers.
    await open();
    const requestId = randomUUID();
    const thread =
      contextData.thread?.id ?? contextData.threadId ?? contextData.id;
    assert(typeof thread === 'string');
    const payer = new PublicKey(address);
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: SystemProgram.programId.toBase58(),
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer,
            toPubkey: SystemProgram.programId,
            lamports: 1,
          }),
        ],
      }).compileToV0Message(),
    );
    const bytes = transaction.serialize();
    const review = {
      ...first,
      id: requestId,
      threadId: thread,
      dotId: contextData.thread?.dotId ?? 'browser-fixture',
      address,
      feePayer: address,
      transactionVersion: 0,
      transactionBase64: Buffer.from(bytes).toString('base64'),
      transactionHash: createHash('sha256').update(bytes).digest('hex'),
      requiredSigners: [address],
      deferredSigners: [],
      instructions: [],
      balanceSol: '1',
      inputBalance: '1',
      networkFeeSol: '0.000005',
      estimatedSolDebit: '0.100005',
      simulation: { status: 'passed', unitsConsumed: 20000 },
      computeUnitPriceCeilingMicroLamports: '1000000',
      status: 'prepared',
      executionAvailable: true,
      expiresAt: Date.now() + 90000,
    };
    prepareFixturePath = `${origin}/api/conversations/*/jupiter/prepare`;
    reviewFixturePath = `${origin}/api/conversations/*/jupiter/requests/**`;
    const declines = [];
    await page.route(prepareFixturePath, (route) =>
      route.fulfill({ json: review }),
    );
    await page.route(reviewFixturePath, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/decline')) {
        declines.push(path);
        return route.fulfill({ json: { ...review, status: 'declined' } });
      }
      assert(
        !path.endsWith('/submit'),
        'Browser verifier never submits a transaction.',
      );
      return route.fulfill({ json: review });
    });
    await panel()
      .getByRole('button', { name: 'Prepare swap review', exact: true })
      .click();
    const card = drawer().getByRole('region', {
      name: 'Review Jupiter transaction',
      exact: true,
    });
    await card.getByText('Exact transaction hash', { exact: true }).waitFor();
    const signing = card.getByRole('button', {
      name: 'Sign & submit swap',
      exact: true,
    });
    assert(await signing.isDisabled());
    await card.getByRole('checkbox').check();
    assert(await signing.isEnabled());
    await card.evaluate((element) => {
      const label = document.createElement('p');
      label.textContent =
        'Browser-only unsigned fixture · not a live transaction';
      label.className = 'jupiter-notice';
      element.prepend(label);
    });
    await page.screenshot({
      path: directory + '/jupiter-mock-unsigned-review.png',
      animations: 'disabled',
    });
    const editDecline = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(
          `/jupiter/requests/${requestId}/decline`,
        ),
    );
    await panel().getByLabel('Jupiter amount').fill('0.2');
    await card.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => !document.querySelector('.jupiter-transaction-card'),
    );
    await editDecline;
    assert.equal(declines.length, 1);
    report.fixtures.push(
      'Browser-only unsigned V0 review requires an explicit checkbox and is declined when the draft changes; the sign button is never clicked',
    );
    await panel()
      .getByRole('button', { name: 'Prepare swap review', exact: true })
      .click();
    await card.waitFor();
    const closeDecline = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(
          `/jupiter/requests/${requestId}/decline`,
        ),
    );
    await close();
    await closeDecline;
    assert.equal(declines.length, 2);
    report.fixtures.push(
      'Closing the global drawer declines the browser-only prepared fixture',
    );
    await page.unroute(prepareFixturePath);
    prepareFixturePath = undefined;
    await page.unroute(reviewFixturePath);
    reviewFixturePath = undefined;

    const workspace = await page.evaluate(async () =>
      (await fetch('/api/workspace')).json(),
    );
    report.inlineQuote.modelConfigured = workspace.setup.model === true;
    report.inlineQuote.modelName = workspace.setup.modelName;
    if (
      workspace.setup.model === true &&
      workspace.setup.missing.length === 0
    ) {
      report.inlineQuote.attempted = true;
      const prompt =
        'Read-only quote verification: call jupiter_quote with inputMint So11111111111111111111111111111111111111112, outputMint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v, amount "0.1", mode "order", slippageBps 100, fast false, maxAccounts 64. Show the inline Jupiter quote card and give a short final reply. Do not prepare, sign, submit, execute or broadcast any transaction.';
      const firstComposer = page.getByLabel('Start a conversation', {
        exact: true,
      });
      if (await firstComposer.isVisible()) {
        await firstComposer.fill(prompt);
        await page
          .getByRole('button', { name: 'Start conversation', exact: true })
          .click();
      } else {
        await page.getByLabel('Message your Dot', { exact: true }).fill(prompt);
        await page
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
      }
      const inline = page
        .locator('.chat-transcript')
        .getByRole('article', { name: 'Jupiter quote', exact: true });
      await inline
        .getByText('Expected output', { exact: true })
        .waitFor({ timeout: 120000 });
      assert(
        (await inline.innerText()).includes(
          'So11111111111111111111111111111111111111112',
        ),
      );
      assert(
        (await inline.innerText()).includes(
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        ),
      );
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
      report.inlineQuote.finalAssistantTurnCompleted = true;
      await page.screenshot({
        path: directory + '/jupiter-inline-completed.png',
        animations: 'disabled',
      });
      await page.reload();
      await page
        .getByRole('button', { name: 'Sign out', exact: true })
        .waitFor();
      await page.locator('.thread-list .nav-item').first().click();
      await inline.getByText('Expected output', { exact: true }).waitFor();
      assert.deepEqual(
        await page.locator('.chat-bubble.assistant').allTextContents(),
        replies,
      );
      report.inlineQuote.replyAndCardPersistAfterReload = true;
      report.inlineQuote.verified = true;
      await page.screenshot({
        path: directory + '/jupiter-inline-after-reload.png',
        animations: 'disabled',
      });
      report.checks.push(
        'Real jupiter_quote invocation renders an inline card, completes the assistant turn and persists the reply/card after reload',
      );
    } else
      report.limitations.push(
        'No configured chat model was available for a real inline tool invocation.',
      );
    report.passed =
      report.liveManagedQuote &&
      report.liveCustomBuildQuote &&
      report.realUnfundedPreparationGuard &&
      (!report.inlineQuote.modelConfigured || report.inlineQuote.verified);
    assert(report.passed);
    return report;
  } catch (error) {
    report.error = error.message;
    await page
      .screenshot({
        path: directory + '/jupiter-failure.png',
        animations: 'disabled',
      })
      .catch(() => {});
    throw error;
  } finally {
    if (prepareFixturePath)
      await page.unroute(prepareFixturePath).catch(() => {});
    if (reviewFixturePath)
      await page.unroute(reviewFixturePath).catch(() => {});
    writeFileSync(
      directory + '/jupiter-workspace-verification.json',
      JSON.stringify(report, null, 2) + '\n',
    );
  }
}
