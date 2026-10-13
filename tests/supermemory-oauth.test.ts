import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  ConnectionService,
  type McpTransportFactory,
} from '../src/server/connections.js';
import { connectionRoutes } from '../src/server/connection-routes.js';
import { connectionTools } from '../src/server/connection-tools.js';
import {
  SupermemoryOAuth,
  SUPERMEMORY_MCP_URL,
  SUPERMEMORY_OAUTH_ISSUER,
  SUPERMEMORY_OAUTH_TTL_MS,
  supermemoryFetch,
} from '../src/server/supermemory-oauth.js';
import type {
  Connection,
  SupermemoryOAuthStart,
} from '../src/shared/connection-types.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  cleanup.splice(0).forEach((done) => done());
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
function remote() {
  let active = 'engineering';
  let issued = 0;
  let expireAccess = false;
  let spaceError = false;
  let hostileMetadata = false;
  const hits: {
    url: string;
    method: string;
    auth: string | null;
    body: string;
  }[] = [];
  const actions: { name: string; arguments: Record<string, unknown> }[] = [];
  const metadata = () => ({
    issuer: SUPERMEMORY_OAUTH_ISSUER,
    authorization_endpoint: `${SUPERMEMORY_OAUTH_ISSUER}/oauth2/authorize`,
    token_endpoint: hostileMetadata
      ? 'http://127.0.0.1/token'
      : `${SUPERMEMORY_OAUTH_ISSUER}/oauth2/token`,
    registration_endpoint: `${SUPERMEMORY_OAUTH_ISSUER}/oauth2/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
  });
  const fetchRemote: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === 'GET' ? '' : await request.text();
    hits.push({
      url: url.href,
      method: request.method,
      auth: request.headers.get('authorization'),
      body,
    });
    if (url.pathname.includes('oauth-protected-resource'))
      return json({
        resource: SUPERMEMORY_MCP_URL,
        authorization_servers: [SUPERMEMORY_OAUTH_ISSUER],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
      });
    if (url.pathname.includes('oauth-authorization-server'))
      return json(metadata());
    if (url.pathname === '/api/auth/oauth2/register')
      return json({ ...JSON.parse(body), client_id: 'fixture-client' }, 201);
    if (url.pathname === '/api/auth/oauth2/token')
      return json({
        access_token: `fixture-access-${++issued}`,
        refresh_token: 'fixture-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    if (url.href !== SUPERMEMORY_MCP_URL)
      return json({ error: 'not_found' }, 404);
    if (
      !request.headers.get('authorization') ||
      (expireAccess &&
        request.headers.get('authorization') === 'Bearer fixture-access-1')
    )
      return new Response('Unauthorized', {
        status: 401,
        headers: {
          'WWW-Authenticate':
            'Bearer resource_metadata="https://mcp.supermemory.ai/.well-known/oauth-protected-resource/mcp"',
        },
      });
    if (request.method === 'GET' || request.method === 'DELETE')
      return new Response(null, { status: 405 });
    const message = JSON.parse(body);
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === 'initialize')
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture Supermemory', version: '1' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          'list_spaces',
          'who_am_i',
          'search_memory',
          'add_memory',
          'set-active-tag',
        ].map((name) => ({
          name,
          inputSchema: { type: 'object', properties: {} },
          annotations: {
            readOnlyHint: !['add_memory', 'set-active-tag'].includes(name),
          },
          ...(name === 'set-active-tag'
            ? { _meta: { ui: { visibility: ['app'] } } }
            : {}),
        })),
      };
    else if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;
      if (name === 'list_spaces')
        result = {
          content: [{ type: 'text', text: 'Available spaces' }],
          structuredContent: {
            spaces: [
              { namespace: 'engineering', description: null },
              { namespace: 'finance', name: 'Finance', description: 'Budget' },
            ],
            count: 2,
          },
        };
      else if (name === 'who_am_i')
        result = {
          content: [{ type: 'text', text: 'Account context' }],
          structuredContent: {
            userId: 'fixture-user',
            activeSpace: active,
            role: 'member',
            accessType: 'restricted',
            scope: 'openid',
          },
        };
      else if (name === 'set-active-tag') {
        actions.push({ name, arguments: args });
        if (!spaceError) active = args.namespace;
        result = {
          isError: spaceError,
          content: [
            {
              type: 'text',
              text: spaceError ? 'Denied' : `Active space set to ${active}`,
            },
          ],
          structuredContent: { namespace: active },
        };
      } else if (name === 'search_memory')
        result = {
          content: [
            {
              type: 'text',
              text: `Results in ${args.containerTag ?? args.namespace ?? active}`,
            },
          ],
        };
      else {
        actions.push({ name, arguments: args });
        result = { content: [{ type: 'text', text: 'Saved' }] };
      }
    } else
      return json({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Unknown method' },
      });
    return json({ jsonrpc: '2.0', id: message.id, result });
  };
  return {
    fetch: fetchRemote,
    hits,
    actions,
    get active() {
      return active;
    },
    set expire(value: boolean) {
      expireAccess = value;
    },
    set spaceError(value: boolean) {
      spaceError = value;
    },
    set hostileMetadata(value: boolean) {
      hostileMetadata = value;
    },
  };
}
function fixture(
  path = ':memory:',
  owner = 'fixture-owner',
  service = remote(),
) {
  const workspace = new WorkspaceStore(path, owner);
  let open = true;
  const close = () => {
    if (open) {
      workspace.close();
      open = false;
    }
  };
  cleanup.push(close);
  const oauth = new SupermemoryOAuth(workspace.connections, () => ({
    fetch: service.fetch,
    close: async () => {},
  }));
  const transport: McpTransportFactory = ({ url, authProvider, fetchPolicy }) =>
    new StreamableHTTPClientTransport(new URL(url), {
      authProvider,
      fetch: fetchPolicy ? fetchPolicy(service.fetch) : service.fetch,
    });
  const connections = new ConnectionService(
    workspace.connections,
    transport,
    5000,
    oauth,
  );
  const routes = connectionRoutes(workspace, connections);
  const dot = workspace.dots()[0];
  try {
    workspace.requireThread('thread');
  } catch {
    workspace.bindThread('thread', dot.id, 'Private conversation');
  }
  const request = (path: string, method = 'GET', body?: unknown) =>
    routes.request(`https://chatgptee.ai${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://chatgptee.ai',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const start = async () => {
    const response = await request(
      `/dots/${dot.id}/connections/supermemory`,
      'POST',
      {},
    );
    expect(response.status).toBe(201);
    return (await response.json()) as SupermemoryOAuthStart;
  };
  const finish = async (started: SupermemoryOAuthStart) => {
    const response = await request(
      '/connections/supermemory/oauth/finish',
      'POST',
      {
        code: 'fixture-code',
        state: new URL(started.authorizationUrl).searchParams.get('state'),
        iss: SUPERMEMORY_OAUTH_ISSUER,
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Connection;
  };
  return {
    workspace,
    close,
    oauth,
    connections,
    routes,
    dot,
    request,
    start,
    finish,
    service,
  };
}

it('uses SDK OAuth discovery and PKCE, stores only safe connection metadata, and discovers authenticated tools', async () => {
  const { start, finish, workspace, service } = fixture();
  const started = await start();
  expect(started.connection).toMatchObject({
    provider: 'supermemory',
    auth: 'oauth',
    authStatus: 'pending',
    hasToken: false,
    tools: [],
  });
  const url = new URL(started.authorizationUrl);
  expect(url.origin + url.pathname).toBe(
    `${SUPERMEMORY_OAUTH_ISSUER}/oauth2/authorize`,
  );
  expect(url.searchParams.get('redirect_uri')).toBe(
    'https://chatgptee.ai/supermemory/callback',
  );
  expect(url.searchParams.get('resource')).toBe(SUPERMEMORY_MCP_URL);
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const verifier = workspace.connections.oauthCredentials(
    started.connection.id,
  )!.codeVerifier!;
  expect(url.searchParams.get('code_challenge')).toBe(
    createHash('sha256').update(verifier).digest('base64url'),
  );
  expect(service.hits.every((hit) => hit.auth === null)).toBe(true);
  const connected = await finish(started);
  expect(connected).toMatchObject({
    authStatus: 'connected',
    hasToken: true,
    error: null,
  });
  expect(connected.tools.map((tool) => tool.name)).toEqual([
    'list_spaces',
    'who_am_i',
    'search_memory',
    'add_memory',
  ]);
  expect(
    connected.tools.find((tool) => tool.name === 'add_memory')
      ?.requiresApproval,
  ).toBe(true);
  const exchange = service.hits.find((hit) =>
    hit.url.endsWith('/oauth2/token'),
  )!;
  expect(new URLSearchParams(exchange.body).get('code_verifier')).toBe(
    verifier,
  );
  const safe = JSON.stringify([
    started,
    connected,
    workspace.connections.list(connected.dotId),
  ]);
  for (const secret of [verifier, 'fixture-access-1', 'fixture-refresh'])
    expect(safe).not.toContain(secret);
  expect(
    workspace.connections.oauthCredentials(connected.id)!.codeVerifier,
  ).toBeUndefined();
});

it('binds callbacks to the owner workspace, refuses issuer mismatch and replay, and expires old attempts', async () => {
  const a = fixture();
  const b = fixture(':memory:', 'another-owner', a.service);
  const started = await a.start();
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  for (const request of [
    b.request('/connections/supermemory/oauth/finish', 'POST', {
      code: 'fixture-code',
      state,
    }),
    a.request('/connections/supermemory/oauth/finish', 'POST', {
      code: 'fixture-code',
      state,
      iss: 'https://evil.example',
    }),
  ])
    expect((await request).status).toBe(400);
  expect(a.service.hits.some((hit) => hit.url.endsWith('/oauth2/token'))).toBe(
    false,
  );
  await a.finish(started);
  expect(
    (
      await a.request('/connections/supermemory/oauth/finish', 'POST', {
        code: 'fixture-code',
        state,
      })
    ).status,
  ).toBe(400);
  const expired = await a.start();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + SUPERMEMORY_OAUTH_TTL_MS + 1);
  expect(
    (
      await a.request('/connections/supermemory/oauth/finish', 'POST', {
        code: 'fixture-code',
        state: new URL(expired.authorizationUrl).searchParams.get('state'),
      })
    ).status,
  ).toBe(400);
  expect(
    a.service.hits.filter((hit) => hit.url.endsWith('/oauth2/token')),
  ).toHaveLength(1);
});

it('uses encrypted durable workspace credentials and survives a restart without exposing tokens in SQLite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opendots-oauth-'));
  cleanup.unshift(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'workspace.sqlite');
  const first = fixture(path);
  const started = await first.start();
  first.close();
  const second = fixture(path, 'fixture-owner', first.service);
  const connected = await second.finish(started);
  expect(
    second.workspace.connections.oauthCredentials(connected.id)?.tokens
      ?.access_token,
  ).toBe('fixture-access-1');
  expect(statSync(`${path}.mcp-oauth.key`).mode & 0o777).toBe(0o600);
  expect(readFileSync(`${path}.mcp-oauth.key`)).toHaveLength(32);
  const db = new DatabaseSync(path);
  try {
    const ciphertext = JSON.stringify(
      db.prepare('SELECT * FROM mcp_oauth_credentials').all(),
    );
    expect(ciphertext).not.toContain('fixture-access');
    expect(ciphertext).not.toContain('fixture-refresh');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM mcp_oauth_attempts').get()?.n,
    ).toBe(0);
  } finally {
    db.close();
  }
  expect(
    (await second.request(`/connections/${connected.id}/supermemory/spaces`))
      .status,
  ).toBe(200);
});

it('refreshes an expired access token through SDK HTTP transport without creating another consent flow', async () => {
  const f = fixture();
  const connected = await f.finish(await f.start());
  f.service.expire = true;
  const spaces = await f.request(
    `/connections/${connected.id}/supermemory/spaces`,
  );
  expect(spaces.status).toBe(200);
  expect((await spaces.json()).activeNamespace).toBe('engineering');
  const refreshed = f.service.hits
    .filter((hit) => hit.url.endsWith('/oauth2/token'))
    .slice(1);
  expect(refreshed.length).toBeGreaterThan(0);
  expect(new URLSearchParams(refreshed[0].body).get('grant_type')).toBe(
    'refresh_token',
  );
  expect(f.workspace.connections.get(connected.id)?.authStatus).toBe(
    'connected',
  );
});

it('keeps one-off space requests separate from explicit active changes and preserves memory write approval', async () => {
  const f = fixture();
  const connection = await f.finish(await f.start());
  const exposed = f.connections
    .tools(f.dot.id)
    .find((item) => item.tool.name === 'search_memory')!;
  expect(
    await f.connections.call(exposed, {
      query: 'Budget',
      containerTag: 'finance',
    }),
  ).toMatchObject({ text: 'Results in finance' });
  expect(f.service.active).toBe('engineering');
  expect(
    (
      await f.request(
        `/connections/${connection.id}/supermemory/space`,
        'POST',
        { namespace: 'unknown' },
      )
    ).status,
  ).toBe(400);
  expect(f.service.actions).toEqual([]);
  const changed = await f.request(
    `/connections/${connection.id}/supermemory/space`,
    'POST',
    { namespace: 'finance' },
  );
  expect(await changed.json()).toMatchObject({ activeNamespace: 'finance' });
  expect(f.service.active).toBe('finance');
  f.service.spaceError = true;
  expect(
    (
      await f.request(
        `/connections/${connection.id}/supermemory/space`,
        'POST',
        { namespace: 'engineering' },
      )
    ).status,
  ).toBe(400);
  expect(f.service.active).toBe('finance');
  const write = connectionTools(
    f.connections,
    f.dot.id,
    'thread',
    () => {},
    new AbortController().signal,
    true,
  ).find((tool) => tool.name === 'supermemory__add_memory')!;
  expect(
    await write.execute!(
      { content: 'A preference', namespace: 'finance' },
      {} as never,
    ),
  ).toMatchObject({ status: 'approval_required' });
  expect(f.service.actions.some((action) => action.name === 'add_memory')).toBe(
    false,
  );
});

it('rejects manual Supermemory credentials, unauthorized callback origins and hostile provider discovery', async () => {
  const f = fixture();
  const injected = await f.request(`/dots/${f.dot.id}/connections`, 'POST', {
    name: 'Supermemory',
    url: SUPERMEMORY_MCP_URL,
    token: 'fixture-api-key',
  });
  expect(injected.status).toBe(400);
  expect(f.service.hits).toEqual([]);
  await expect(
    f.connections.addSupermemory(f.dot.id, 'https://example.com/path'),
  ).rejects.toThrow('application origin');
  f.service.hostileMetadata = true;
  expect(
    (await f.request(`/dots/${f.dot.id}/connections/supermemory`, 'POST', {}))
      .status,
  ).toBe(400);
  expect(f.service.hits.some((hit) => hit.url.includes('127.0.0.1'))).toBe(
    false,
  );
  expect(
    f.service.hits.some((hit) => hit.url.endsWith('/oauth2/register')),
  ).toBe(false);
  const wrapped = supermemoryFetch(f.service.fetch);
  await expect(wrapped('http://127.0.0.1/token')).rejects.toThrow(
    'not allowed',
  );
  await expect(wrapped('https://evil.example/token')).rejects.toThrow(
    'not allowed',
  );
});

it('routes generic Supermemory additions to OAuth and disconnect removes credentials and pending callbacks', async () => {
  const f = fixture();
  const response = await f.request(`/dots/${f.dot.id}/connections`, 'POST', {
    name: 'My memory',
    url: SUPERMEMORY_MCP_URL,
  });
  const started = (await response.json()) as SupermemoryOAuthStart;
  expect(response.status).toBe(201);
  expect(started.authorizationUrl).toContain('code_challenge');
  expect(
    (await f.request(`/connections/${started.connection.id}`, 'DELETE')).status,
  ).toBe(200);
  expect(
    f.workspace.connections.oauthCredentials(started.connection.id),
  ).toBeUndefined();
  expect(
    (
      await f.request('/connections/supermemory/oauth/finish', 'POST', {
        code: 'fixture-code',
        state: new URL(started.authorizationUrl).searchParams.get('state'),
      })
    ).status,
  ).toBe(400);
});
