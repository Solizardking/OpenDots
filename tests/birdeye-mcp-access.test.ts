import { expect, it, vi } from 'vitest';
import { birdeyeMcpRoutes } from '../src/server/birdeye-mcp-routes.js';
import { BirdeyeMcpError } from '../src/server/birdeye-mcp.js';
import { BirdeyeMemeError } from '../src/server/birdeye-meme.js';
import type { Platform } from '../src/server/platform.js';

const mint = 'So11111111111111111111111111111111111111112';
const threadId = 'owned-research-conversation';
const secret = 'private-birdeye-test-credential';
const paths = {
  status: '/birdeye/mcp/status',
  catalog: '/birdeye/mcp/catalog',
  call: '/birdeye/mcp/call',
  meme: '/birdeye/meme-detail',
} as const;
type Route = keyof typeof paths;
const routes = Object.keys(paths) as Route[];

function fixture(options: { configured?: boolean } = {}) {
  const permissions = {
    paused: false,
    researchAllowed: true,
    dotResearchAllowed: true,
  };
  const allowed = vi.fn(
    (id: string) =>
      id === threadId &&
      !permissions.paused &&
      permissions.researchAllowed &&
      permissions.dotResearchAllowed,
  );
  const mcp = {
    status: vi.fn(() => ({
      source: 'Birdeye',
      transport: 'mcp',
      configured: true,
      endpoint: 'https://mcp.birdeye.so/mcp',
      state: 'not-checked',
    })),
    catalog: vi.fn(async (_search?: string, _signal?: AbortSignal) => ({
      source: 'Birdeye',
      tools: [{ name: 'token_price', callable: true }],
    })),
    call: vi.fn(
      async (
        name: string,
        _arguments: Record<string, unknown>,
        _signal?: AbortSignal,
      ) => ({
        source: 'Birdeye',
        tool: name,
        result: { content: [{ type: 'text', text: 'Market data' }] },
      }),
    ),
  };
  const meme = {
    read: vi.fn(async (_address: string, _signal?: AbortSignal) => ({
      source: 'Birdeye',
      transport: 'rest',
      data: { address: mint, price: 1.23 },
    })),
  };
  const platform = {
    birdeyeAllowed: allowed,
    config:
      options.configured === false
        ? {}
        : { birdeyeMcp: mcp, birdeyeMeme: meme },
  } as unknown as Platform;
  const app = birdeyeMcpRoutes(platform);
  const request = (
    route: Route,
    conversation = threadId,
    init: RequestInit = {},
  ) => {
    const url = new URL(paths[route], 'https://app.example');
    if (route === 'call')
      return app.request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: conversation,
          name: 'token_price',
          arguments: { address: mint },
        }),
        ...init,
      });
    url.searchParams.set('threadId', conversation);
    if (route === 'meme') url.searchParams.set('address', mint);
    return app.request(url.toString(), init);
  };
  const post = (value: unknown) =>
    app.request('https://app.example' + paths.call, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  return { app, permissions, allowed, mcp, meme, request, post };
}

it.each(routes)(
  'keeps %s under the current conversation research permissions',
  async (route) => {
    const f = fixture();
    expect((await f.request(route, 'another-workspace-thread')).status).toBe(
      403,
    );
    f.permissions.dotResearchAllowed = false;
    expect((await f.request(route)).status).toBe(403);
    f.permissions.dotResearchAllowed = true;
    f.permissions.researchAllowed = false;
    expect((await f.request(route)).status).toBe(403);
    f.permissions.researchAllowed = true;
    f.permissions.paused = true;
    expect((await f.request(route)).status).toBe(403);
    expect(f.mcp.status).not.toHaveBeenCalled();
    expect(f.mcp.catalog).not.toHaveBeenCalled();
    expect(f.mcp.call).not.toHaveBeenCalled();
    expect(f.meme.read).not.toHaveBeenCalled();
  },
);

it('validates strict query fields, lengths, duplicates and Solana addresses before requests', async () => {
  const f = fixture();
  for (const [path, params] of [
    [paths.status, `threadId=${threadId}&headers=x-api-key`],
    [paths.catalog, `threadId=${threadId}&search=${'x'.repeat(101)}`],
    [paths.catalog, `threadId=${threadId}&endpoint=https://other.example`],
    [paths.catalog, `threadId=${threadId}&threadId=other`],
    [paths.catalog, 'threadId='],
    [paths.catalog, `threadId=${'x'.repeat(129)}`],
    [paths.meme, `threadId=${threadId}&address=not-a-mint`],
    [paths.meme, `threadId=${threadId}&address=${'1'.repeat(44)}`],
    [paths.meme, `threadId=${threadId}&address=${mint}&apiKey=${secret}`],
  ]) {
    const response = await f.app.request(
      `https://app.example${path}?${params}`,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
  }
  expect(f.mcp.status).not.toHaveBeenCalled();
  expect(f.mcp.catalog).not.toHaveBeenCalled();
  expect(f.meme.read).not.toHaveBeenCalled();
});

it('rejects unknown body fields, credential destinations and oversized UTF-8 arguments', async () => {
  const f = fixture();
  const valid = { threadId, name: 'token_price', arguments: { address: mint } };
  for (const input of [
    null,
    [],
    { ...valid, headers: { 'x-api-key': secret } },
    { ...valid, endpoint: 'https://other.example' },
    { ...valid, apiKey: secret },
    { ...valid, name: 'x'.repeat(129) },
    { ...valid, name: '' },
    { ...valid, arguments: [] },
    { ...valid, arguments: { address: mint, headers: {} } },
    { ...valid, arguments: { nested: { endpoint: 'https://other.example' } } },
    { ...valid, arguments: { nested: [{ API_KEY: secret }] } },
    { ...valid, arguments: { value: 'é'.repeat(8_000) } },
    { ...valid, arguments: { value: 'x'.repeat(16_000) } },
  ]) {
    const response = await f.post(input);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
  }
  const invalidJson = await f.request('call', threadId, { body: '{' });
  expect(invalidJson.status).toBe(400);
  expect(f.mcp.call).not.toHaveBeenCalled();
});

it('passes validated calls, search and request signals to the fixed server services', async () => {
  const f = fixture();
  const catalog = await f.app.request(
    `https://app.example${paths.catalog}?threadId=${threadId}&search=price`,
  );
  expect(catalog.status).toBe(200);
  expect(f.mcp.catalog).toHaveBeenCalledWith('price', expect.any(AbortSignal));
  expect((await f.request('call')).status).toBe(200);
  expect(f.mcp.call).toHaveBeenCalledWith(
    'token_price',
    { address: mint },
    expect.any(AbortSignal),
  );
  expect((await f.request('meme')).status).toBe(200);
  expect(f.meme.read).toHaveBeenCalledWith(mint, expect.any(AbortSignal));
  expect(f.allowed).toHaveBeenCalledTimes(6);
  const status = await f.request('status');
  expect(await status.json()).toMatchObject({
    configured: true,
    transport: 'mcp',
  });
});

it.each(['catalog', 'call', 'meme'] as const)(
  'rechecks permission after the %s provider completes',
  async (route) => {
    const f = fixture();
    const denied = () => {
      f.permissions.researchAllowed = false;
    };
    if (route === 'catalog')
      f.mcp.catalog.mockImplementationOnce(async () => {
        denied();
        return { source: 'Birdeye', tools: [] };
      });
    else if (route === 'call')
      f.mcp.call.mockImplementationOnce(async (name) => {
        denied();
        return { source: 'Birdeye', tool: name, result: { content: [] } };
      });
    else
      f.meme.read.mockImplementationOnce(async () => {
        denied();
        return {
          source: 'Birdeye',
          transport: 'rest',
          data: { address: mint, price: 1.23 },
        };
      });
    const response = await f.request(route);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'research-disabled' });
    expect(f.allowed).toHaveBeenCalledTimes(2);
  },
);

it.each(['catalog', 'call', 'meme'] as const)(
  'stops an already cancelled %s request before contacting the service',
  async (route) => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    const response = await f.request(route, threadId, {
      signal: controller.signal,
    });
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: 'cancelled' });
    expect(f.mcp.catalog).not.toHaveBeenCalled();
    expect(f.mcp.call).not.toHaveBeenCalled();
    expect(f.meme.read).not.toHaveBeenCalled();
  },
);

it('suppresses a completed result after cancellation and sanitizes DOM abort exceptions', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.mcp.call.mockImplementationOnce(async (name) => {
    controller.abort();
    return { source: 'Birdeye', tool: name, result: { content: [] } };
  });
  const response = await f.request('call', threadId, {
    signal: controller.signal,
  });
  expect(response.status).toBe(408);
  const interrupted = fixture();
  const abort = new AbortController();
  interrupted.mcp.call.mockImplementationOnce(async () => {
    abort.abort();
    throw new DOMException(secret, 'AbortError');
  });
  const cancelled = await interrupted.request('call', threadId, {
    signal: abort.signal,
  });
  expect(cancelled.status).toBe(408);
  expect(await cancelled.text()).not.toContain(secret);
});

it('returns a safe unconfigured status and blocks data requests with missing service configuration', async () => {
  const f = fixture({ configured: false });
  expect(await (await f.request('status')).json()).toMatchObject({
    configured: false,
  });
  for (const route of ['catalog', 'call', 'meme'] as const) {
    const response = await f.request(route);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'missing-configuration',
    });
  }
});

it('preserves known provider failure status and codes without returning upstream text', async () => {
  const f = fixture();
  f.mcp.catalog.mockRejectedValueOnce(
    new BirdeyeMcpError(503, secret, 'session-unavailable'),
  );
  const unavailable = await f.request('catalog');
  expect(unavailable.status).toBe(503);
  const sessionError = await unavailable.json();
  expect(sessionError).toMatchObject({
    code: 'session-unavailable',
  });
  expect(JSON.stringify(sessionError)).not.toContain(secret);
  f.mcp.call.mockRejectedValueOnce(
    new BirdeyeMcpError(403, secret, 'read-only-required'),
  );
  const denied = await f.request('call');
  expect(denied.status).toBe(403);
  const readOnlyError = await denied.json();
  expect(readOnlyError).toMatchObject({ code: 'read-only-required' });
  expect(JSON.stringify(readOnlyError)).not.toContain(secret);
  f.meme.read.mockRejectedValueOnce(
    new BirdeyeMemeError(400, secret, 'compute_unit_allowance_exhausted'),
  );
  const quota = await f.request('meme');
  expect(quota.status).toBe(400);
  const quotaError = await quota.json();
  expect(quotaError).toMatchObject({
    code: 'compute_unit_allowance_exhausted',
  });
  expect(JSON.stringify(quotaError)).not.toContain(secret);
  for (const failure of [
    new Error(secret),
    new BirdeyeMcpError(200, secret, secret),
    new BirdeyeMcpError(999, secret, secret),
  ]) {
    f.mcp.call.mockRejectedValueOnce(failure);
    const response = await f.request('call');
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(secret);
  }
});
