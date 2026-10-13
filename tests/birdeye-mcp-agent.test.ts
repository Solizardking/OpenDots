import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { lastValueFrom, toArray } from 'rxjs';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { UserWorkspaces } from '../src/server/user-workspaces.js';
import { BirdeyeMcpService } from '../src/server/birdeye-mcp.js';
import {
  BIRDEYE_MEME_ENDPOINT,
  createBirdeyeMemeService,
} from '../src/server/birdeye-meme.js';
import type { PlatformConfig } from '../src/server/platform-config.js';
import type { SolanaUser } from '../src/shared/auth-types.js';
import { completion } from './fixtures/model-stream.js';

const MINT = 'HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump';
const BIRDEYE_KEY = 'fixture-server-only-birdeye-key';
const MODEL_KEY = 'fixture-server-only-model-key';
const TOOL_NAMES = [
  'birdeye_mcp_catalog',
  'birdeye_mcp_call',
  'birdeye_meme_detail',
];
const databases: Array<{ close(): void }> = [];
const userFixtures: Array<{
  workspaces: UserWorkspaces;
  directory: string;
}> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of userFixtures.splice(0)) {
    fixture.workspaces.stopRunners();
    await fixture.workspaces.stop();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  databases.splice(0).forEach((database) => database.close());
});

function providerConfig(
  memeFetch: typeof fetch,
  mcpFetch: typeof fetch,
): PlatformConfig {
  const env = { BIRDEYE_API_KEY: BIRDEYE_KEY };
  return {
    apiKey: MODEL_KEY,
    model: 'meta/muse-wonder',
    baseUrl: 'https://model.invalid/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    birdeyeMcp: new BirdeyeMcpService({ env, fetchImpl: mcpFetch }),
    birdeyeMeme: createBirdeyeMemeService({ env, fetchImpl: memeFetch }),
  };
}

const modelRequest = (init?: RequestInit) =>
  JSON.parse(String(init?.body)) as {
    tools: Array<{ function: { name: string } }>;
    messages: Array<Record<string, unknown>>;
  };
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('offers all three official Birdeye tools in a normal Dot run and removes them when either research permission is disabled', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('birdeye-tools-thread', dot.id, 'Token research');
  const memeFetch = vi.fn<typeof fetch>();
  const mcpFetch = vi.fn<typeof fetch>();
  const agent = new DotAgent(
    store,
    workspace,
    providerConfig(memeFetch, mcpFetch),
    dot.id,
  );
  const input: RunAgentInput = {
    threadId: 'birdeye-tools-thread',
    runId: 'birdeye-tools-run',
    state: {},
    context: [],
    messages: [
      { id: 'user', role: 'user', content: 'What tools are available?' },
    ],
    tools: [],
    forwardedProps: {},
  };
  const names = async () => {
    const provider = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        completion({ role: 'assistant', content: 'Ready.' }),
      );
    try {
      const events = await lastValueFrom(
        agent.clone().run(input).pipe(toArray()),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: EventType.RUN_FINISHED }),
      );
      expect(events.some((event) => event.type === EventType.RUN_ERROR)).toBe(
        false,
      );
      const request = modelRequest(provider.mock.calls[0][1]);
      expect(JSON.stringify(request)).not.toContain(BIRDEYE_KEY);
      expect(JSON.stringify(request)).not.toContain(MODEL_KEY);
      return request.tools.map((tool) => tool.function.name);
    } finally {
      provider.mockRestore();
    }
  };

  expect(await names()).toEqual(expect.arrayContaining(TOOL_NAMES));
  workspace.updateDot(dot.id, { ...dot, researchAllowed: false });
  const dotDisabled = await names();
  for (const name of TOOL_NAMES) expect(dotDisabled).not.toContain(name);
  workspace.updateDot(dot.id, { ...dot, researchAllowed: true });
  store.updateSettings({ researchAllowed: false });
  const workspaceDisabled = await names();
  for (const name of TOOL_NAMES) expect(workspaceDisabled).not.toContain(name);
  expect(memeFetch).not.toHaveBeenCalled();
  expect(mcpFetch).not.toHaveBeenCalled();
});

it('executes exact meme details through a private user conversation and returns its data to the model and ordinary chat SSE without exposing credentials', async () => {
  const fixtureData = {
    address: MINT,
    name: 'Requested meme fixture',
    price: null,
    liquidity: 1250,
    extension: { rawField: null },
  };
  const memeFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ success: true, data: fixtureData }));
  const mcpFetch = vi.fn<typeof fetch>();
  const directory = mkdtempSync(join(tmpdir(), 'opendots-birdeye-agent-'));
  const workspaces = new UserWorkspaces(
    directory,
    providerConfig(memeFetch, mcpFetch),
  );
  userFixtures.push({ directory, workspaces });
  const user: SolanaUser = {
    id: randomUUID(),
    walletAddress: 'fixture-wallet',
    displayName: null,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };
  const app = workspaces.app(user);
  const workspaceResponse = await app.request('/api/workspace');
  expect(workspaceResponse.status).toBe(200);
  const workspaceText = await workspaceResponse.text();
  expect(workspaceText).not.toContain(BIRDEYE_KEY);
  expect(workspaceText).not.toContain(MODEL_KEY);
  const workspace = JSON.parse(workspaceText);
  const dotId = workspace.dots[0].id;
  const threadResponse = await app.request(
    '/api/conversations',
    json({
      dotId,
      title: 'Read this meme token',
    }),
  );
  expect(threadResponse.status).toBe(201);
  const thread = await threadResponse.json();
  const provider = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      completion(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'read-requested-meme',
              type: 'function',
              function: {
                name: 'birdeye_meme_detail',
                arguments: JSON.stringify({ address: MINT }),
              },
            },
          ],
        },
        'tool_calls',
      ),
    )
    .mockResolvedValueOnce(
      completion({
        role: 'assistant',
        content:
          'Birdeye returned the requested meme details. Its price is unavailable.',
      }),
    );

  const response = await app.request(
    `/api/copilotkit/agent/${dotId}/run`,
    json({
      threadId: thread.id,
      runId: 'birdeye-meme-chat',
      messages: [
        {
          id: 'user',
          role: 'user',
          content: `Read Birdeye meme details for ${MINT}.`,
        },
      ],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  );
  expect(response.status).toBe(200);
  const stream = await response.text();
  expect(stream).toContain(
    'Birdeye returned the requested meme details. Its price is unavailable.',
  );
  expect(stream).toContain('RUN_FINISHED');
  expect(stream).not.toContain('RUN_ERROR');
  expect(stream).not.toContain(BIRDEYE_KEY);
  expect(stream).not.toContain(MODEL_KEY);
  const events = stream
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  const resultEvent = events.find(
    (event) =>
      event.type === EventType.TOOL_CALL_RESULT &&
      event.toolCallId === 'read-requested-meme',
  );
  expect(resultEvent).toBeDefined();
  expect(JSON.parse(String(resultEvent!.content))).toMatchObject({
    source: 'Birdeye',
    transport: 'rest',
    endpoint: BIRDEYE_MEME_ENDPOINT,
    chain: 'solana',
    observedAt: expect.any(Number),
    data: fixtureData,
  });

  expect(provider).toHaveBeenCalledTimes(2);
  const firstRequest = modelRequest(provider.mock.calls[0][1]);
  expect(firstRequest.tools.map((tool) => tool.function.name)).toEqual(
    expect.arrayContaining(TOOL_NAMES),
  );
  const continuation = modelRequest(provider.mock.calls[1][1]);
  const toolMessage = continuation.messages.find(
    (message) =>
      message.role === 'tool' && message.tool_call_id === 'read-requested-meme',
  );
  expect(toolMessage).toBeDefined();
  expect(JSON.parse(String(toolMessage!.content)).data).toEqual(fixtureData);
  for (const [input, init] of provider.mock.calls) {
    expect(String(input)).toBe('https://model.invalid/v1/chat/completions');
    expect(String(init?.body)).not.toContain(BIRDEYE_KEY);
    expect(String(init?.body)).not.toContain(MODEL_KEY);
  }
  expect(memeFetch).toHaveBeenCalledOnce();
  const [url, init] = memeFetch.mock.calls[0];
  expect(String(url)).toBe(
    `https://public-api.birdeye.so${BIRDEYE_MEME_ENDPOINT}?address=${MINT}`,
  );
  expect(init?.method).toBe('GET');
  expect(init?.body).toBeUndefined();
  const headers = new Headers(init?.headers);
  expect(headers.get('X-API-KEY')).toBe(BIRDEYE_KEY);
  expect(headers.get('x-chain')).toBe('solana');
  expect(
    [...headers.entries()].filter(([, value]) => value.includes(BIRDEYE_KEY)),
  ).toEqual([['x-api-key', BIRDEYE_KEY]]);
  expect(mcpFetch).not.toHaveBeenCalled();
});
