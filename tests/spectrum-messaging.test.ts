import { afterEach, expect, it, vi } from 'vitest';
import type { Spectrum, Space, Message } from '@spectrum-ts/core';
import {
  SpectrumMessagingTransport,
  spectrumMessagingConfig,
  spectrumSdkFactory,
  normalizeSpectrumMessage,
  type SpectrumMessagingConfig,
  type SpectrumIncomingMessage,
  type SpectrumRuntime,
} from '../src/server/spectrum-messaging';

const PROJECT = '01234567-89ab-4cde-8f01-23456789abcd';
const token = `123456:${'a'.repeat(32)}`;
const config: SpectrumMessagingConfig = {
  enabled: true,
  projectId: PROJECT,
  projectSecret: 'fixture-project-secret',
  telegram: {
    botToken: token,
    expectedBotUsername: 'ChatGPTEE_bot',
    webhookSecret: 'fixture-webhook-secret',
    registrationApproved: true,
  },
  imessage: {
    lineMode: 'dedicated',
    phone: '+15551112222',
    lineOwnershipConfirmed: true,
  },
};
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const queued: SpectrumIncomingMessage[] = [],
    waiting: ((value: IteratorResult<SpectrumIncomingMessage>) => void)[] = [];
  let closed = false;
  const runtime: SpectrumRuntime = {
    providers: [
      {
        platform: 'telegram',
        configured: true,
        available: true,
        reason: 'Ready',
        botUsername: 'ChatGPTEE_bot',
      },
      {
        platform: 'imessage',
        configured: true,
        available: true,
        reason: 'Ready',
        address: '+15551112222',
      },
    ],
    messages: {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            queued.length
              ? Promise.resolve({ value: queued.shift()!, done: false })
              : closed
                ? Promise.resolve({ value: undefined, done: true })
                : new Promise<IteratorResult<SpectrumIncomingMessage>>(
                    (resolve) => waiting.push(resolve),
                  ),
          return: async () => ({ value: undefined, done: true }),
        };
      },
    },
    sendText: vi.fn(async () => ({ messageId: 'reply-id' })),
    stop: vi.fn(async () => {
      closed = true;
      waiting
        .splice(0)
        .forEach((resolve) => resolve({ value: undefined, done: true }));
    }),
  };
  const receive = vi.fn(async (_message: SpectrumIncomingMessage) => {}),
    report = vi.fn(),
    factory = vi.fn(async () => runtime);
  const transport = new SpectrumMessagingTransport(
    config,
    receive,
    report,
    factory,
  );
  const emit = (event: SpectrumIncomingMessage) => {
    const resolve = waiting.shift();
    if (resolve) resolve({ value: event, done: false });
    else queued.push(event);
  };
  return { runtime, receive, report, factory, transport, emit };
}
const incoming: SpectrumIncomingMessage = {
  platform: 'telegram',
  senderId: '123',
  spaceId: '123',
  messageId: 'message-1',
  text: 'hello',
  direction: 'inbound',
  isDirect: true,
};
const imessageIncoming: SpectrumIncomingMessage = {
  ...incoming,
  platform: 'imessage',
  senderId: '+15554445555',
  spaceId: 'any;-;+15554445555',
  phone: '+15551112222',
};
it('env defaults never activate providers or reuse legacy tokens', () => {
  expect(spectrumMessagingConfig({})).toEqual({
    enabled: false,
    projectId: undefined,
    projectSecret: undefined,
  });
  const loaded = spectrumMessagingConfig({
    SPECTRUM_MESSAGING_ENABLED: 'true',
    SPECTRUM_PROJECT_ID: PROJECT,
    SPECTRUM_PROJECT_SECRET: 'fixture',
    SPECTRUM_TELEGRAM_BOT_TOKEN: token,
    SPECTRUM_IMESSAGE_ENABLED: 'true',
  });
  expect(loaded.telegram?.registrationApproved).toBe(false);
  expect(loaded.imessage?.lineOwnershipConfirmed).toBe(false);
  expect(loaded.imessage?.lineMode).toBe('dedicated');
  expect(loaded.imessage?.phone).toBeUndefined();
});
it('disabled/missing or unapproved configuration never initializes the SDK or changes a webhook', async () => {
  const factory = vi.fn(async () => fixture().runtime);
  for (const value of [
    { enabled: false },
    { enabled: true },
    { ...config, enabled: false },
    {
      ...config,
      telegram: { ...config.telegram!, registrationApproved: false },
      imessage: { ...config.imessage!, lineOwnershipConfirmed: false },
    },
  ]) {
    const transport = new SpectrumMessagingTransport(
      value,
      vi.fn(),
      vi.fn(),
      factory,
    );
    expect(
      (await transport.start()).every((provider) => !provider.available),
    ).toBe(true);
    await transport.stop();
  }
  expect(factory).not.toHaveBeenCalled();
});
it('starts one instance for concurrent activation and closes it idempotently without process exits', async () => {
  const f = fixture();
  await Promise.all([f.transport.start(), f.transport.start()]);
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.transport.status().every((provider) => provider.available)).toBe(
    true,
  );
  await f.transport.stop();
  await f.transport.stop();
  expect(f.runtime.stop).toHaveBeenCalledTimes(1);
  expect(f.transport.status().every((provider) => !provider.available)).toBe(
    true,
  );
});
it('shutdown during startup disposes the late SDK instance without delivering its messages', async () => {
  const f = fixture();
  let release: (runtime: SpectrumRuntime) => void = () => {};
  const factory = vi.fn(
    () =>
      new Promise<SpectrumRuntime>((resolve) => {
        release = resolve;
      }),
  );
  const transport = new SpectrumMessagingTransport(
    config,
    f.receive,
    f.report,
    factory,
  );
  const start = transport.start(),
    stop = transport.stop();
  release(f.runtime);
  await Promise.all([start, stop]);
  expect(f.runtime.stop).toHaveBeenCalledTimes(1);
  expect(f.receive).not.toHaveBeenCalled();
  expect(transport.status().every((provider) => !provider.available)).toBe(
    true,
  );
});
it('filters group, outbound, foreign line and nontext payloads and dedupes exact inbound receipts', async () => {
  const f = fixture();
  await f.transport.start();
  for (const event of [
    { ...incoming, isDirect: false },
    { ...incoming, direction: 'outbound' },
    { ...incoming, spaceId: '-456' },
    { ...imessageIncoming, phone: '+15559999999' },
    { ...incoming, text: '' },
    { ...incoming, content: { type: 'reaction' } },
  ])
    f.emit(event as SpectrumIncomingMessage);
  f.emit(incoming);
  f.emit(incoming);
  f.emit({ ...imessageIncoming, messageId: 'message-2' });
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledTimes(2));
  expect(f.receive.mock.calls[0][0]).toEqual(incoming);
  await f.transport.stop();
});
it('normalizes real SDK tuples to DM-only text records without retaining SDK handles or extras', () => {
  const space = { id: '123', __platform: 'telegram' } as Space;
  const message = {
    id: 'one',
    platform: 'telegram',
    direction: 'inbound',
    sender: { id: '123', __platform: 'telegram' },
    content: { type: 'text', text: 'link code' },
  } as Message;
  expect(normalizeSpectrumMessage(space, message, config)).toEqual({
    ...incoming,
    messageId: 'one',
    text: 'link code',
  });
  expect(
    normalizeSpectrumMessage(
      { ...space, id: '-123' } as Space,
      message,
      config,
    ),
  ).toBeUndefined();
  expect(
    normalizeSpectrumMessage(
      space,
      { ...message, direction: 'outbound' },
      config,
    ),
  ).toBeUndefined();
  expect(
    normalizeSpectrumMessage(
      space,
      { ...message, sender: { ...message.sender!, kind: 'agent' } },
      config,
    ),
  ).toBeUndefined();
});
it('sends only exact bound direct targets, pins the verified line, and never retries a failed reply', async () => {
  const f = fixture();
  await f.transport.start();
  await f.transport.sendText(
    {
      platform: 'imessage',
      spaceId: imessageIncoming.spaceId,
      phone: imessageIncoming.phone,
    },
    'a reply',
  );
  expect(f.runtime.sendText).toHaveBeenCalledWith(
    {
      platform: 'imessage',
      spaceId: imessageIncoming.spaceId,
      phone: '+15551112222',
    },
    'a reply',
  );
  await expect(
    f.transport.sendText(
      { platform: 'imessage', spaceId: imessageIncoming.spaceId },
      'no pin',
    ),
  ).rejects.toThrow('exact linked');
  await expect(
    f.transport.sendText({ platform: 'telegram', spaceId: '-123' }, 'group'),
  ).rejects.toThrow('exact linked');
  vi.mocked(f.runtime.sendText).mockRejectedValue(Error(token));
  await expect(
    f.transport.sendText({ platform: 'telegram', spaceId: '123' }, 'a reply'),
  ).rejects.toThrow('not be resent automatically');
  expect(JSON.stringify(f.report.mock.calls)).not.toContain(token);
  expect(f.runtime.sendText).toHaveBeenCalledTimes(2);
  await f.transport.stop();
});
it('handler failures are redacted and do not stop other inbound messages', async () => {
  const f = fixture();
  f.receive.mockRejectedValueOnce(Error('fixture-project-secret'));
  await f.transport.start();
  f.emit(incoming);
  f.emit({ ...incoming, messageId: 'two' });
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledTimes(2));
  expect(JSON.stringify(f.report.mock.calls)).not.toContain(
    'fixture-project-secret',
  );
  await f.transport.stop();
});
it('start failures redact raw provider errors in status and logs', async () => {
  const report = vi.fn(),
    transport = new SpectrumMessagingTransport(
      config,
      vi.fn(),
      report,
      async () => {
        throw Error(token);
      },
    );
  expect(
    (await transport.start()).every((provider) => !provider.available),
  ).toBe(true);
  expect(JSON.stringify(transport.status())).not.toContain(token);
  expect(JSON.stringify(report.mock.calls)).not.toContain(token);
  await transport.stop();
});
function sdkFixture(
  overrides: {
    project?: object;
    webhook?: string;
    mode?: 'shared' | 'dedicated';
    numbers?: Record<string, string>;
  } = {},
) {
  const app = {
    messages: {
      async *[Symbol.asyncIterator]() {
        yield* [];
      },
    },
    stop: vi.fn(async () => {}),
  };
  const initialize = vi.fn(async (_options: unknown) => app);
  const calls: { url: string; authorization?: string }[] = [];
  const transport = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        authorization:
          new Headers(init?.headers).get('Authorization') ?? undefined,
      });
      if (url.endsWith('/getMe'))
        return new Response(
          JSON.stringify({
            ok: true,
            result: { id: 123456, is_bot: true, username: 'ChatGPTEE_bot' },
          }),
        );
      if (url.endsWith('/getWebhookInfo'))
        return new Response(
          JSON.stringify({
            ok: true,
            result: { url: overrides.webhook ?? '' },
          }),
        );
      const data = url.endsWith('/platforms/')
        ? { imessage: { enabled: true } }
        : url.endsWith('/imessage/')
          ? { type: overrides.mode ?? 'dedicated' }
          : (overrides.project ?? {
              name: 'ChatGPTEE',
              slug: 'chatgptee',
              profile: {},
            });
      return new Response(JSON.stringify({ succeed: true, data }));
    },
  );
  const cloudApi = {
    getProject: vi.fn(async () => ({
      id: PROJECT,
      name: 'ChatGPTEE',
      slug: 'chatgptee',
      profile: {},
    })),
    getPlatforms: vi.fn(async () => ({
      imessage: { enabled: true },
      whatsapp_business: { enabled: false },
      slack: { enabled: false },
    })),
    getImessageInfo: vi.fn(async () => ({ type: 'dedicated' as const })),
    issueImessageTokens: vi.fn(async () => ({
      type: 'dedicated' as const,
      expiresIn: 3600,
      auth: { fixture: 'fixture-line-token' },
      numbers: overrides.numbers ?? { fixture: '+15551112222' },
    })),
  };
  return {
    app,
    initialize,
    transport,
    calls,
    cloudApi,
    factory: spectrumSdkFactory({
      transport: transport as typeof fetch,
      initialize: initialize as unknown as typeof Spectrum,
    }),
  };
}
it('current Stable metadata omits project id; preflight requests use Basic auth on the scoped fixed origin', async () => {
  const f = sdkFixture();
  await f.factory({ ...config, imessage: undefined });
  expect(f.initialize).toHaveBeenCalledTimes(1);
  const calls = f.calls.filter((call) =>
    call.url.startsWith('https://spectrum.photon.codes'),
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].authorization).toBe(
    `Basic ${Buffer.from(`${PROJECT}:fixture-project-secret`).toString('base64')}`,
  );
  expect(calls[0].url).toBe(
    `https://spectrum.photon.codes/projects/${PROJECT}/`,
  );
  expect(f.initialize.mock.calls[0][0]).toMatchObject({
    projectId: PROJECT,
    telemetry: false,
    options: { logLevel: 'error' },
  });
});
it('refuses any different active Telegram webhook before Spectrum can register a provider', async () => {
  const f = sdkFixture({
    webhook: 'https://existing-project.spctrm.dev/telegram',
  });
  await expect(f.factory({ ...config, imessage: undefined })).rejects.toThrow(
    'another active webhook',
  );
  expect(f.initialize).not.toHaveBeenCalled();
  expect(
    f.transport.mock.calls.every(
      (call) =>
        new URL(String(call[0])).pathname.endsWith('/getMe') ||
        new URL(String(call[0])).pathname.endsWith('/getWebhookInfo') ||
        String(call[0]).startsWith('https://spectrum.photon.codes'),
    ),
  ).toBe(true);
});
it('checks declared bot identity and rejects an explicit project id mismatch', async () => {
  const f = sdkFixture();
  await expect(
    f.factory({
      ...config,
      telegram: { ...config.telegram!, expectedBotUsername: 'OtherBot' },
      imessage: undefined,
    }),
  ).rejects.toThrow('different bot');
  expect(f.initialize).not.toHaveBeenCalled();
  const wrong = sdkFixture({
    project: { id: 'other', name: 'Other', slug: 'other', profile: {} },
  });
  await expect(
    wrong.factory({ ...config, imessage: undefined }),
  ).rejects.toThrow('project identity');
  expect(wrong.initialize).not.toHaveBeenCalled();
});
it('dedicated phone must be in the actual project inventory and the voice phone is never substituted', async () => {
  const f = sdkFixture({ numbers: { fixture: '+15559999999' } });
  const factory = spectrumSdkFactory({
    transport: f.transport as typeof fetch,
    initialize: f.initialize as unknown as typeof Spectrum,
    cloudApi: f.cloudApi,
  });
  await expect(factory(config)).rejects.toThrow('not a dedicated line owned');
  expect(f.initialize).not.toHaveBeenCalled();
});
it('shared mode never advertises a fixed sender number or accepts a dedicated pin', async () => {
  const f = fixture();
  const shared = {
    ...config,
    imessage: { lineMode: 'shared' as const, lineOwnershipConfirmed: true },
  };
  const transport = new SpectrumMessagingTransport(
    shared,
    f.receive,
    f.report,
    f.factory,
  );
  await transport.start();
  f.emit({ ...imessageIncoming, phone: 'shared' });
  await vi.waitFor(() => expect(f.receive).toHaveBeenCalledOnce());
  await expect(
    transport.sendText(
      {
        platform: 'imessage',
        spaceId: imessageIncoming.spaceId,
        phone: '+12564726195',
      },
      'reply',
    ),
  ).rejects.toThrow('exact linked');
  await transport.stop();
});
it('authenticates platform and line preflight instead of SDK metadata helpers that currently return 401', async () => {
  const f = sdkFixture({ mode: 'shared' });
  await expect(f.factory(config)).rejects.toThrow('line mode differs');
  expect(f.initialize).not.toHaveBeenCalled();
  const calls = f.calls.filter((call) =>
    call.url.startsWith('https://spectrum.photon.codes'),
  );
  expect(calls.map((call) => call.url)).toEqual([
    `https://spectrum.photon.codes/projects/${PROJECT}/`,
    `https://spectrum.photon.codes/projects/${PROJECT}/platforms/`,
    `https://spectrum.photon.codes/projects/${PROJECT}/imessage/`,
  ]);
  expect(
    calls.every(
      (call) =>
        call.authorization ===
        `Basic ${Buffer.from(`${PROJECT}:fixture-project-secret`).toString('base64')}`,
    ),
  ).toBe(true);
});
