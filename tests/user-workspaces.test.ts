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
