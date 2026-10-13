import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Runner } from '../src/server/runner.js';
import { BirdeyeService } from '../src/server/birdeye-service.js';
import { birdeyeTools } from '../src/server/birdeye-tools.js';
import { companionAllows } from '../src/server/companion.js';

const mint = 'So11111111111111111111111111111111111111112';
const secret = 'private-birdeye-fixture-only';
const fixtures: {
  store: Store;
  workspace: WorkspaceStore;
  platform: Platform;
}[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.platform.stop();
    fixture.workspace.close();
    fixture.store.close();
  }
});
function fixture(
  options: { configured?: boolean; fetchImpl?: typeof fetch } = {},
) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', randomUUID());
  const service = new BirdeyeService({
    env: options.configured === false ? {} : { BIRDEYE_API_KEY: secret },
    fetchImpl:
      options.fetchImpl ??
      vi.fn(async () =>
        Response.json({
          success: true,
          data: {
            [mint]: {
              value: 125,
              updateUnixTime: Math.floor(Date.now() / 1000),
            },
          },
        }),
      ),
  });
  const config = {
    baseUrl: 'https://model.invalid',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    birdeye: service,
  };
  const platform = new Platform(store, workspace, config);
  fixtures.push({ store, workspace, platform });
  const thread = workspace.bindThread(
    randomUUID(),
    workspace.dots()[0].id,
    'Research',
  );
  const research = { mode: 'sample' as const, baseUrl: config.baseUrl };
  const app = createApp({
    store,
    runner: new Runner(store, research),
    config: research,
    platform,
    ownerToken: 'fixture-owner',
    origin: 'https://app.example',
  });
  const headers = {
    Authorization: 'Bearer fixture-owner',
    Origin: 'https://app.example',
    'Content-Type': 'application/json',
  };
  const post = (path: string, body: unknown) =>
    app.request('https://app.example/api/birdeye/' + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  return { store, workspace, platform, service, thread, app, headers, post };
}

it('keeps research under owner, same-origin, conversation and current research permissions', async () => {
  const f = fixture();
  const path = 'https://app.example/api/birdeye/status?threadId=' + f.thread.id;
  expect((await f.app.request(path)).status).toBe(401);
  expect(
    (
      await f.app.request(path, {
        headers: { ...f.headers, Origin: 'https://other.example' },
      })
    ).status,
  ).toBe(403);
  const status = await f.app.request(path, { headers: f.headers });
  expect(status.status).toBe(200);
  expect(JSON.stringify(await status.json())).not.toContain(secret);
  expect(
    (
      await f.post('query', {
        threadId: randomUUID(),
        workflow: 'watchlist',
        addresses: [mint],
      })
    ).status,
  ).toBe(403);
  f.workspace.updateDot(f.thread.dotId, {
    ...f.workspace.dot(f.thread.dotId)!,
    researchAllowed: false,
  });
  expect(
    (
      await f.post('query', {
        threadId: f.thread.id,
        workflow: 'watchlist',
        addresses: [mint],
      })
    ).status,
  ).toBe(403);
  f.workspace.updateDot(f.thread.dotId, {
    ...f.workspace.dot(f.thread.dotId)!,
    researchAllowed: true,
  });
  f.store.updateSettings({ paused: true });
  expect(
    (
      await f.post('query', {
        threadId: f.thread.id,
        workflow: 'watchlist',
        addresses: [mint],
      })
    ).status,
  ).toBe(403);
});

it('validates inputs before upstream calls, never exposing credentials or accepting arbitrary origins', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({ success: true, data: {} }),
  );
  const f = fixture({ fetchImpl });
  for (const query of [
    { workflow: 'investigation', address: 'not-a-mint' },
    { workflow: 'watchlist', addresses: [mint], url: 'https://other.example' },
    { workflow: 'watchlist', addresses: Array(101).fill(mint) },
  ])
    expect(
      (await f.post('query', { threadId: f.thread.id, ...query })).status,
    ).toBe(400);
  expect(fetchImpl).not.toHaveBeenCalled();
  const response = await f.post('query', {
    threadId: f.thread.id,
    workflow: 'watchlist',
    addresses: [mint],
  });
  expect(response.status).toBe(200);
  expect(String(fetchImpl.mock.calls[0][0])).toMatch(
    /^https:\/\/public-api\.birdeye\.so\//,
  );
  expect(String(fetchImpl.mock.calls[0][0])).not.toContain(secret);
  expect(JSON.stringify(await response.json())).not.toContain(secret);
});

it('surfaces missing key configuration and rejects a permission revoked during an upstream read', async () => {
  const missing = fixture({ configured: false });
  const absent = await missing.post('query', {
    threadId: missing.thread.id,
    workflow: 'watchlist',
    addresses: [mint],
  });
  expect(absent.status).toBe(503);
  expect(await absent.json()).toMatchObject({
    source: 'Birdeye',
    error: expect.any(String),
  });
  let resolve!: (value: Response) => void;
  let contacted!: () => void;
  const contact = new Promise<void>((r) => {
    contacted = r;
  });
  const f = fixture({
    fetchImpl: async () => {
      contacted();
      return new Promise<Response>((r) => {
        resolve = r;
      });
    },
  });
  const waiting = f.post('query', {
    threadId: f.thread.id,
    workflow: 'watchlist',
    addresses: [mint],
  });
  await contact;
  f.store.updateSettings({ researchAllowed: false });
  resolve(Response.json({ success: true, data: { [mint]: { value: 125 } } }));
  expect((await waiting).status).toBe(403);
});

it('isolates durable alert changes and results by conversation', async () => {
  const f = fixture();
  const other = f.workspace.bindThread(randomUUID(), f.thread.dotId, 'Other');
  const saved = await f.post('alerts', {
    threadId: f.thread.id,
    address: mint,
    kind: 'absolute',
    direction: 'above',
    threshold: 150,
  });
  expect(saved.status).toBe(201);
  const { alert } = await saved.json();
  const unrelated = await f.app.request(
    `https://app.example/api/birdeye/alerts?threadId=${other.id}`,
    { headers: f.headers },
  );
  expect((await unrelated.json()).alerts).toEqual([]);
  expect(
    (
      await f.app.request(
        `https://app.example/api/birdeye/alerts/${alert.id}?threadId=${other.id}`,
        { method: 'DELETE', headers: f.headers },
      )
    ).status,
  ).toBe(404);
  expect(f.platform.birdeyeMonitor.list(f.thread.id)).toHaveLength(1);
  expect(
    (
      await f.app.request(
        `https://app.example/api/birdeye/alerts/${alert.id}?threadId=${f.thread.id}`,
        { method: 'DELETE', headers: f.headers },
      )
    ).status,
  ).toBe(200);
});

it('never runs a cancelled chat tool and checks permissions after provider completion', async () => {
  const fetchImpl = vi.fn(async () =>
    Response.json({ success: true, data: {} }),
  );
  const f = fixture({ fetchImpl });
  const controller = new AbortController();
  controller.abort();
  const tool = birdeyeTools(f.service, () => {}, controller.signal).find(
    (t) => t.name === 'birdeye_research',
  )!;
  await expect(
    tool.execute!({ workflow: 'watchlist', addresses: [mint] }),
  ).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
  let checks = 0;
  const guarded = birdeyeTools(f.service, () => {
    if (++checks > 1) throw Error('Research was disabled.');
  }).find((t) => t.name === 'birdeye_research')!;
  await expect(
    guarded.execute!({ workflow: 'watchlist', addresses: [mint] }),
  ).rejects.toThrow('disabled');
});

it('allows paired phone research reads while keeping persistent alert changes owner-only', () => {
  expect(companionAllows('POST', '/api/birdeye/query')).toBe(true);
  expect(companionAllows('POST', '/api/birdeye/stream')).toBe(true);
  expect(companionAllows('GET', '/api/birdeye/status')).toBe(true);
  expect(companionAllows('POST', '/api/birdeye/alerts')).toBe(false);
  expect(companionAllows('DELETE', '/api/birdeye/alerts/123')).toBe(false);
});
