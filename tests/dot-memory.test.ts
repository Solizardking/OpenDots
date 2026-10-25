import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  DotMemoryService,
  supermemoryNamespace,
} from '../src/server/dot-memory.js';
import { Platform } from '../src/server/platform.js';
import { createApp } from '../src/server/app.js';
import { Runner } from '../src/server/runner.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.restoreAllMocks();
});
const mem0 = {
  mem0ApiKey: 'private-memory-key',
  mem0BaseUrl: 'https://memory.invalid',
  mem0OrgId: 'org-test',
  mem0ProjectId: 'project-test',
};
function fixture(
  path = ':memory:',
  owner = 'owner',
  bind = true,
  config: object = mem0,
) {
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, owner);
  const service = new DotMemoryService(store, workspace, config);
  cleanup.push(async () => {
    await service.stop();
    workspace.close();
    store.close();
  });
  const dot = workspace.dots()[0];
  if (
    bind &&
    !workspace.conversations().some((thread) => thread.id === 'thread')
  )
    workspace.bindThread('thread', dot.id, 'Test');
  return { store, workspace, service, dot };
}
const ok = (body: unknown) => Response.json(body);
const user = {
  id: 'user-message',
  role: 'user' as const,
  content: 'I prefer amber dashboards for my project.',
};

it('scopes recall and completed turns to the server owner, Dot, organization, and project', async () => {
  const f = fixture();
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, options) =>
      options?.method === 'POST' && String(_url).includes('/search/')
        ? ok({ results: [{ id: 'fact', memory: 'Prefers amber dashboards.' }] })
        : ok({ status: 'SUCCEEDED' }),
    );
  expect(await f.service.recall(f.dot.id, 'What dashboard color?')).toEqual([
    { id: 'fact', text: 'Prefers amber dashboards.' },
  ]);
  f.service.record(f.dot.id, 'thread', 'run', user, 'I will use amber.');
  await f.service.flush();
  const [searchUrl, searchOptions] = provider.mock.calls[0];
  expect(String(searchUrl)).toContain('org_id=org-test');
  expect(String(searchUrl)).toContain('project_id=project-test');
  expect(JSON.parse(String(searchOptions?.body))).toMatchObject({
    filters: {
      OR: [
        { user_id: `opendots:owner:${f.dot.id}` },
        { agent_id: `opendots:owner:${f.dot.id}` },
      ],
    },
  });
  const payload = JSON.parse(String(provider.mock.calls[1][1]?.body));
  expect(payload).toMatchObject({
    user_id: `opendots:owner:${f.dot.id}`,
    agent_id: `opendots:owner:${f.dot.id}`,
    org_id: 'org-test',
    project_id: 'project-test',
    messages: [
      userMessage(),
      { role: 'assistant', content: 'I will use amber.' },
    ],
  });
  expect(f.service.status(f.dot.id).synced).toBe(1);
  // The same completed run is never uploaded twice.
  f.service.record(f.dot.id, 'thread', 'run', user, 'I will use amber.');
  await f.service.flush();
  expect(provider).toHaveBeenCalledTimes(2);
});
function userMessage() {
  return { role: 'user', content: user.content };
}

it('keeps accepted processing events pending and resumes the outbox after a database restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-memory-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workspace.sqlite');
  const f = fixture(path);
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(ok({ status: 'PENDING', event_id: 'event-id' }));
  f.service.record(f.dot.id, 'thread', 'run', user, 'Amber it is.');
  await f.service.flush();
  expect(f.service.status(f.dot.id)).toMatchObject({ pending: 1, synced: 0 });
  await cleanup.pop()!();
  const restored = fixture(path);
  expect(restored.dot.id).toBe(f.dot.id);
  expect(restored.workspace.localConversations.get('thread').messages).toEqual(
    [],
  );
  const turn = restored.workspace.dotMemory.due(Date.now() + 30000)[0];
  restored.workspace.dotMemory.update(turn, 'pending', -1);
  provider.mockResolvedValue(ok({ status: 'SUCCEEDED' }));
  await restored.service.flush();
  expect(provider).toHaveBeenCalledTimes(2);
  expect(String(provider.mock.calls[1][0])).toContain('/v1/event/event-id/');
  expect(restored.service.status(f.dot.id)).toMatchObject({
    pending: 0,
    synced: 1,
  });
});

it('retries failed extraction without repeatedly polling the failed event', async () => {
  const f = fixture();
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(ok({ status: 'PENDING', event_id: 'failed-event' }));
  f.service.record(f.dot.id, 'thread', 'run', user, 'Amber it is.');
  await f.service.flush();
  let turn = f.workspace.dotMemory.due(Date.now() + 30000)[0];
  f.workspace.dotMemory.update(turn, 'pending', -1);
  provider.mockResolvedValue(ok({ status: 'FAILED' }));
  await f.service.flush();
  turn = f.workspace.dotMemory.due(Date.now() + 300000)[0];
  expect(turn.eventId).toBeUndefined();
  f.workspace.dotMemory.update(turn, 'queued', -1);
  provider.mockResolvedValue(ok({ status: 'SUCCEEDED' }));
  await f.service.flush();
  expect(String(provider.mock.calls[2][0])).toContain('/v3/memories/add/');
  expect(f.service.status(f.dot.id).synced).toBe(1);
});
it('does not reuse another owner’s local cache or pending uploads when a database is reopened', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-memory-owner-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workspace.sqlite');
  const original = fixture(path, 'original-owner');
  original.workspace.dotMemory.cache(original.dot.id, [
    { id: 'private', text: 'Private amber preference' },
  ]);
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('Offline'));
  original.service.record(
    original.dot.id,
    'thread',
    'run',
    user,
    'Amber it is.',
  );
  await original.service.flush();
  await cleanup.pop()!();
  const otherOwner = fixture(path, 'other-owner', false);
  expect(otherOwner.service.status(otherOwner.dot.id)).toMatchObject({
    pending: 0,
    synced: 0,
    memories: [],
  });
  expect(await otherOwner.service.recall(otherOwner.dot.id, 'amber')).toEqual(
    [],
  );
  await otherOwner.service.flush();
  expect(provider).toHaveBeenCalledTimes(2);
});

it('honors global and Dot memory revocation for reads and queued writes, including in-flight recall', async () => {
  const f = fixture();
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => {
      f.store.updateSettings({ memoryAllowed: false });
      return ok({
        results: [{ id: 'private', memory: 'Must not enter the prompt.' }],
      });
    });
  expect(await f.service.recall(f.dot.id, 'color')).toEqual([]);
  f.service.record(f.dot.id, 'thread', 'run', user, 'Reply');
  await f.service.flush();
  expect(f.service.status(f.dot.id).pending).toBe(0);
  expect(provider).toHaveBeenCalledTimes(1);
  f.store.updateSettings({ memoryAllowed: true });
  f.workspace.updateDot(f.dot.id, { ...f.dot, memoryAllowed: false });
  expect(await f.service.recall(f.dot.id, 'color')).toEqual([]);
  f.service.record(f.dot.id, 'thread', 'run2', user, 'Reply');
  expect(provider).toHaveBeenCalledTimes(1);
});

it('keeps failed writes durable, uses only this Dot’s relevant cached facts, and sanitizes errors', async () => {
  const f = fixture();
  f.workspace.dotMemory.cache(f.dot.id, [
    { id: 'amber', text: 'Prefers amber dashboards' },
    { id: 'other', text: 'Loves jazz music' },
  ]);
  const another = f.workspace.createDot(
    f.dot.spaceId,
    'Other Dot',
    'Help with work',
    true,
    true,
  );
  f.workspace.dotMemory.cache(another.id, [
    { id: 'private', text: 'Private amber fact from another Dot' },
  ]);
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('private-memory-key provider secret'));
  expect(await f.service.recall(f.dot.id, 'amber dashboards')).toEqual([
    { id: 'amber', text: 'Prefers amber dashboards' },
  ]);
  f.service.record(f.dot.id, 'thread', 'run', user, 'Amber it is.');
  await f.service.flush();
  expect(f.service.status(f.dot.id)).toMatchObject({ pending: 1, synced: 0 });
  expect(JSON.stringify(f.service.status(f.dot.id))).not.toContain(
    'private-memory-key',
  );
  f.store.updateSettings({ memoryAllowed: false });
  const turn = f.workspace.dotMemory.due(Date.now() + 300000)[0];
  f.workspace.dotMemory.update(turn, 'queued', -1);
  await f.service.flush();
  expect(provider).toHaveBeenCalledTimes(2);
});

it('injects recall before a normal streamed reply and stores only the new completed turn', async () => {
  const f = fixture();
  const platform = new Platform(f.store, f.workspace, {
    ...mem0,
    apiKey: 'model-key',
    model: 'model',
    baseUrl: 'https://model.invalid/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    webSearchProvider: 'disabled',
  });
  cleanup.push(() => platform.stop());
  const research = {
    mode: 'live' as const,
    baseUrl: 'https://model.invalid/v1',
  };
  const app = createApp({
    store: f.store,
    platform,
    config: research,
    runner: new Runner(f.store, research),
  });
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url) =>
      String(url).includes('/search/')
        ? ok({
            results: [
              { id: 'fact', memory: 'The user prefers amber dashboards.' },
            ],
          })
        : String(url).includes('/add/')
          ? ok({ status: 'SUCCEEDED' })
          : completion({
              role: 'assistant',
              content: 'Your dashboard color is amber.',
            }),
    );
  const response = await app.request(`/api/copilotkit/agent/${f.dot.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: 'thread',
      runId: 'run',
      messages: [user],
      state: {},
      tools: [],
      context: [],
      forwardedProps: { userId: 'another-owner' },
    }),
  });
  const stream = await response.text();
  await platform.memory.flush();
  expect(stream).toContain('Your dashboard color is amber.');
  expect(stream).toContain('RUN_FINISHED');
  const modelBody = JSON.parse(
    String(
      provider.mock.calls.find(([url]) =>
        String(url).includes('model.invalid'),
      )![1]?.body,
    ),
  );
  expect(JSON.stringify(modelBody)).toContain(
    'The user prefers amber dashboards.',
  );
  const added = JSON.parse(
    String(
      provider.mock.calls.find(([url]) => String(url).includes('/add/'))![1]
        ?.body,
    ),
  );
  expect(added.user_id).toBe(`opendots:owner:${f.dot.id}`);
  expect(added.messages).toEqual([
    userMessage(),
    { role: 'assistant', content: 'Your dashboard color is amber.' },
  ]);
  expect(
    f.workspace.localConversations
      .get('thread')
      .messages.map((message) => message.role),
  ).toEqual(['user', 'assistant']);
  const status = await app.request(`/api/dots/${f.dot.id}/memory`);
  expect(await status.json()).toMatchObject({
    configured: true,
    synced: 1,
    pending: 0,
  });
  expect((await app.request('/api/dots/other-users-dot/memory')).status).toBe(
    404,
  );
});

const supermemory = {
  supermemoryApiKey: 'private-supermemory-key',
  supermemoryBaseUrl: 'https://supermemory.invalid',
};

it('prefers Mem0 when both memory keys are set', async () => {
  const f = fixture(':memory:', 'owner', true, { ...mem0, ...supermemory });
  expect(f.service.status(f.dot.id)).toMatchObject({
    configured: true,
    provider: 'mem0',
  });
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(ok({ results: [] }));
  await f.service.recall(f.dot.id, 'anything');
  expect(String(provider.mock.calls[0][0])).toContain('memory.invalid');
  expect(
    (provider.mock.calls[0][1]?.headers as Record<string, string>)
      .Authorization,
  ).toBe('Token private-memory-key');
});

it('reports no backend when neither key is set', () => {
  const f = fixture(':memory:', 'owner', true, {});
  expect(f.service.status(f.dot.id)).toMatchObject({
    configured: false,
    provider: null,
  });
});

it('falls back to Supermemory with one namespace per owner and Dot', async () => {
  const f = fixture(':memory:', 'owner', true, supermemory);
  expect(f.service.status(f.dot.id).provider).toBe('supermemory');
  const namespace = supermemoryNamespace('owner', f.dot.id);
  const calls: { url: string; body?: unknown; auth?: string }[] = [];
  let state = 'queued';
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    calls.push({
      url: String(url),
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
      auth: (options?.headers as Record<string, string>)?.Authorization,
    });
    if (String(url).endsWith('/search'))
      return ok({
        results: [{ id: 'mem', memory: 'Prefers amber dashboards.' }],
      });
    if (options?.method === 'POST') return ok({ id: 'doc-1', status: state });
    return ok({ id: 'doc-1', system: { status: state } });
  });
  expect(await f.service.recall(f.dot.id, 'What dashboard color?')).toEqual([
    { id: 'mem', text: 'Prefers amber dashboards.' },
  ]);
  expect(calls[0].url).toBe(
    `https://supermemory.invalid/ns/${namespace}/search`,
  );
  expect(calls[0].auth).toBe('Bearer private-supermemory-key');
  expect(calls[0].body).not.toHaveProperty('org_id');

  f.service.record(f.dot.id, 'thread', 'run', user, 'I will use amber.');
  await f.service.flush();
  const add = calls.find(
    (call) => call.url.endsWith('/document') && call.body,
  )!;
  expect(add.url).toBe(`https://supermemory.invalid/ns/${namespace}/document`);
  expect(add.body).toMatchObject({
    metadata: { dot_id: f.dot.id, thread_id: 'thread', run_id: 'run' },
  });
  expect(JSON.stringify(add.body)).toContain('amber dashboards');
  expect(f.service.status(f.dot.id)).toMatchObject({ pending: 1, synced: 0 });

  state = 'done';
  for (const turn of f.workspace.dotMemory.due(Date.now() + 60000))
    f.workspace.dotMemory.update(turn, 'pending', -1);
  await f.service.flush();
  expect(calls.at(-1)!.url).toBe(
    `https://supermemory.invalid/ns/${namespace}/document/doc-1`,
  );
  expect(f.service.status(f.dot.id)).toMatchObject({ pending: 0, synced: 1 });
  expect(JSON.stringify(f.service.status(f.dot.id))).not.toContain(
    'private-supermemory-key',
  );
  expect(supermemoryNamespace('other-owner', f.dot.id)).not.toBe(namespace);
});
