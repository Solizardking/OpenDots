import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { lastValueFrom, toArray } from 'rxjs';
import {
  publicMcpTransport,
  isPublicMcpAddress,
  resolvePublicMcpDestination,
} from '../src/server/public-mcp-transport.js';
import { ConnectionService } from '../src/server/connections.js';
import { DotAgent } from '../src/server/dot-agent.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { completion } from './fixtures/model-stream.js';
import { UserWorkspaces } from '../src/server/user-workspaces.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { createSecureContext } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  pinned: [] as { address: string; family: number }[][],
  agents: [] as import('undici').Agent[],
}));
vi.mock('node:dns/promises', async (original) => ({
  ...(await original<typeof import('node:dns/promises')>()),
  lookup: network.lookup,
}));
vi.mock('undici', async (original) => {
  const actual = await original<typeof import('undici')>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
        const connect = options?.connect;
        if (
          !connect ||
          typeof connect === 'function' ||
          !('lookup' in connect) ||
          !connect.lookup
        )
          throw new Error('Missing pinned socket lookup.');
        const checkedLookup = connect.lookup;
        super({
          ...options,
          connect: {
            ...connect,
            lookup: (hostname, options, callback) =>
              checkedLookup(hostname, options, (error, addresses, family) => {
                if (error) return callback(error, []);
                network.pinned.push(
                  typeof addresses === 'string'
                    ? [{ address: addresses, family: family! }]
                    : addresses,
                );
                // Only the fixture socket mapping is replaced. Production's
                // classification, DNS validation and lookup callback stay real.
                callback(
                  null,
                  options.all
                    ? [{ address: '127.0.0.1', family: 4 }]
                    : '127.0.0.1',
                  4,
                );
              }),
          },
        });
        network.agents.push(this);
      }
    },
  };
});

let server: Server;
let url: string;
let hits: {
  method: string;
  url: string;
  host?: string;
  auth?: string;
  body: unknown;
}[];
beforeEach(async () => {
  network.lookup
    .mockReset()
    .mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  network.pinned.length = 0;
  network.agents.length = 0;
  hits = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    hits.push({
      method: request.method!,
      url: request.url!,
      host: request.headers.host,
      auth: request.headers.authorization,
      body,
    });
    if (request.url === '/redirect') {
      response.writeHead(302, {
        Location: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/private`,
      });
      response.end();
    } else if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': public fixture\n\n');
    } else if (!body?.id && body?.id !== 0) {
      response.writeHead(202);
      response.end();
    } else {
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: body.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'public fixture', version: '1.0.0' },
            }
          : body.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'echo',
                    inputSchema: {
                      type: 'object',
                      properties: { value: { type: 'string' } },
                    },
                    annotations: { readOnlyHint: true },
                  },
                ],
              }
            : {
                content: [
                  {
                    type: 'text',
                    text: String(
                      body.params?.arguments?.value ?? 'fixture response',
                    ),
                  },
                ],
              };
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      });
      response.end(
        gzipSync(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://public.example:${(server.address() as import('node:net').AddressInfo).port}/mcp`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(network.agents.map((agent) => agent.destroy()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const transport = () =>
  publicMcpTransport({
    url,
    token: 'fixture-token',
    signal: AbortSignal.timeout(5000),
  });
// Inspect the SDK's configured fetch to cover its metadata/auth URL variants,
// native Request bodies, and body cancellation independently of JSON-RPC.
const fetchOf = (value: ReturnType<typeof transport>) =>
  (value as unknown as { _fetch: typeof fetch })._fetch;

it('blocks private, reserved and disguised addresses without blocking ordinary public ranges', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '192.0.0.8',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '0:0:0:0:0:ffff:a00:1',
    'fc00::1',
    'fe80::1',
    'fe80::1%lo0',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2001:2::1',
    '2002:7f00:1::',
    '2001::1',
    '3fff::1',
    '4000::1',
    '64:ff9b::a00:1',
    '64:ff9b:1::808:808',
    '::ffff:0:127.0.0.1',
  ])
    expect(isPublicMcpAddress(address), address).toBe(false);
  for (const address of [
    '8.8.8.8',
    '1.1.1.1',
    '192.0.0.9',
    '192.0.0.10',
    '192.0.3.1',
    '198.51.101.1',
    '203.0.114.1',
    '192.31.196.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2001:1::1',
    '2001:3::1',
  ])
    expect(isPublicMcpAddress(address), address).toBe(true);
});

it('rejects canonicalized numeric/IPv6 private URLs, mixed DNS and non-web schemes before opening a socket', async () => {
  const value = transport();
  try {
    for (const input of [
      'http://127.1',
      'http://2130706433',
      'http://0x7f000001',
      'http://0177.0.0.1',
      'http://[::1]',
      'http://[::ffff:7f00:1]',
      'http://[fc00::1]',
      'http://localhost',
      'file:///etc/passwd',
      'https://user:secret@public.example/mcp',
    ])
      await expect(fetchOf(value)(input)).rejects.toThrow();
    network.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '::1', family: 6 },
    ]);
    await expect(fetchOf(value)(url)).rejects.toThrow('private network');
    expect(network.agents).toHaveLength(0);
    expect(hits).toHaveLength(0);
  } finally {
    await value.close();
  }
});

it('pins real MCP POST/SSE sockets, preserves host and bearer, decompresses responses and releases completed pools', async () => {
  const value = transport();
  const client = new Client({ name: 'fixture', version: '1.0.0' });
  try {
    await client.connect(value);
    expect((await client.listTools()).tools[0].name).toBe('echo');
    expect(
      await client.callTool({
        name: 'echo',
        arguments: { value: 'Public endpoint works' },
      }),
    ).toMatchObject({ content: [{ text: 'Public endpoint works' }] });
    await vi.waitFor(() =>
      expect(hits.some((hit) => hit.method === 'GET')).toBe(true),
    );
    expect(
      hits.every(
        (hit) =>
          hit.host === new URL(url).host && hit.auth === 'Bearer fixture-token',
      ),
    ).toBe(true);
    expect(network.pinned.length).toBeGreaterThan(0);
    expect(
      network.pinned.flat().every((item) => item.address === '8.8.8.8'),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(network.agents.filter((agent) => !agent.destroyed)).toHaveLength(
        1,
      ),
    );
  } finally {
    await client.close();
  }
  expect(network.agents.every((agent) => agent.destroyed)).toBe(true);
});

it('supports dual-stack lookup all mode and prevents a changed DNS answer from reaching the next request', async () => {
  network.lookup
    .mockResolvedValueOnce([
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ])
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  const value = transport();
  try {
    const first = await fetchOf(value)(url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(first.url).toBe(url);
    expect((await first.json()).result.tools[0].name).toBe('echo');
    expect(network.pinned[0]).toEqual([
      { address: '2001:4860:4860::8888', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ]);
    await expect(fetchOf(value)(url)).rejects.toThrow('private network');
    expect(hits).toHaveLength(1);
    expect(network.lookup).toHaveBeenCalledTimes(2);
  } finally {
    await value.close();
  }
});

it('streams native Request POST bodies and refuses redirects before contacting their private destination', async () => {
  const value = transport();
  try {
    const request = new Request(url, {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            ),
          );
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const response = await fetchOf(value)(request);
    expect((await response.json()).result.tools).toHaveLength(1);
    await expect(
      fetchOf(value)(url.replace('/mcp', '/redirect'), { redirect: 'follow' }),
    ).rejects.toThrow('redirects are blocked');
    expect(hits.some((hit) => hit.url === '/private')).toBe(false);
  } finally {
    await value.close();
  }
});

it('aborts unresolved DNS and never opens a late socket after transport closure', async () => {
  let resolve: (
    value: { address: string; family: number }[],
  ) => void = () => {};
  network.lookup.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const value = transport();
  const pending = fetchOf(value)(url);
  const rejected = expect(pending).rejects.toThrow('MCP connection closed');
  await vi.waitFor(() => expect(network.lookup).toHaveBeenCalledTimes(1));
  await value.close();
  await rejected;
  resolve([{ address: '8.8.8.8', family: 4 }]);
  await Promise.resolve();
  expect(network.agents).toHaveLength(0);
  expect(hits).toHaveLength(0);
  await expect(
    resolvePublicMcpDestination(url, AbortSignal.abort(new Error('Cancelled'))),
  ).rejects.toThrow('Cancelled');
});

it('cancels an active SSE body and destroys its socket pool', async () => {
  const value = transport();
  try {
    const response = await fetchOf(value)(url);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      'public fixture',
    );
    await reader.cancel();
    expect(network.agents.every((agent) => agent.destroyed)).toBe(true);
  } finally {
    await value.close();
  }
});

it('retains the public TLS server name and rejects an untrusted certificate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'public-mcp-tls-'));
  const keyFile = join(directory, 'fixture.key');
  const certFile = join(directory, 'fixture.crt');
  // An ephemeral test certificate, never a user's key or a trusted production CA.
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '1',
      '-subj',
      '/CN=public.example',
    ],
    { stdio: 'ignore' },
  );
  let serverName: string | undefined;
  try {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const certificate = {
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
    };
    server = createHttpsServer({
      ...certificate,
      SNICallback: (name, callback) => {
        serverName = name;
        callback(null, createSecureContext(certificate));
      },
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    url = `https://public.example:${(server.address() as import('node:net').AddressInfo).port}/mcp`;
    const value = transport();
    try {
      await expect(fetchOf(value)(url)).rejects.toThrow('fetch failed');
      expect(serverName).toBe('public.example');
      expect(network.pinned[0][0].address).toBe('8.8.8.8');
      expect(network.agents.every((agent) => agent.destroyed)).toBe(true);
    } finally {
      await value.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('public user routes block private MCP discovery while preserving the legacy owner transport', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'public-mcp-users-'));
  const users = new UserWorkspaces(directory, {
    baseUrl: 'https://provider.invalid',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  const workspace = new WorkspaceStore(':memory:', 'legacy-owner');
  try {
    const app = users.app({
      id: randomUUID(),
      walletAddress: 'fixture wallet',
      displayName: null,
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    });
    const state = await (
      await app.request('http://localhost/api/workspace')
    ).json();
    const privateUrl = url.replace('public.example', '127.0.0.1');
    const rejected = await app.request(
      `http://localhost/api/dots/${state.dots[0].id}/connections`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Private', url: privateUrl }),
      },
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error).toContain('private network');
    expect(hits).toHaveLength(0);
    const owner = new ConnectionService(workspace.connections);
    expect(
      (
        await owner.add(workspace.dots()[0].id, {
          name: 'Local owner',
          url: privateUrl,
        })
      ).tools[0].name,
    ).toBe('echo');
    expect(hits.length).toBeGreaterThan(0);
  } finally {
    users.stopRunners();
    await users.stop();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('DotAgent keeps private MCP calls blocked even for a previously stored connection', async () => {
  const workspace = new WorkspaceStore(':memory:', 'fixture-owner');
  const store = new Store(':memory:');
  try {
    const dot = workspace.dots()[0];
    workspace.bindThread('thread', dot.id, 'Fixture');
    workspace.connections.create(
      dot.id,
      { name: 'Fixture', url: url.replace('public.example', '127.0.0.1') },
      [
        {
          name: 'echo',
          title: 'Echo',
          description: '',
          inputSchema: { type: 'object' },
          readOnly: true,
          enabled: true,
          requiresApproval: false,
        },
      ],
    );
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      ++calls === 1
        ? completion(
            {
              tool_calls: [
                {
                  index: 0,
                  id: 'call',
                  type: 'function',
                  function: { name: 'fixture__echo', arguments: '{}' },
                },
              ],
            },
            'tool_calls',
          )
        : completion({
            role: 'assistant',
            content: 'Completed with a blocked private connection.',
          }),
    );
    const agent = new DotAgent(
      store,
      workspace,
      {
        apiKey: 'fixture',
        model: 'fixture',
        baseUrl: 'https://provider.invalid/v1',
        runtimeUrl: '',
        voiceName: 'marin',
        slackUsers: [],
        publicMcp: true,
      },
      dot.id,
    );
    const events = await lastValueFrom(
      agent
        .run({
          threadId: 'thread',
          runId: 'run',
          state: {},
          messages: [
            { id: 'message', role: 'user', content: 'Use the connected tool.' },
          ],
          tools: [],
          context: [],
          forwardedProps: {},
        })
        .pipe(toArray()),
    );
    expect(JSON.stringify(events)).toContain('private network');
    expect(hits).toHaveLength(0);
  } finally {
    workspace.close();
    store.close();
  }
});
