import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CompanionState } from '../src/shared/desktop-types';
import {
  CHATGPTEE_CALL_NUMBER,
  type MessagingChannelStatus,
  type MessagingLink,
  type MessagingStatus,
} from '../src/shared/messaging-types';

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/client/api', () => ({ api: fixture.api }));
vi.mock('../src/client/Drawer', () => ({
  Drawer: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement('section', { 'aria-label': title }, children),
}));
import {
  MessagingChannels,
  messagingLinkUrl,
} from '../src/client/MessagingChannels';
import { PhoneActions } from '../src/client/PhoneActions';
import { PhoneDrawer } from '../src/client/PhoneDrawer';

let root: ReactTestRenderer | undefined;
let status: MessagingStatus;
const code = 'x'.repeat(32); // Test-only, never issued by a provider.
const link: MessagingLink = {
  platform: 'telegram',
  code,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  instruction: `Send /start ${code} from your own Telegram account.`,
  url: `https://t.me/ChatGPTEE_test_bot?start=${code}`,
};
const visible = () => JSON.stringify(root!.toJSON());
const controls = () => root!.root.findAllByType('button');
const button = (label: string) =>
  controls().find(
    (node) =>
      node.children
        .filter((child) => typeof child === 'string')
        .join('')
        .trim() === label,
  )!;
async function mount(dotId: string | undefined = 'dot-one') {
  await act(async () => {
    root = create(createElement(MessagingChannels, { dotId }));
  });
}
async function click(label: string) {
  await act(async () => {
    await button(label).props.onClick();
  });
}
function available(platform: 'telegram' | 'imessage' = 'telegram') {
  const channel = status.channels.find((item) => item.platform === platform)!;
  channel.configured = true;
  channel.available = true;
  channel.reason = 'Provider reachable. Link your account to begin.';
  if (platform === 'telegram') channel.botUsername = 'ChatGPTEE_test_bot';
  else channel.address = '+15555550123';
  return channel;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {});
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
  fixture.api.mockReset();
  status = {
    callNumber: CHATGPTEE_CALL_NUMBER,
    documentationVersion: 'Stable',
    channels: ['telegram', 'imessage'].map((platform) => ({
      platform: platform as 'telegram' | 'imessage',
      configured: false,
      available: false,
      linked: false,
      reason: 'Dedicated ChatGPTEE messaging setup is required.',
    })),
  };
  fixture.api.mockImplementation(async (path: string) => {
    if (path.startsWith('/messaging/status')) return structuredClone(status);
    if (path === '/messaging/link')
      return { ...link, expiresAt: new Date(Date.now() + 60000).toISOString() };
    if (path === '/messaging/unlink') {
      status.channels[0].linked = false;
      return structuredClone(status);
    }
    throw new Error(`Unexpected test route ${path}`);
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps the requested call number available separately from browser voice', async () => {
  const onStart = vi.fn();
  const onEnd = vi.fn();
  await act(async () => {
    root = create(
      createElement(PhoneActions, {
        canTalk: false,
        voiceStatus: 'idle',
        onStart,
        onEnd,
      }),
    );
  });
  const call = root!.root.findByType('a');
  expect(call.props.href).toBe('tel:+12564726195');
  expect(call.props['aria-label']).toBe('Call +1 (256) 472-6195');
  expect(visible()).toContain('+1 (256) 472-6195');
  expect(root!.root.findByType('button').props.disabled).toBe(true);
  expect(onStart).not.toHaveBeenCalled();
  expect(onEnd).not.toHaveBeenCalled();
  await act(async () =>
    root!.update(
      createElement(PhoneActions, {
        canTalk: true,
        voiceStatus: 'idle',
        onStart,
        onEnd,
      }),
    ),
  );
  await act(async () =>
    root!.root.findByProps({ 'aria-label': 'Talk in browser' }).props.onClick(),
  );
  expect(onStart).toHaveBeenCalledTimes(1);
  await act(async () =>
    root!.update(
      createElement(PhoneActions, {
        canTalk: false,
        voiceStatus: 'active',
        onStart,
        onEnd,
      }),
    ),
  );
  expect(
    root!.root.findByProps({ 'aria-label': 'End browser voice call' }).props
      .disabled,
  ).toBe(false);
  await act(async () => root!.root.findByType('button').props.onClick());
  expect(onEnd).toHaveBeenCalledTimes(1);
});

it('shows truthful unavailable channels without invented bot or text destinations', async () => {
  status.channels[0].configured = true;
  await mount();
  expect(visible()).toContain('Unavailable');
  expect(visible()).toContain('Not configured');
  expect(visible()).not.toContain('Ready');
  expect(button('Connect Telegram').props.disabled).toBe(true);
  expect(button('Connect iMessage').props.disabled).toBe(true);
  expect(root!.root.findAllByType('a')).toHaveLength(0);
  expect(
    fixture.api.mock.calls.every(([path]) =>
      String(path).startsWith('/messaging/status'),
    ),
  ).toBe(true);
});

it('requires a selected Dot and sends a scoped one-use link without marking it ready', async () => {
  available();
  await act(async () => {
    root = create(createElement(MessagingChannels, {}));
  });
  expect(button('Connect Telegram').props.disabled).toBe(true);
  await act(async () =>
    root!.update(createElement(MessagingChannels, { dotId: 'dot-one' })),
  );
  await click('Connect Telegram');
  expect(fixture.api).toHaveBeenCalledWith(
    '/messaging/link',
    'POST',
    { platform: 'telegram', dotId: 'dot-one' },
    expect.any(AbortSignal),
  );
  expect(visible()).toContain('Waiting for your message');
  expect(visible()).not.toContain('Ready');
  expect(root!.root.findByType('a').props.href).toBe(link.url);
  expect(
    fixture.api.mock.calls.filter(([path]) => path === '/messaging/link'),
  ).toHaveLength(1);
});

it('waits for server-confirmed identity and Dot binding, then allows explicit unlink', async () => {
  const channel = available();
  await mount();
  await click('Connect Telegram');
  Object.assign(channel, {
    linked: true,
    dotId: 'dot-one',
    dotName: 'Trading Dot',
    linkedIdentityMasked: '••••1234',
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(visible()).toContain('Ready');
  expect(visible()).toContain('••••1234');
  expect(visible()).toContain('Trading Dot');
  expect(visible()).not.toContain('Waiting for your message');
  await click('Unlink Telegram');
  expect(fixture.api).toHaveBeenCalledWith(
    '/messaging/unlink',
    'POST',
    { platform: 'telegram' },
    expect.any(AbortSignal),
  );
  expect(visible()).not.toContain('Ready');
  expect(button('Connect Telegram').props.disabled).toBe(false);
});

it('does not retain a stale ready state when provider status fails', async () => {
  Object.assign(available(), { linked: true, dotId: 'dot-one' });
  await mount();
  expect(visible()).toContain('Ready');
  fixture.api.mockRejectedValue(new Error('Provider status unavailable.'));
  await click('Refresh messaging status');
  expect(visible()).not.toContain('Ready');
  expect(visible()).toContain('Status unavailable');
  expect(root!.root.findByProps({ role: 'alert' }).children).toContain(
    'Provider status unavailable.',
  );
});

it('keeps a binding to another Dot distinct until a new inbound link confirms the selected Dot', async () => {
  const channel = available();
  Object.assign(channel, {
    linked: true,
    dotId: 'dot-other',
    dotName: 'Other Dot',
  });
  await mount();
  expect(visible()).toContain('Linked to another Dot');
  expect(visible()).not.toContain('Ready');
  await click('Link to selected Dot');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(visible()).toContain('Waiting for your message');
  channel.dotId = 'dot-one';
  channel.dotName = 'Selected Dot';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(visible()).toContain('Ready');
  expect(visible()).not.toContain('Waiting for your message');
});

it('expires link actions and clears private codes when the selected Dot changes', async () => {
  available();
  await mount();
  await click('Connect Telegram');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(61000);
  });
  expect(visible()).toContain('Link code expired');
  expect(root!.root.findAllByType('a')).toHaveLength(0);
  expect(visible()).not.toContain(code);
  await click('Create new link code');
  expect(visible()).toContain(code);
  await act(async () =>
    root!.update(createElement(MessagingChannels, { dotId: 'dot-two' })),
  );
  expect(visible()).not.toContain(code);
  expect(fixture.api.mock.calls.at(-1)?.[0]).toBe(
    '/messaging/status?dotId=dot-two',
  );
});

it('aborts and ignores a stale link result after Dot change or drawer unmount', async () => {
  available();
  const pending = deferred<MessagingLink>();
  fixture.api.mockImplementation(async (path: string) =>
    path === '/messaging/link' ? pending.promise : structuredClone(status),
  );
  await mount();
  await click('Connect Telegram');
  const actionSignal = fixture.api.mock.calls.find(
    ([path]) => path === '/messaging/link',
  )![3] as AbortSignal;
  await act(async () =>
    root!.update(createElement(MessagingChannels, { dotId: 'dot-two' })),
  );
  expect(actionSignal.aborted).toBe(true);
  await act(async () => pending.resolve(link));
  expect(visible()).not.toContain(code);
  const latestSignal = fixture.api.mock.calls.at(-1)![3] as AbortSignal;
  await act(async () => root!.unmount());
  root = undefined;
  expect(latestSignal.aborted).toBe(true);
  const calls = fixture.api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(fixture.api.mock.calls).toHaveLength(calls);
});

it('only opens a verified channel destination and never borrows the call number', () => {
  const telegram: MessagingChannelStatus = {
    platform: 'telegram',
    configured: true,
    available: true,
    linked: false,
    reason: '',
    botUsername: 'ChatGPTEE_test_bot',
  };
  expect(messagingLinkUrl(telegram, link)).toBe(link.url);
  expect(
    messagingLinkUrl(telegram, { ...link, url: 'https://t.me/Clawdvibe_bot' }),
  ).toBeUndefined();
  expect(
    messagingLinkUrl(telegram, {
      ...link,
      url: 'https://t.me.evil.test/ChatGPTEE_test_bot',
    }),
  ).toBeUndefined();
  expect(
    messagingLinkUrl(telegram, { ...link, url: 'javascript:alert(1)' }),
  ).toBeUndefined();
  const imessage: MessagingChannelStatus = {
    ...telegram,
    platform: 'imessage',
    address: '+15555550123',
  };
  const textLink = {
    ...link,
    platform: 'imessage' as const,
    url: 'sms:+15555550123?body=LINK%20test',
  };
  expect(messagingLinkUrl(imessage, textLink)).toBe(textLink.url);
  expect(
    messagingLinkUrl(imessage, {
      ...textLink,
      url: `sms:${CHATGPTEE_CALL_NUMBER}?body=test`,
    }),
  ).toBeUndefined();
  expect(
    messagingLinkUrl({ ...imessage, address: undefined }, textLink),
  ).toBeUndefined();
});

it('preserves Mac pairing links beside the explicit call and messaging controls on web', async () => {
  await act(async () => {
    root = create(
      createElement(PhoneDrawer, { dotId: 'dot-one', onClose: vi.fn() }),
    );
  });
  const hrefs = root!.root.findAllByType('a').map((node) => node.props.href);
  expect(hrefs).toContain('tel:+12564726195');
  expect(hrefs).toContain('https://app.chatgptee.ai/download');
  expect(hrefs).toContain('https://chatgptee.ai/pair');
  expect(visible()).toContain('Pair from the Mac app');
  expect(visible()).toContain('Text your Dot');
});

it('keeps desktop phone access and device revoke controls without enabling or pairing automatically', async () => {
  const state: CompanionState = {
    enabled: true,
    keepAwake: true,
    urls: ['http://192.168.1.2:3000'],
    pairing: null,
    remote: { connected: true, id: 'test-mac', origin: 'https://chatgptee.ai' },
    devices: [
      {
        id: 'phone-test',
        name: 'My phone',
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
    ],
  };
  const companion = vi.fn(async () => state);
  vi.stubGlobal('window', { solanaDots: { companion } });
  await act(async () => {
    root = create(
      createElement(PhoneDrawer, { dotId: 'dot-one', onClose: vi.fn() }),
    );
  });
  expect(visible()).toContain('Turn off Phone access');
  expect(button('Create pairing code').props.disabled).toBe(false);
  expect(
    root!.root.findByProps({ 'aria-label': 'Revoke My phone' }),
  ).toBeTruthy();
  expect(companion.mock.calls).toEqual([['state']]);
});
