import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { BirdeyeService } from '../src/server/birdeye-service.js';
import { completion } from './fixtures/model-stream.js';

const MINT = 'So11111111111111111111111111111111111111112';
const SECRET = 'birdeye-chat-server-fixture-never-forwarded';
const OWNER = 'birdeye-chat-owner-fixture';
type ModelRequest = {
  tools?: { function?: { name?: string } }[];
  messages: { role: string; content?: unknown; tool_call_id?: string }[];
};
const fixtures: {
  platform: Platform;
  store: Store;
  workspace: WorkspaceStore;
}[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.platform.stop();
    f.workspace.close();
    f.store.close();
  }
});
const json = (body: unknown) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OWNER}`,
  },
  body: JSON.stringify(body),
});
const input = (threadId: string, content: string): RunAgentInput => ({
  threadId,
  runId: randomUUID(),
  messages: [{ id: randomUUID(), role: 'user', content }],
  state: {},
  tools: [],
  context: [],
  forwardedProps: {},
});
const toolCall = () =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'birdeye-price-research',
          type: 'function',
          function: {
            name: 'birdeye_research',
            arguments: JSON.stringify({
              workflow: 'watchlist',
              addresses: [MINT],
            }),
          },
        },
      ],
    },
    'tool_calls',
  );

function fixture(
  provider: typeof fetch = vi.fn<typeof fetch>(async () =>
    Response.json({
      success: true,
      data: {
        [MINT]: {
          value: 125.5,
          updateUnixTime: Math.floor(Date.now() / 1000),
          name: `Wrapped SOL ${SECRET}`,
        },
      },
    }),
  ),
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', randomUUID());
  const service = new BirdeyeService({
    env: { BIRDEYE_API_KEY: SECRET },
    fetchImpl: provider,
  });
  const config = {
    apiKey: 'model-fixture-no-real-inference',
    model: 'custom-model',
    baseUrl: 'https://birdeye-model-fixture.invalid/v1',
    runtimeUrl: 'http://localhost/api/copilotkit',
    voiceName: 'marin',
    slackUsers: [],
    ownerToken: OWNER,
    birdeye: service,
  };
  const platform = new Platform(store, workspace, config);
  fixtures.push({ platform, store, workspace });
  const research = { mode: 'live' as const, baseUrl: config.baseUrl };
  const app = createApp({
    store,
    platform,
    ownerToken: OWNER,
    config: research,
    runner: new Runner(store, research),
  });
  const dot = workspace.dots()[0];
  const chat = (threadId: string, prompt: string, dotId = dot.id) =>
    app.request(
      `/api/copilotkit/agent/${dotId}/run`,
      json(input(threadId, prompt)),
    );
  return {
    app,
    chat,
    config,
    dot,
    store,
    workspace,
    platform,
    provider,
    service,
  };
}
function modelFixture(
  handler: (
    request: ModelRequest,
    index: number,
  ) => Response | Promise<Response>,
) {
  const requests: ModelRequest[] = [];
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (url, init) => {
      if (
        String(url) !==
        'https://birdeye-model-fixture.invalid/v1/chat/completions'
      ) {
        if (String(url) === 'https://telemetry.copilotkit.ai/ingest')
          return new Response(null, { status: 204 });
        throw new Error('Unexpected external call during the chat fixture.');
      }
      const request = JSON.parse(String(init?.body)) as ModelRequest;
      requests.push(request);
      return handler(request, requests.length - 1);
    });
  return { network, requests };
}

describe('Birdeye through the main chat runtime', () => {
  it('executes Birdeye from a natural-language turn, answers from its tool result, and persists provenance only in the owning conversation', async () => {
    const f = fixture();
    const model = modelFixture((request, index) => {
      if (index === 0) {
        expect(
          request.tools?.some(
            (tool) => tool.function?.name === 'birdeye_research',
          ),
        ).toBe(true);
        return toolCall();
      }
      const result = request.messages.findLast(
        (message) =>
          message.role === 'tool' &&
          message.tool_call_id === 'birdeye-price-research',
      );
      expect(result).toBeDefined();
      const observation = JSON.parse(String(result!.content));
      expect(observation).toMatchObject({
        source: 'Birdeye',
        workflow: 'watchlist',
        observedAt: expect.any(Number),
      });
      expect(observation.data.items[0]).toMatchObject({
        address: MINT,
        priceUsd: 125.5,
        stale: false,
      });
      expect(String(result!.content)).not.toContain(SECRET);
      return completion({
        role: 'assistant',
        content: `Birdeye reports Wrapped SOL at $${observation.data.items[0].priceUsd} USD. This is market research; no trade was placed.`,
      });
    });
    const created = await f.app.request(
      '/api/conversations',
      json({ dotId: f.dot.id, title: 'Birdeye price research' }),
    );
    expect(created.status).toBe(201);
    const thread = (await created.json()) as {
      id: string;
      ownerId: string;
      dotId: string;
    };
    const unrelated = await f.platform.createConversation(
      f.dot.id,
      'Separate private conversation',
    );
    const response = await f.chat(
      thread.id,
      `Using Birdeye, what is the current USD price for the Solana token ${MINT}?`,
    );
    expect(response.status).toBe(200);
    const sse = await response.text();
    expect(sse).toContain('birdeye_research');
    expect(sse).toContain('TOOL_CALL_RESULT');
    expect(sse).toContain('Birdeye reports Wrapped SOL at $125.5 USD');
    expect(sse).toContain('RUN_FINISHED');
    expect(sse).not.toContain('RUN_ERROR');
    expect(sse).not.toContain(SECRET);
    expect(model.requests).toHaveLength(2);
    expect(f.provider).toHaveBeenCalledTimes(1);
    const history = await f.platform.history(thread.id);
    expect(history).toContain(`token ${MINT}`);
    expect(history).toContain('Birdeye reports Wrapped SOL at $125.5 USD');
    const events = f.platform.localRunner!.getThreadEvents(thread.id);
    const toolResult = events.find(
      (event) => event.type === EventType.TOOL_CALL_RESULT,
    );
    expect(toolResult).toMatchObject({
      toolCallId: 'birdeye-price-research',
      content: expect.stringContaining('"source":"Birdeye"'),
    });
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(f.workspace.requireThread(thread.id)).toMatchObject({
      ownerId: f.workspace.ownerId,
      dotId: f.dot.id,
    });
    expect(f.platform.localRunner!.getThreadMessages(unrelated.id)).toEqual([]);
    expect(f.platform.localRunner!.getThreadEvents(unrelated.id)).toEqual([]);
    const wrongDot = f.workspace.createDot(
      f.dot.spaceId,
      'Other Dot',
      'A separate Dot',
      false,
      false,
    );
    expect(
      (
        await f.chat(
          thread.id,
          'Read this research from another Dot',
          wrongDot.id,
        )
      ).status,
    ).toBe(403);
    expect(f.provider).toHaveBeenCalledTimes(1);
  });

  it.each(['dot', 'workspace'] as const)(
    'omits Birdeye from model tools when %s research is disabled',
    async (scope) => {
      const f = fixture();
      const thread = await f.platform.createConversation(
        f.dot.id,
        'Disabled research',
      );
      if (scope === 'dot')
        f.workspace.updateDot(f.dot.id, {
          ...f.workspace.dot(f.dot.id)!,
          researchAllowed: false,
        });
      else f.store.updateSettings({ researchAllowed: false });
      const model = modelFixture((request) => {
        expect(
          request.tools?.filter((tool) =>
            tool.function?.name?.startsWith('birdeye_'),
          ),
        ).toEqual([]);
        return completion({
          role: 'assistant',
          content: 'Research is disabled for this conversation.',
        });
      });
      const response = await f.chat(
        thread.id,
        `Use Birdeye to get the price of ${MINT}.`,
      );
      const sse = await response.text();
      expect(sse).toContain('Research is disabled for this conversation.');
      expect(model.requests).toHaveLength(1);
      expect(f.provider).not.toHaveBeenCalled();
      expect(sse).not.toContain(SECRET);
    },
  );

  it('rejects a paused chat turn before calling either the model or Birdeye', async () => {
    const f = fixture();
    const thread = await f.platform.createConversation(
      f.dot.id,
      'Paused research',
    );
    f.store.updateSettings({ paused: true });
    const model = modelFixture(() => {
      throw new Error('A paused turn must never reach model inference.');
    });
    const response = await f.chat(thread.id, `Use Birdeye to get ${MINT}.`);
    const sse = await response.text();
    expect(sse).toContain('RUN_ERROR');
    expect(model.requests).toHaveLength(0);
    expect(f.provider).not.toHaveBeenCalled();
  });

  it.each(['dot', 'paused'] as const)(
    'discards an in-flight provider result when %s access is revoked and makes no further provider calls',
    async (scope) => {
      let resolveProvider!: (response: Response) => void;
      let contacted!: () => void;
      const started = new Promise<void>((resolve) => {
        contacted = resolve;
      });
      const provider = vi.fn<typeof fetch>(async () => {
        contacted();
        return new Promise<Response>((resolve) => {
          resolveProvider = resolve;
        });
      });
      const f = fixture(provider);
      const thread = await f.platform.createConversation(
        f.dot.id,
        'Research revoked during read',
      );
      const model = modelFixture((_request, index) =>
        index === 0
          ? toolCall()
          : completion({
              role: 'assistant',
              content: 'Research access is disabled.',
            }),
      );
      const response = await f.chat(
        thread.id,
        `Use Birdeye to inspect ${MINT}.`,
      );
      const text = response.text();
      await started;
      if (scope === 'dot')
        f.workspace.updateDot(f.dot.id, {
          ...f.workspace.dot(f.dot.id)!,
          researchAllowed: false,
        });
      else f.store.updateSettings({ paused: true });
      resolveProvider(
        Response.json({
          success: true,
          data: {
            [MINT]: {
              value: 987654321,
              updateUnixTime: Math.floor(Date.now() / 1000),
              name: 'IN_FLIGHT_REVOKED_RESEARCH_MARKER',
            },
          },
        }),
      );
      const sse = await text;
      expect(sse).toContain('RUN_ERROR');
      expect(sse).not.toContain('IN_FLIGHT_REVOKED_RESEARCH_MARKER');
      expect(sse).not.toContain('987654321');
      expect(sse).not.toContain(SECRET);
      expect(model.requests).toHaveLength(1);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(f.platform.localRunner!.getThreadEvents(thread.id)),
      ).not.toContain('IN_FLIGHT_REVOKED_RESEARCH_MARKER');
      const following = await f.chat(
        thread.id,
        `Try Birdeye again for ${MINT}.`,
      );
      await following.text();
      expect(provider).toHaveBeenCalledTimes(1);
      if (scope === 'paused') expect(model.requests).toHaveLength(1);
      else
        expect(
          model.requests
            .at(-1)
            ?.tools?.filter((tool) =>
              tool.function?.name?.startsWith('birdeye_'),
            ),
        ).toEqual([]);
    },
  );
});
