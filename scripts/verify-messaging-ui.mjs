/** Normal account UI/status proof. Never activates telephone, SMS or Telegram links. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

export async function verifyMessagingUi(page, { directory }) {
  const report = {
    checkedAt: new Date().toISOString(),
    passed: false,
    checks: [],
    fixtures: [],
    limitations: [
      'Dedicated ChatGPTEE Spectrum project and Telegram bot credentials are not configured. Real inbound linking and outbound replies remain unverified.',
      'Telephone, SMS and Telegram links were inspected without activating them. No call or text was sent.',
      'Desktop pairing controls are covered by focused tests; this normal browser verification preserves the Mac download/pair links without pairing a device.',
    ],
    callsPlaced: 0,
    textsSent: 0,
    liveProviderLinksRedeemed: 0,
  };
  const callLabel = 'Call +1 (256) 472-6195';
  const drawer = () =>
    page.getByRole('dialog', { name: 'Phone & messaging', exact: true });
  const open = async () => {
    const control = page.getByRole('button', {
      name: 'Open phone and messaging',
      exact: true,
    });
    await control.click();
    await drawer().waitFor();
  };
  const close = () =>
    drawer().getByRole('button', { name: 'Close drawer', exact: true }).click();
  const request = (path, method = 'GET', body) =>
    page.evaluate(
      async ({ path, method, body }) => {
        const response = await fetch('/api' + path, {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }),
        });
        return { status: response.status, data: await response.json() };
      },
      { path, method, body },
    );
  const fits = async (label) => {
    const sizes = await page.evaluate(() => {
      const panel = document.querySelector('.dots-drawer');
      const toolbar = document.querySelector('.chat-persona-actions');
      return {
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
        drawer: panel?.clientWidth,
        contents: panel?.scrollWidth,
        toolbarLeft: toolbar?.getBoundingClientRect().left,
        toolbarRight: toolbar?.getBoundingClientRect().right,
      };
    });
    assert(
      sizes.document <= sizes.viewport,
      `${label} document overflow: ${JSON.stringify(sizes)}`,
    );
    if (sizes.drawer)
      assert(
        sizes.contents <= sizes.drawer + 1,
        `${label} drawer overflow: ${JSON.stringify(sizes)}`,
      );
    if (sizes.toolbarRight)
      assert(
        sizes.toolbarLeft >= 0 && sizes.toolbarRight <= sizes.viewport + 1,
        `${label} phone toolbar exceeds viewport: ${JSON.stringify(sizes)}`,
      );
    report.checks.push(label + ' fits without horizontal overflow');
  };
  try {
    const workspace = await request('/workspace');
    assert.equal(workspace.status, 200);
    const dotId = workspace.data.dots[0]?.id;
    assert(dotId, 'The fresh account must have a selectable Dot.');
    const state = await request(
      `/messaging/status?dotId=${encodeURIComponent(dotId)}`,
    );
    assert.equal(state.status, 200);
    assert.equal(state.data.callNumber, '+12564726195');
    assert.equal(state.data.documentationVersion, 'Stable');
    assert.deepEqual(
      state.data.channels.map((channel) => channel.platform).sort(),
      ['imessage', 'telegram'],
    );
    for (const channel of state.data.channels) {
      assert.equal(
        channel.configured,
        false,
        'This release must honestly report dedicated provider setup missing.',
      );
      assert.equal(channel.available, false);
      assert.equal(channel.linked, false);
      assert.equal(channel.botUsername, undefined);
      assert.equal(channel.address, undefined);
      const denied = await request('/messaging/link', 'POST', {
        platform: channel.platform,
        dotId,
      });
      assert.equal(denied.status, 503);
      assert.equal(denied.data.code, undefined);
      report.checks.push(
        `${channel.platform} link request safely returns unavailable without issuing a code`,
      );
      const unlinked = await request('/messaging/unlink', 'POST', {
        platform: channel.platform,
      });
      assert.equal(unlinked.status, 200);
      assert.equal(
        unlinked.data.channels.find(
          (item) => item.platform === channel.platform,
        ).linked,
        false,
      );
    }
    report.actualStatus = state.data;
    const foreignDot = randomUUID();
    assert.equal(
      (await request(`/messaging/status?dotId=${foreignDot}`)).status,
      404,
    );
    assert.equal(
      (
        await request('/messaging/link', 'POST', {
          platform: 'telegram',
          dotId: foreignDot,
        })
      ).status,
      404,
    );
    report.checks.push(
      'Messaging status and link APIs reject a Dot outside the current account workspace',
    );

    await open();
    const call = drawer().getByRole('link', { name: callLabel, exact: true });
    assert.equal(await call.getAttribute('href'), 'tel:+12564726195');
    await drawer()
      .getByRole('region', { name: 'Account messaging', exact: true })
      .getByText('Not configured', { exact: true })
      .first()
      .waitFor();
    for (const platform of ['Telegram', 'iMessage']) {
      const channel = drawer().getByRole('article', {
        name: `${platform} messaging`,
        exact: true,
      });
      assert(
        await channel
          .getByRole('button', { name: `Connect ${platform}`, exact: true })
          .isDisabled(),
      );
      assert.equal(
        await channel.getByText('Ready', { exact: true }).count(),
        0,
      );
      assert.equal(await channel.getByRole('link').count(), 0);
    }
    assert.equal(
      await drawer()
        .getByRole('link', { name: 'Pair your Mac ↗', exact: true })
        .getAttribute('href'),
      'https://chatgptee.ai/pair',
    );
    assert.equal(
      await drawer()
        .getByRole('link', { name: 'Get Solana Dots for Mac ↗', exact: true })
        .getAttribute('href'),
      'https://app.chatgptee.ai/download',
    );
    await fits('Desktop phone and messaging');
    await page.screenshot({
      path: directory + '/phone-messaging-desktop.png',
      animations: 'disabled',
    });
    await close();

    const newChat = page
      .getByRole('button', { name: 'New chat', exact: true })
      .first();
    assert(
      await newChat.isEnabled(),
      'Existing configured chat platform is required for the conversation toolbar proof; no model request is sent.',
    );
    await newChat.click();
    const toolbar = page.locator('.chat-persona-actions');
    await toolbar.getByRole('link', { name: callLabel, exact: true }).waitFor();
    assert.equal(
      await toolbar
        .getByRole('link', { name: callLabel, exact: true })
        .getAttribute('href'),
      'tel:+12564726195',
    );
    await toolbar
      .getByRole('button', { name: 'Talk in browser', exact: true })
      .waitFor();
    report.browserVoiceAvailable = await toolbar
      .getByRole('button', { name: 'Talk in browser', exact: true })
      .isEnabled();
    report.checks.push(
      'Chat header displays the requested telephone link and a separate browser microphone action',
    );
    await fits('Desktop chat phone toolbar');
    await page.screenshot({
      path: directory + '/phone-chat-desktop.png',
      animations: 'disabled',
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await fits('Mobile chat phone toolbar');
    await page.screenshot({
      path: directory + '/phone-chat-mobile.png',
      animations: 'disabled',
    });
    await open();
    assert.equal(
      await drawer()
        .getByRole('link', { name: callLabel, exact: true })
        .getAttribute('href'),
      'tel:+12564726195',
    );
    await fits('Mobile phone and messaging');
    await page.screenshot({
      path: directory + '/phone-messaging-mobile.png',
      animations: 'disabled',
    });
    await close();
    await page.setViewportSize({ width: 1440, height: 960 });
    report.checks.push(
      'Actual unconfigured provider status renders disabled account-link controls on desktop and mobile; no external messaging destination is invented',
    );
    report.passed = true;
    return report;
  } catch (error) {
    report.error = error.message;
    await page
      .screenshot({
        path: directory + '/phone-messaging-failure.png',
        animations: 'disabled',
      })
      .catch(() => {});
    throw error;
  } finally {
    writeFileSync(
      directory + '/phone-messaging-verification.json',
      JSON.stringify(report, null, 2) + '\n',
    );
  }
}
