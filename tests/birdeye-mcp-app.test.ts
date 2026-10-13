import { expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { BirdeyeMcpService } from '../src/server/birdeye-mcp.js';
import { createBirdeyeMemeService } from '../src/server/birdeye-meme.js';

it('mounts MCP and meme reads behind real owner, origin and conversation boundaries', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'fixture');
  const key = 'fixture-server-birdeye-key';
  const mint = 'HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump';
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      success: true,
      data: { address: mint, symbol: 'RFKFC', price: null },
    }),
  );
  const config = {
    mode: 'live' as const,
    apiKey: 'fixture-model',
    model: 'meta/muse-wonder',
    baseUrl: 'https://provider.invalid/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    birdeyeMcp: new BirdeyeMcpService({
      env: { BIRDEYE_API_KEY: key },
      fetchImpl,
    }),
    birdeyeMeme: createBirdeyeMemeService({
      env: { BIRDEYE_API_KEY: key },
      fetchImpl,
    }),
  };
  const platform = new Platform(store, workspace, config);
  const app = createApp({
    store,
    platform,
    config,
    runner: new Runner(store, config),
    ownerToken: 'fixture-owner-token',
    origin: 'https://app.example',
  });
  try {
    const thread = await platform.createConversation(
      workspace.dots()[0].id,
      'Birdeye research',
    );
    const statusUrl = `https://app.example/api/birdeye/mcp/status?threadId=${thread.id}`;
    const headers = {
      Authorization: 'Bearer fixture-owner-token',
      Origin: 'https://app.example',
    };
    expect((await app.request(statusUrl)).status).toBe(401);
    expect(
      (
        await app.request(statusUrl, {
          headers: { ...headers, Origin: 'https://other.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(statusUrl, {
          headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    const status = await app.request(statusUrl, { headers });
    expect(status.status).toBe(200);
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(await status.json()).toMatchObject({
      source: 'Birdeye',
      configured: true,
      state: 'not-checked',
    });
    const detail = await app.request(
      `https://app.example/api/birdeye/meme-detail?threadId=${thread.id}&address=${mint}`,
      { headers },
    );
    expect(detail.status).toBe(200);
    const body = await detail.text();
    expect(body).not.toContain(key);
    expect(JSON.parse(body)).toMatchObject({
      transport: 'rest',
      data: { address: mint, symbol: 'RFKFC', price: null },
    });
    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/defi/v3/token/meme/detail/single?address=',
    );
    expect(
      new Headers(fetchImpl.mock.calls[0][1]?.headers).get('X-API-KEY'),
    ).toBe(key);
    const calls = fetchImpl.mock.calls.length;
    expect(
      (
        await app.request(
          `https://app.example/api/birdeye/meme-detail?threadId=foreign-thread&address=${mint}`,
          { headers },
        )
      ).status,
    ).toBe(403);
    store.updateSettings({ researchAllowed: false });
    expect((await app.request(statusUrl, { headers })).status).toBe(403);
    expect(
      (
        await app.request(
          `https://app.example/api/birdeye/meme-detail?threadId=${thread.id}&address=${mint}`,
          { headers },
        )
      ).status,
    ).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  } finally {
    await platform.stop();
    workspace.close();
    store.close();
  }
});
