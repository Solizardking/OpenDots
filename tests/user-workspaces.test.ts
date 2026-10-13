import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { completion } from './fixtures/model-stream.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UserWorkspaces } from '../src/server/user-workspaces.js';
import { modelConfigFromEnv } from '../src/server/model-config.js';
import type { SolanaUser } from '../src/shared/auth-types.js';
const fixtures: { directory: string; workspaces: UserWorkspaces }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.workspaces.stopRunners();
    await f.workspaces.stop();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

it('runs scheduled work through a private user runtime without a browser session or owner access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgptee-schedules-'));
  const config = {
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'fixture',
    model: 'fixture',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    ownerToken: 'original-owner-token',
  };
  const workspaces = new UserWorkspaces(directory, config);
  fixtures.push({ directory, workspaces });
  const root = new Hono();
  root.all('/api/*', (c) => {
    const app = workspaces.internal(c.req.header('authorization'));
    return app ? app.fetch(c.req.raw) : c.json({ error: 'Sign in.' }, 401);
  });
  const server = serve({ fetch: root.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No test port.');
    config.runtimeUrl = `http://127.0.0.1:${address.port}/api/copilotkit`;
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).startsWith('http://127.0.0.1:')
        ? nativeFetch(input, init)
        : Promise.resolve(
            completion({
              role: 'assistant',
              content: 'Scheduled user work complete.',
            }),
          ),
    );
    const user: SolanaUser = {
      id: randomUUID(),
      walletAddress: 'test wallet',
      displayName: null,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    const app = workspaces.app(user);
    const workspace = await (await app.request('/api/workspace')).json();
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const thread = await (
      await app.request(
        '/api/conversations',
        json({
          dotId: workspace.dots[0].id,
          title: 'Private scheduled conversation',
        }),
      )
    ).json();
    const task = await (
      await app.request(
        '/api/tasks',
        json({ threadId: thread.id, prompt: 'Complete my scheduled work.' }),
      )
    ).json();
    await vi.waitFor(
      async () => {
        const detail = await (
          await app.request(`/api/tasks/${task.id}`)
        ).json();
        expect(detail.task.status).toBe('completed');
        expect(detail.runs[0].result.text).toBe(
          'Scheduled user work complete.',
        );
      },
      { timeout: 4000, interval: 100 },
    );
    expect(workspaces.internal('Bearer original-owner-token')).toBeUndefined();
    expect((await nativeFetch(`${config.runtimeUrl}/info`)).status).toBe(401);
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it('keeps pages, memories, agent identities, and encrypted wallet vaults separate per user', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solana-dots-users-'));
  const workspaces = new UserWorkspaces(directory, {
    baseUrl: 'https://example.com',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  fixtures.push({ directory, workspaces });
  const user = (): SolanaUser => ({
    id: randomUUID(),
    walletAddress: randomUUID(),
    displayName: null,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  });
  const aUser = user(),
    bUser = user();
  const a = workspaces.app(aUser),
    b = workspaces.app(bUser);
  const request = (app: typeof a, path: string, body?: unknown) =>
    app.request(`http://localhost/api${path}`, {
      method: body ? 'POST' : 'GET',
      ...(body
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    });
  const wa = await (await request(a, '/workspace')).json(),
    wb = await (await request(b, '/workspace')).json();
  expect(wa.spaces[0].id).not.toBe(wb.spaces[0].id);
  expect(wa.dots[0].id).not.toBe(wb.dots[0].id);
  expect(
    (await request(a, '/memories', { text: 'Private user A preference' }))
      .status,
  ).toBe(201);
  expect((await (await request(b, '/state')).json()).memories).toEqual([]);
  expect((await request(b, `/spaces/${wa.spaces[0].id}/pages`)).status).toBe(
    404,
  );
  expect((await request(b, `/dots/${wa.dots[0].id}/computer`)).status).not.toBe(
    200,
  );
  expect(existsSync(join(directory, aUser.id, 'ows'))).toBe(true);
  expect(existsSync(join(directory, bUser.id, 'ows'))).toBe(true);
});

it('streams the server-configured Muse Wonder default for isolated users and newly created Dots without exposing its key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-muse-users-'));
  const apiKey = 'fixture-server-only-openrouter-key';
  const workspaces = new UserWorkspaces(directory, {
    ...modelConfigFromEnv({
      OPENROUTER_API_KEY: apiKey,
      OPENROUTER_MUSEMODEL: 'meta/muse-wonder',
      OPENROUTER_MODEL: 'legacy/live-model',
      OPENROUTER_CLAUDE_MODEL: 'legacy/batch-model:batch',
    }),
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  fixtures.push({ directory, workspaces });
  const provider = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    expect(String(input)).toBe('https://openrouter.ai/api/v1/chat/completions');
    return Promise.resolve(
      completion({ role: 'assistant', content: 'Muse Wonder answered.' }),
    );
  });
  const user = (): SolanaUser => ({
    id: randomUUID(),
    walletAddress: randomUUID(),
    displayName: null,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  });
  const a = workspaces.app(user()),
    b = workspaces.app(user());
  const json = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const workspace = async (app: typeof a) => {
    const response = await app.request('/api/workspace');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(apiKey);
    const body = JSON.parse(text);
    expect(body.setup).toMatchObject({
      model: true,
      modelName: 'meta/muse-wonder',
      missing: [],
    });
    expect(JSON.stringify(body.setup)).not.toContain(apiKey);
    return body;
  };
  const wa = await workspace(a),
    wb = await workspace(b);
  expect(wa.dots[0].id).not.toBe(wb.dots[0].id);
  expect(wa.spaces[0].id).not.toBe(wb.spaces[0].id);
  const createdDot = await a.request(
    '/api/dots',
    json({
      spaceId: wa.spaces[0].id,
      name: 'New Muse specialist',
      instructions: 'Answer questions using the shared server model.',
      researchAllowed: false,
      memoryAllowed: false,
    }),
  );
  expect(createdDot.status).toBe(201);
  const dot = await createdDot.json();
  const runs = [
    { app: a, dotId: wa.dots[0].id, prompt: 'Private user A question' },
    { app: b, dotId: wb.dots[0].id, prompt: 'Private user B question' },
    { app: a, dotId: dot.id, prompt: 'New specialist question' },
  ];
  const threads: string[] = [];
  for (const [index, run] of runs.entries()) {
    const created = await run.app.request(
      '/api/conversations',
      json({ dotId: run.dotId, title: run.prompt }),
    );
    expect(created.status).toBe(201);
    const thread = await created.json();
    threads.push(thread.id);
    const response = await run.app.request(
      `/api/copilotkit/agent/${run.dotId}/run`,
      json({
        threadId: thread.id,
        runId: `muse-run-${index}`,
        messages: [{ id: `user-${index}`, role: 'user', content: run.prompt }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: { model: 'client/override-model' },
      }),
    );
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain('Muse Wonder answered.');
    expect(stream).toContain('RUN_FINISHED');
    expect(stream).not.toContain('RUN_ERROR');
    expect(stream).not.toContain(apiKey);
  }
  expect(provider).toHaveBeenCalledTimes(3);
  for (const [index, [input, init]] of provider.mock.calls.entries()) {
    expect(String(input)).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${apiKey}`);
    expect(
      [...headers.entries()].filter(([, value]) => value.includes(apiKey)),
    ).toEqual([['authorization', `Bearer ${apiKey}`]]);
    const body = String(init?.body);
    expect(body).not.toContain(apiKey);
    expect(body).not.toContain('client/override-model');
    expect(JSON.parse(body)).toMatchObject({
      model: 'meta/muse-wonder',
      stream: true,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: runs[index].prompt }),
      ]),
    });
    for (const other of runs.filter((_, otherIndex) => otherIndex !== index))
      expect(body).not.toContain(other.prompt);
  }
  const aWorkspace = await workspace(a),
    bWorkspace = await workspace(b);
  expect(
    aWorkspace.conversations.map((thread: { id: string }) => thread.id),
  ).toEqual(expect.arrayContaining([threads[0], threads[2]]));
  expect(
    bWorkspace.conversations.map((thread: { id: string }) => thread.id),
  ).toEqual([threads[1]]);
  expect(JSON.stringify(aWorkspace)).not.toContain(threads[1]);
  expect(JSON.stringify(bWorkspace)).not.toContain(threads[0]);
});
