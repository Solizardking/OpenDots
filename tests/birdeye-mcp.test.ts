import { expect, it, vi } from 'vitest';
import {
  BirdeyeMcpService,
  BIRDEYE_MCP_ENDPOINT,
} from '../src/server/birdeye-mcp.js';

const key = 'fixture-private-birdeye-key';
const tools = [
  {
    name: 'token_price',
    description: 'Read token prices.',
    inputSchema: {
      type: 'object' as const,
      properties: { address: { type: 'string' } },
    },
    annotations: { readOnlyHint: true },
  },
  { name: 'unknown_operation', inputSchema: { type: 'object' as const } },
  {
    name: 'change_account',
    inputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: true, destructiveHint: true },
  },
];

function provider(
  options: {
    initializedError?: boolean;
    callError?: boolean;
    secretResult?: boolean;
  } = {},
) {
  return vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe(BIRDEYE_MCP_ENDPOINT);
    expect(new Headers(init?.headers).get('x-api-key')).toBe(key);
    expect(init?.redirect).toBe('error');
    const request = JSON.parse(String(init?.body || '{}'));
    expect(JSON.stringify(request)).not.toContain(key);
    if (request.method === 'notifications/initialized') {
      if (options.initializedError)
        return Response.json(
          {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32000,
              message: `Session verification temporarily unavailable (Redis connection issue). ${key}`,
            },
          },
          { status: 503 },
        );
      return new Response(null, { status: 202 });
    }
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : request.method === 'tools/list'
          ? { tools }
          : {
              content: [
                {
                  type: 'text',
                  text: options.secretResult ? key : 'Token price: 1.25 USD',
                },
              ],
              ...(options.callError ? { isError: true } : {}),
            };
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  });
}

it('uses the official authenticated MCP transport and caches only current catalog metadata', async () => {
  const fetchImpl = provider();
  const service = new BirdeyeMcpService({
    env: { BIRDEYE_API_KEY: ` ${key} ` },
    fetchImpl,
  });
  expect(service.status()).toMatchObject({
    configured: true,
    state: 'not-checked',
  });
  const catalog = await service.catalog('price');
  expect(catalog.tools).toEqual([
    expect.objectContaining({ name: 'token_price', callable: true }),
  ]);
  expect(catalog.total).toBe(3);
  expect(service.status().state).toBe('available');
  const before = fetchImpl.mock.calls.length;
  await service.catalog();
  expect(fetchImpl).toHaveBeenCalledTimes(before);
  expect(JSON.stringify(service.status())).not.toContain(key);
  expect(JSON.stringify(catalog)).not.toContain(key);
  const first = await service.call('token_price', { address: 'public-mint' });
  const second = await service.call('token_price', { address: 'public-mint' });
  expect(first).toMatchObject({
    source: 'Birdeye',
    transport: 'mcp',
    tool: 'token_price',
    result: { content: [{ type: 'text', text: 'Token price: 1.25 USD' }] },
  });
  expect(second.result).toEqual(first.result);
  expect(
    fetchImpl.mock.calls.filter(
      ([, init]) =>
        JSON.parse(String(init?.body || '{}')).method === 'tools/call',
    ),
  ).toHaveLength(2);
});

it('refuses unannotated, destructive and unknown tools before calling them', async () => {
  const fetchImpl = provider();
  const service = new BirdeyeMcpService({
    env: { BIRDEYE_API_KEY: key },
    fetchImpl,
  });
  const catalog = await service.catalog();
  expect(catalog.tools.filter((tool) => !tool.callable)).toHaveLength(2);
  await expect(service.call('unknown_operation', {})).rejects.toMatchObject({
    status: 403,
    code: 'read-only-required',
  });
  await expect(service.call('change_account', {})).rejects.toMatchObject({
    status: 403,
    code: 'read-only-required',
  });
  await expect(service.call('not_in_catalog', {})).rejects.toMatchObject({
    status: 404,
    code: 'unknown-tool',
  });
  expect(
    fetchImpl.mock.calls.filter(
      ([, init]) =>
        JSON.parse(String(init?.body || '{}')).method === 'tools/call',
    ),
  ).toHaveLength(0);
});

it.each([
  { headers: { 'x-api-key': 'untrusted' } },
  { filters: { endpoint: 'https://other.example' } },
  { private_key: 'untrusted' },
])(
  'blocks credential and destination overrides before connecting',
  async (args) => {
    const fetchImpl = provider();
    const service = new BirdeyeMcpService({
      env: { BIRDEYE_API_KEY: key },
      fetchImpl,
    });
    await expect(service.call('token_price', args)).rejects.toMatchObject({
      status: 400,
      code: 'invalid-input',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);

it('reports the provider session outage without leaking raw errors or credentials', async () => {
  const service = new BirdeyeMcpService({
    env: { BIRDEYE_API_KEY: key },
    fetchImpl: provider({ initializedError: true }),
  });
  await expect(service.catalog()).rejects.toMatchObject({
    status: 503,
    code: 'session-unavailable',
  });
  expect(service.status()).toMatchObject({
    state: 'unavailable',
    error: { status: 503, code: 'session-unavailable' },
  });
  expect(JSON.stringify(service.status())).not.toContain(key);
  expect(JSON.stringify(service.status())).not.toContain('Redis');
});

it('redacts reflected keys while preserving MCP tool failure semantics', async () => {
  const service = new BirdeyeMcpService({
    env: { BIRDEYE_API_KEY: key },
    fetchImpl: provider({ secretResult: true, callError: true }),
  });
  const result = await service.call('token_price', {});
  expect(result.result).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: '[redacted]' }],
  });
  expect(JSON.stringify(result)).not.toContain(key);
});

it('stops cancelled and unconfigured callers without opening a provider session', async () => {
  const fetchImpl = provider();
  const controller = new AbortController();
  controller.abort();
  await expect(
    new BirdeyeMcpService({ env: { BIRDEYE_API_KEY: key }, fetchImpl }).catalog(
      '',
      controller.signal,
    ),
  ).rejects.toThrow();
  await expect(
    new BirdeyeMcpService({ env: {}, fetchImpl }).catalog(),
  ).rejects.toMatchObject({ status: 503, code: 'missing-configuration' });
  expect(fetchImpl).not.toHaveBeenCalled();
});
