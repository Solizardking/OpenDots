import { afterEach, expect, it, vi } from 'vitest';
import { AbstractAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable, lastValueFrom, toArray } from 'rxjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { LocalConversationRunner } from '../src/server/local-runner.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';
import { pageReviewTool } from '../src/shared/page-review.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
function fixture(path = ':memory:', ownerToken?: string) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(path, 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const config = {
    mode: 'live' as const,
    baseUrl: 'https://provider.invalid/v1',
  };
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'fixture',
    baseUrl: config.baseUrl,
    runtimeUrl: 'http://localhost/api/copilotkit',
    voiceName: 'marin',
    slackUsers: [],
    ownerToken,
  });
  const app = createApp({
    store,
    platform,
    ownerToken,
    config,
    runner: new Runner(store, config),
  });
  const dot = workspace.dots()[0];
  return { workspace, platform, app, dot };
}
const runInput = (
  threadId: string,
  content: string,
  id = 'user',
): RunAgentInput => ({
  threadId,
  runId: `run-${id}`,
  messages: [{ id, role: 'user', content }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});

it('creates a conversation and streams an answer through the normal API with only model configuration', async () => {
  const f = fixture();
  const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    completion({
      role: 'assistant',
      content: 'Hello from the configured model.',
    }),
  );
  const created = await f.app.request(
    '/api/conversations',
    json({ dotId: f.dot.id, title: 'Local conversation' }),
  );
  expect(created.status).toBe(201);
  const thread = await created.json();
  const response = await f.app.request(
    `/api/copilotkit/agent/${f.dot.id}/run`,
    json(runInput(thread.id, 'Hello')),
  );
  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain('Hello from the configured model.');
  expect(stream).toContain('RUN_FINISHED');
  expect(stream).not.toContain('RUN_ERROR');
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await f.platform.history(thread.id)).toContain(
    'assistant: Hello from the configured model.',
  );
  const saved = await f.app.request(
    `/api/conversations/${thread.id}/page`,
    json({ title: 'Saved chat', parentId: null }),
  );
  expect(saved.status).toBe(201);
  expect(await saved.json()).toMatchObject({
    content: expect.stringContaining('Hello from the configured model.'),
  });
});

it('reloads persisted history after reopening SQLite and sends it to a follow-up turn', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'opendots-chat-'));
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'workspace.db');
  const first = fixture(path);
  const thread = await first.platform.createConversation(
    first.dot.id,
    'Remember',
  );
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    completion({ role: 'assistant', content: 'Your word is acorn.' }),
  );
  await (
    await first.app.request(
      `/api/copilotkit/agent/${first.dot.id}/run`,
      json(runInput(thread.id, 'Remember acorn')),
    )
  ).text();
  const second = fixture(path);
  const replay = await (
    await second.app.request(
      `/api/copilotkit/agent/${second.dot.id}/connect`,
      json({ ...runInput(thread.id, 'Unused connect payload'), messages: [] }),
    )
  ).text();
  expect(replay).toContain('MESSAGES_SNAPSHOT');
  expect(replay).toContain('Your word is acorn.');
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      completion({ role: 'assistant', content: 'Acorn.' }),
    );
  await (
    await second.app.request(
      `/api/copilotkit/agent/${second.dot.id}/run`,
      json(runInput(thread.id, 'What word?', 'followup')),
    )
  ).text();
  const body = JSON.parse(String(provider.mock.calls.at(-1)?.[1]?.body));
  expect(body.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Remember acorn' }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Your word is acorn.',
      }),
      expect.objectContaining({ role: 'user', content: 'What word?' }),
    ]),
  );
  expect(
    second.platform
      .localRunner!.getThreadMessages(thread.id)
      .filter((message) => message.role === 'assistant'),
  ).toHaveLength(2);
});

it('creates a page conversation and executes a scheduled turn using the local runtime', async () => {
  const f = fixture();
  const page = f.workspace.pages.create(f.dot.spaceId, {
    title: 'Notes',
    content: 'Some notes',
    parentId: null,
  });
  const thread = await f.platform.pages.conversation(
    f.dot.spaceId,
    page.id,
    f.dot.id,
  );
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith('http://localhost/'))
      return f.app.request(String(url), init);
    return completion({
      role: 'assistant',
      content: 'Scheduled work complete.',
    });
  });
  expect(
    await f.platform.turn(
      thread.id,
      'Check notes',
      new AbortController().signal,
      { opendotsSource: 'scheduled_task' },
    ),
  ).toBe('Scheduled work complete.');
  expect(f.platform.localRunner!.getThreadMessages(thread.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^opendots:scheduled_task:/),
        role: 'user',
        content: 'Check notes',
      }),
    ]),
  );
});

it('keeps owner, origin, and Dot scope checks for local chat and history', async () => {
  const f = fixture(':memory:', 'owner-token');
  const thread = await f.platform.createConversation(f.dot.id, 'Private');
  const other = f.workspace.createDot(
    f.dot.spaceId,
    'Other',
    'Help',
    false,
    false,
  );
  expect(
    (await f.app.request(`/api/copilotkit/threads/${thread.id}/messages`))
      .status,
  ).toBe(401);
  const authenticated = {
    ...json(runInput(thread.id, 'Hi')),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer owner-token',
    },
  };
  expect(
    (
      await f.app.request(
        `/api/copilotkit/agent/${other.id}/run`,
        authenticated,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.app.request(`/api/copilotkit/agent/${f.dot.id}/run`, {
        ...authenticated,
        headers: {
          ...authenticated.headers,
          Origin: 'https://untrusted.example',
        },
      })
    ).status,
  ).toBe(403);
  expect(() => f.platform.localRunner!.getThreadMessages('foreign')).toThrow(
    'does not belong',
  );
});

it('persists a pending human review and accepts its result on the next turn', async () => {
  const f = fixture();
  const thread = await f.platform.createConversation(f.dot.id, 'Review');
  const input = runInput(thread.id, 'Show me a draft for review.');
  input.tools = [pageReviewTool];
  const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    completion(
      {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'review-draft',
            type: 'function',
            function: {
              name: pageReviewTool.name,
              arguments: JSON.stringify({
                title: 'Draft',
                content: 'Draft text',
                spaceId: f.dot.spaceId,
              }),
            },
          },
        ],
      },
      'tool_calls',
    ),
  );
  const first = await (
    await f.app.request(`/api/copilotkit/agent/${f.dot.id}/run`, json(input))
  ).text();
  expect(first).toContain(pageReviewTool.name);
  expect(f.platform.localRunner!.getThreadMessages(thread.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: expect.arrayContaining([
          expect.objectContaining({ id: 'review-draft' }),
        ]),
      }),
    ]),
  );
  provider.mockResolvedValueOnce(
    completion({ role: 'assistant', content: 'You declined the draft.' }),
  );
  const resumed = {
    ...input,
    runId: 'review-resume',
    messages: [
      {
        id: 'decision',
        role: 'tool' as const,
        toolCallId: 'review-draft',
        content: 'The owner declined. Do not save it.',
      },
    ],
  };
  const reply = await (
    await f.app.request(`/api/copilotkit/agent/${f.dot.id}/run`, json(resumed))
  ).text();
  expect(reply).toContain('You declined the draft.');
  expect(reply).not.toContain('RUN_ERROR');
  expect(f.workspace.pages.list(f.dot.spaceId)).toHaveLength(0);
  expect(f.platform.localRunner!.getThreadMessages(thread.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'decision',
        role: 'tool',
        toolCallId: 'review-draft',
      }),
    ]),
  );
});

it('stops the exact scheduled SSE run when its caller cancels', async () => {
  const f = fixture();
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanup.push(() => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected an HTTP port.');
  const runtimeOrigin = `http://127.0.0.1:${address.port}`;
  f.platform.config.runtimeUrl = `${runtimeOrigin}/api/copilotkit`;
  const nativeFetch = globalThis.fetch;
  const thread = await f.platform.createConversation(f.dot.id, 'Cancel');
  const controller = new AbortController();
  let stopBody: { runId: string } | undefined;
  let providerAborted = false;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).startsWith(runtimeOrigin)) {
      if (String(url).includes('/stop/'))
        stopBody = JSON.parse(String(init?.body));
      return nativeFetch(url, init);
    }
    providerStarted();
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          providerAborted = true;
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  });
  const result = f.platform.turn(thread.id, 'Start work', controller.signal);
  const rejected = expect(result).rejects.toThrow('Caller cancelled');
  await started;
  controller.abort(new Error('Caller cancelled'));
  await vi.waitFor(() => expect(providerAborted).toBe(true));
  await rejected;
  expect(stopBody?.runId).toEqual(expect.any(String));
  await f.platform.localRunner!.stopAll();
  expect(await f.platform.localRunner!.isRunning({ threadId: thread.id })).toBe(
    false,
  );
});

it('rejects concurrent turns, respects the run ID when stopping, and saves the interrupted transcript', async () => {
  const f = fixture();
  const thread = await f.platform.createConversation(f.dot.id, 'Slow');
  class SlowAgent extends AbstractAgent {
    private finish?: () => void;
    run(input: RunAgentInput) {
      return new Observable<BaseEvent>((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: 'reply',
          delta: 'Partial answer',
          role: 'assistant',
        });
        this.finish = () => subscriber.complete();
      });
    }
    abortRun() {
      this.finish?.();
    }
  }
  const agent = new SlowAgent({ agentId: f.dot.id });
  const runner = new LocalConversationRunner(f.workspace);
  const input = runInput(thread.id, 'Hello');
  const finished = lastValueFrom(
    runner.run({ threadId: thread.id, agent, input }).pipe(toArray()),
  );
  await vi.waitFor(() =>
    expect(agent.messages.some((message) => message.id === 'reply')).toBe(true),
  );
  expect(() => runner.run({ threadId: thread.id, agent, input })).toThrow(
    'already running',
  );
  expect(await runner.stop({ threadId: thread.id, runId: 'other-run' })).toBe(
    false,
  );
  expect(await runner.isRunning({ threadId: thread.id })).toBe(true);
  expect(await runner.stop({ threadId: thread.id, runId: input.runId })).toBe(
    true,
  );
  expect(await finished).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: EventType.RUN_FINISHED }),
    ]),
  );
  expect(await runner.isRunning({ threadId: thread.id })).toBe(false);
  expect(runner.getThreadMessages(thread.id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Partial answer' }),
    ]),
  );
});
