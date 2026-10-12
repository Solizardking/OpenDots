import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessagingStore } from '../src/server/messaging-store.js';
import {
  MessagingCoordinator,
  type MessagingTransport,
  type MessagingWorkspace,
  type NativeMessagingEvent,
} from '../src/server/messaging-coordinator.js';
import { messagingRoutes } from '../src/server/messaging-routes.js';
import type { MessagingPlatform } from '../src/shared/messaging-types.js';
import { EventType, RunAgentInputSchema } from '@ag-ui/core';
import { runThreadTurn } from '../src/server/headless.js';
import { isSpectrumTurn } from '../src/server/messaging-tool-profile.js';

const dotA = '00000000-0000-4000-8000-000000000001';
const dotB = '00000000-0000-4000-8000-000000000002';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.restoreAllMocks();
});

it('preserves the native privilege restriction through actual AG-UI HTTP serialization', async () => {
  let observed = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/info'))
      return Response.json({ mode: 'sse', agents: { dot: {} } });
    if (url.endsWith('/threads/thread/messages'))
      return Response.json({ messages: [] });
    if (!url.endsWith('/agent/dot/run'))
      throw new Error('Unexpected fixture runtime request.');
    const body = RunAgentInputSchema.parse(JSON.parse(String(init?.body)));
    observed = true;
    expect(isSpectrumTurn(body)).toBe(true);
    expect(body.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Native question',
      metadata: { opendotsSource: 'spectrum_message' },
    });
    const events = [
      {
        type: EventType.RUN_STARTED,
        threadId: body.threadId,
        runId: body.runId,
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'fixture-answer',
        role: 'assistant',
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'fixture-answer',
        delta: 'Native answer',
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: 'fixture-answer' },
      {
        type: EventType.RUN_FINISHED,
        threadId: body.threadId,
        runId: body.runId,
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  expect(
    await runThreadTurn(
      'https://runtime.fixture.invalid',
      {},
      'dot',
      'thread',
      'Native question',
      new AbortController().signal,
      { opendotsSource: 'spectrum_message' },
    ),
  ).toBe('Native answer');
  expect(observed).toBe(true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function native(
  overrides: Partial<NativeMessagingEvent> = {},
): NativeMessagingEvent {
  return {
    platform: 'telegram',
    senderId: '12345678',
    spaceId: '12345678',
    messageId: 'message-1',
    text: 'Hello',
    direction: 'inbound',
    isDirect: true,
    ...overrides,
  };
}
function fixture(available = true) {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  let now = Date.parse('2026-10-10T21:00:00Z');
  const store = new MessagingStore(db, () => now);
  const scopes: Record<MessagingPlatform, string> = {
    telegram: 'new-chatgptee-project:telegram-bot',
    imessage: 'new-chatgptee-project:imessage-line',
  };
  const providers = [
    {
      platform: 'telegram' as const,
      configured: available,
      available,
      reason: 'Fixture status',
      botUsername: 'ChatgpteeFixtureBot',
    },
    {
      platform: 'imessage' as const,
      configured: available,
      available,
      reason: 'Fixture status',
      address: '+15550000001',
    },
  ];
  const sendText = vi.fn<MessagingTransport['sendText']>(async () => {});
  function workspace(id: string, name: string): MessagingWorkspace {
    return {
      dot: (candidate) => (candidate === id ? { id, name } : undefined),
      createConversation: vi.fn(async () => ({ id: `thread-${id}` })),
      turn: vi.fn(async () => `${name} reply`),
    };
  }
  const a = workspace(dotA, 'Alice Dot');
  const b = workspace(dotB, 'Bob Dot');
  const workspaces = new Map([
    ['alice', a],
    ['bob', b],
  ]);
  const resolveWorkspace = vi.fn(async (ownerId: string) =>
    workspaces.get(ownerId),
  );
  const coordinator = new MessagingCoordinator(
    store,
    { status: () => providers, sendText },
    resolveWorkspace,
    (platform) => scopes[platform],
  );
  async function pair(
    owner = 'alice',
    platform: MessagingPlatform = 'telegram',
    senderId = '12345678',
  ) {
    const link = await coordinator.link(
      owner,
      platform,
      owner === 'alice' ? dotA : dotB,
    );
    await coordinator.receive(
      native({
        platform,
        senderId,
        spaceId: senderId,
        messageId: `pair-${owner}-${platform}-${link.code}`,
        text:
          platform === 'telegram' ? `/start ${link.code}` : `LINK ${link.code}`,
        ...(platform === 'imessage' ? { phone: '+15550000001' } : {}),
      }),
    );
    await coordinator.drain();
    return link;
  }
  return {
    db,
    store,
    coordinator,
    providers,
    scopes,
    sendText,
    a,
    b,
    resolveWorkspace,
    pair,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('persistent messaging identity boundaries', () => {
  it('stores only a code hash, rotates previous codes and enforces the ten minute expiry', () => {
    const f = fixture();
    const first = f.store.issue('alice', dotA, 'telegram', f.scopes.telegram);
    const second = f.store.issue('alice', dotA, 'telegram', f.scopes.telegram);
    const identity = {
      platform: 'telegram' as const,
      scope: f.scopes.telegram,
      senderId: '12345678',
      spaceId: '12345678',
    };
    const rows = f.db.prepare('SELECT * FROM messaging_links').all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(first.code);
    expect(JSON.stringify(rows)).not.toContain(second.code);
    expect(f.store.claim(first.code, identity)).toBeUndefined();
    f.advance(600000);
    expect(f.store.claim(second.code, identity)).toBeUndefined();
    expect(f.store.binding('alice', 'telegram')).toBeUndefined();
  });

  it('rejects the wrong platform or project scope without consuming the legitimate code', () => {
    const f = fixture();
    const link = f.store.issue('alice', dotA, 'telegram', f.scopes.telegram);
    const identity = {
      platform: 'telegram' as const,
      scope: f.scopes.telegram,
      senderId: '12345678',
      spaceId: '12345678',
    };
    expect(
      f.store.claim(link.code, { ...identity, platform: 'imessage' }),
    ).toBeUndefined();
    expect(
      f.store.claim(link.code, { ...identity, scope: 'old-clawd-project' }),
    ).toBeUndefined();
    const binding = f.store.claim(link.code, identity);
    expect(binding?.ownerId).toBe('alice');
    expect(f.store.claim(link.code, identity)).toBeUndefined();
  });

  it('prevents a native sender from claiming another account and invalidates stale binding identities', () => {
    const f = fixture();
    const nativeIdentity = {
      platform: 'telegram' as const,
      scope: f.scopes.telegram,
      senderId: '12345678',
      spaceId: '12345678',
    };
    const alice = f.store.issue('alice', dotA, 'telegram', f.scopes.telegram);
    const binding = f.store.claim(alice.code, nativeIdentity)!;
    const bob = f.store.issue('bob', dotB, 'telegram', f.scopes.telegram);
    expect(f.store.claim(bob.code, nativeIdentity)).toBeUndefined();
    expect(f.store.binding('bob', 'telegram')).toBeUndefined();
    expect(f.store.current(binding)).toBe(true);
    const replacement = f.store.issue(
      'alice',
      dotA,
      'telegram',
      f.scopes.telegram,
    );
    const changed = f.store.claim(replacement.code, {
      ...nativeIdentity,
      senderId: '87654321',
      spaceId: '87654321',
    });
    expect(changed?.ownerId).toBe('alice');
    expect(f.store.current(binding)).toBe(false);
    expect(f.store.thread(binding, 'stale-thread')).toBe(false);
    expect(
      f.store.identity('telegram', f.scopes.telegram, nativeIdentity.senderId),
    ).toBeUndefined();
  });

  it('retains account bindings, thread identity and provider replay detection across SQLite restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opendots-messaging-test-'));
    const path = join(dir, 'fixture.sqlite');
    let db = new DatabaseSync(path);
    try {
      let store = new MessagingStore(db);
      const link = store.issue('alice', dotA, 'imessage', 'project:line');
      const binding = store.claim(link.code, {
        platform: 'imessage',
        scope: 'project:line',
        senderId: '+15550000002',
        spaceId: 'dm-fixture',
        phone: '+15550000001',
      })!;
      store.thread(binding, 'persistent-thread');
      expect(
        store.seen(
          'imessage',
          'project:line',
          'dm-fixture',
          'native-event',
          '+15550000001',
        ),
      ).toBe(false);
      db.close();
      db = new DatabaseSync(path);
      store = new MessagingStore(db);
      expect(store.binding('alice', 'imessage')).toMatchObject({
        id: binding.id,
        threadId: 'persistent-thread',
        ownerId: 'alice',
      });
      expect(
        store.claim(link.code, {
          platform: 'imessage',
          scope: 'project:line',
          senderId: '+15550000002',
          spaceId: 'dm-fixture',
        }),
      ).toBeUndefined();
      expect(
        store.seen(
          'imessage',
          'project:line',
          'dm-fixture',
          'native-event',
          '+15550000001',
        ),
      ).toBe(true);
      expect(
        store.seen(
          'imessage',
          'different-project',
          'dm-fixture',
          'native-event',
          '+15550000001',
        ),
      ).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('native account routing and cancellation', () => {
  it('does not persist replay records for unknown senders or invalid pairing codes', async () => {
    const f = fixture();
    await f.coordinator.receive(native({ messageId: 'unknown-sender' }));
    await f.coordinator.receive(
      native({ messageId: 'invalid-code', text: `/start ${'A'.repeat(32)}` }),
    );
    await f.coordinator.drain();
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM messaging_seen').get()?.count,
    ).toBe(0);
    expect(f.store.binding('alice', 'telegram')).toBeUndefined();
    expect(f.a.turn).not.toHaveBeenCalled();
    expect(f.sendText).not.toHaveBeenCalled();
    await f.pair();
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM messaging_seen').get()?.count,
    ).toBe(1);
    expect(f.store.binding('alice', 'telegram')?.ownerId).toBe('alice');
  });

  it('keeps a ready shared iMessage provider unavailable until a verified destination exists', async () => {
    const f = fixture();
    const provider = f.providers.find((item) => item.platform === 'imessage')!;
    Reflect.deleteProperty(provider, 'address');
    const status = await f.coordinator.status('alice');
    expect(
      status.channels.find((item) => item.platform === 'imessage'),
    ).toMatchObject({ configured: true, available: false, linked: false });
    await expect(
      f.coordinator.link('alice', 'imessage', dotA),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM messaging_links').get()
        ?.count,
    ).toBe(0);
    expect(f.sendText).not.toHaveBeenCalled();
  });

  it('keeps missing provider setup honest and checks the selected Dot belongs to the account', async () => {
    const f = fixture(false);
    expect(
      (await f.coordinator.status('alice')).channels.every(
        (p) => !p.available && !p.linked,
      ),
    ).toBe(true);
    await expect(
      f.coordinator.link('alice', 'telegram', dotA),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      f.coordinator.link('alice', 'telegram', dotB),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.coordinator.status('alice', dotB)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM messaging_links').get()
        ?.count,
    ).toBe(0);
    expect(f.sendText).not.toHaveBeenCalled();
  });

  it('rejects group/outbound/link replays and routes messages only into the linked account conversation', async () => {
    const f = fixture();
    const link = await f.coordinator.link('alice', 'telegram', dotA);
    const pairing = native({ text: `/start ${link.code}` });
    await f.coordinator.receive({
      ...pairing,
      isDirect: false,
      messageId: 'group',
    });
    await f.coordinator.receive({
      ...pairing,
      direction: 'outbound' as 'inbound',
      messageId: 'echo',
    });
    expect(f.store.binding('alice', 'telegram')).toBeUndefined();
    await f.coordinator.receive(pairing);
    await f.coordinator.drain();
    expect(f.sendText).toHaveBeenCalledTimes(1);
    await f.coordinator.receive(pairing);
    await f.coordinator.receive(
      native({
        senderId: 'unknown',
        spaceId: 'unknown',
        messageId: 'unlinked',
      }),
    );
    await f.coordinator.receive(
      native({ spaceId: 'other-chat', messageId: 'wrong-chat' }),
    );
    await f.coordinator.receive(
      native({ messageId: 'real-turn', text: 'My private question' }),
    );
    await f.coordinator.receive(
      native({ messageId: 'real-turn', text: 'My private question' }),
    );
    await f.coordinator.drain();
    expect(f.a.createConversation).toHaveBeenCalledTimes(1);
    expect(f.a.turn).toHaveBeenCalledExactlyOnceWith(
      `thread-${dotA}`,
      'My private question',
      expect.any(AbortSignal),
    );
    expect(f.b.turn).not.toHaveBeenCalled();
    expect(f.sendText).toHaveBeenCalledTimes(2);
    expect(f.sendText.mock.calls[1][0]).toMatchObject({
      platform: 'telegram',
      spaceId: '12345678',
    });
  });

  it('masks linked sender identity and does not carry a binding into another provider scope', async () => {
    const f = fixture();
    await f.pair();
    const alice = await f.coordinator.status('alice');
    expect(alice.channels[0]).toMatchObject({
      linked: true,
      linkedIdentityMasked: '••••5678',
      dotId: dotA,
    });
    expect(JSON.stringify(alice)).not.toContain('12345678');
    expect(
      (await f.coordinator.status('bob')).channels.every((p) => !p.linked),
    ).toBe(true);
    f.scopes.telegram = 'rotated-project:other-bot';
    expect((await f.coordinator.status('alice')).channels[0].linked).toBe(
      false,
    );
    await f.coordinator.receive(native({ messageId: 'wrong-scope-turn' }));
    await f.coordinator.drain();
    expect(f.a.turn).not.toHaveBeenCalled();
  });

  it('suppresses a late model reply and queued followup immediately after unlink', async () => {
    const f = fixture();
    await f.pair();
    f.sendText.mockClear();
    const entered = deferred<AbortSignal>();
    const completed = deferred<string>();
    vi.mocked(f.a.turn).mockImplementation(async (_thread, _prompt, signal) => {
      entered.resolve(signal);
      return completed.promise;
    });
    await f.coordinator.receive(native({ messageId: 'running' }));
    const signal = await entered.promise;
    await f.coordinator.receive(native({ messageId: 'queued' }));
    f.coordinator.unlink('alice', 'telegram');
    expect(signal.aborted).toBe(true);
    completed.resolve('Private result after unlink');
    await f.coordinator.drain();
    expect(f.a.turn).toHaveBeenCalledTimes(1);
    expect(f.sendText).not.toHaveBeenCalled();
    expect(f.store.binding('alice', 'telegram')).toBeUndefined();
  });

  it('serializes one account channel while allowing another account to complete independently', async () => {
    const f = fixture();
    await f.pair();
    await f.pair('bob', 'telegram', '87654321');
    const started = deferred<void>();
    const release = deferred<string>();
    const bobStarted = deferred<void>();
    vi.mocked(f.a.turn).mockImplementationOnce(async () => {
      started.resolve();
      return release.promise;
    });
    vi.mocked(f.b.turn).mockImplementation(async () => {
      bobStarted.resolve();
      return 'Bob private result';
    });
    await f.coordinator.receive(native({ messageId: 'alice-first' }));
    await started.promise;
    await f.coordinator.receive(native({ messageId: 'alice-second' }));
    await f.coordinator.receive(
      native({
        senderId: '87654321',
        spaceId: '87654321',
        messageId: 'bob-first',
      }),
    );
    await bobStarted.promise;
    expect(f.a.turn).toHaveBeenCalledTimes(1);
    expect(f.b.turn).toHaveBeenCalledTimes(1);
    release.resolve('Alice private result');
    await f.coordinator.drain();
    expect(f.a.turn).toHaveBeenCalledTimes(2);
    expect(
      f.sendText.mock.calls.some(
        ([target, text]) =>
          target.spaceId === '12345678' && text === 'Bob private result',
      ),
    ).toBe(false);
    expect(
      f.sendText.mock.calls.some(
        ([target, text]) =>
          target.spaceId === '87654321' && text === 'Alice private result',
      ),
    ).toBe(false);
  });

  it('requires the exact iMessage routing line and keeps its reply destination separate from the voice phone', async () => {
    const f = fixture();
    await f.pair('alice', 'imessage', '+15550000002');
    f.sendText.mockClear();
    await f.coordinator.receive(
      native({
        platform: 'imessage',
        senderId: '+15550000002',
        spaceId: '+15550000002',
        phone: '+12564726195',
        messageId: 'wrong-line',
      }),
    );
    await f.coordinator.receive(
      native({
        platform: 'imessage',
        senderId: '+15550000002',
        spaceId: '+15550000002',
        phone: '+15550000001',
        messageId: 'correct-line',
      }),
    );
    await f.coordinator.drain();
    expect(f.a.turn).toHaveBeenCalledTimes(1);
    expect(f.sendText).toHaveBeenCalledExactlyOnceWith(
      { platform: 'imessage', spaceId: '+15550000002', phone: '+15550000001' },
      'Alice Dot reply',
    );
  });

  it('stops active computation and blocks further linking or provider reply attempts', async () => {
    const f = fixture();
    await f.pair();
    f.sendText.mockClear();
    const entered = deferred<AbortSignal>();
    const result = deferred<string>();
    vi.mocked(f.a.turn).mockImplementation(async (_thread, _prompt, signal) => {
      entered.resolve(signal);
      return result.promise;
    });
    await f.coordinator.receive(native({ messageId: 'before-stop' }));
    const signal = await entered.promise;
    const stopping = f.coordinator.stop();
    expect(signal.aborted).toBe(true);
    result.resolve('Discard after stop');
    await stopping;
    await f.coordinator.receive(native({ messageId: 'after-stop' }));
    await expect(
      f.coordinator.link('alice', 'telegram', dotA),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.a.turn).toHaveBeenCalledTimes(1);
    expect(f.sendText).not.toHaveBeenCalled();
  });
});

describe('private messaging API', () => {
  it('requires an authenticated account on every route and keeps results uncached', async () => {
    const f = fixture();
    const app = messagingRoutes(f.coordinator, async () => undefined);
    for (const [path, method] of [
      ['/status', 'GET'],
      ['/link', 'POST'],
      ['/unlink', 'POST'],
    ]) {
      const response = await app.request(path, {
        method,
        ...(method === 'POST'
          ? { headers: { 'content-type': 'application/json' }, body: '{}' }
          : {}),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(f.resolveWorkspace).not.toHaveBeenCalled();
  });

  it('rejects owner spoofing, unknown fields, invalid channels and another account Dot', async () => {
    const f = fixture();
    const app = messagingRoutes(f.coordinator, async () => 'alice');
    for (const body of [
      { platform: 'telegram', dotId: dotA, ownerId: 'bob' },
      { platform: 'telegram', dotId: dotA, token: 'fixture-token' },
      { platform: 'slack', dotId: dotA },
      { platform: 'telegram', dotId: 'not-a-uuid' },
    ]) {
      const response = await app.request('/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    const otherDot = await app.request('/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', dotId: dotB }),
    });
    expect(otherDot.status).toBe(404);
    expect((await app.request('/status?dotId=invalid')).status).toBe(400);
    expect((await app.request(`/status?dotId=${dotB}`)).status).toBe(404);
    expect(
      f.db.prepare('SELECT COUNT(*) AS count FROM messaging_links').get()
        ?.count,
    ).toBe(0);
  });

  it('links only the authenticated account, rotates private codes and caps request bodies', async () => {
    const f = fixture();
    const app = messagingRoutes(f.coordinator, async () => 'alice');
    const request = () =>
      app.request('/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', dotId: dotA }),
      });
    const first = await request();
    const firstLink = (await first.json()) as { code: string; url: string };
    const second = await request();
    const secondLink = (await second.json()) as { code: string; url: string };
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(secondLink.code).not.toBe(firstLink.code);
    expect(secondLink.url).toBe(
      `https://t.me/ChatgpteeFixtureBot?start=${secondLink.code}`,
    );
    expect(
      f.store.claim(firstLink.code, {
        platform: 'telegram',
        scope: f.scopes.telegram,
        senderId: '12345678',
        spaceId: '12345678',
      }),
    ).toBeUndefined();
    const oversized = await app.request('/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'telegram',
        dotId: dotA,
        padding: 'x'.repeat(2100),
      }),
    });
    expect(oversized.status).toBe(413);
  });

  it('unlinks only the authenticated account and rejects destination or identity injection', async () => {
    const f = fixture();
    await f.pair('alice');
    await f.pair('bob', 'telegram', '87654321');
    const app = messagingRoutes(f.coordinator, async () => 'alice');
    const bad = await app.request('/unlink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'telegram',
        senderId: '87654321',
        ownerId: 'bob',
      }),
    });
    expect(bad.status).toBe(400);
    const response = await app.request('/unlink', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram' }),
    });
    expect(response.status).toBe(200);
    expect(f.store.binding('alice', 'telegram')).toBeUndefined();
    expect(f.store.binding('bob', 'telegram')?.ownerId).toBe('bob');
  });
});
