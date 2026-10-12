import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserUse } from 'browser-use-sdk/v4';
import { WorkspaceStore } from '../src/server/workspace.js';
import { BrowserUseService } from '../src/server/browser-use-service.js';
import { cloudRunError } from '../src/server/browser-use-service.js';
import { browserUseConfigFromEnv } from '../src/server/browser-use-config.js';
import { browserUseRoutes } from '../src/server/browser-use-routes.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';

const databases: { close(): void }[] = [];
const directories: string[] = [];
it('turns upstream provider errors into readable messages without provider credentials or internal URLs', () => {
  expect(
    cloudRunError('invalid_api_key sk-proj-private http://internal-provider'),
  ).toContain('HTTP 401');
  expect(
    cloudRunError('invalid_api_key sk-proj-private http://internal-provider'),
  ).not.toContain('sk-proj');
  expect(cloudRunError('unstructured secret error')).not.toContain('secret');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  databases.splice(0).forEach((db) => db.close());
  directories
    .splice(0)
    .forEach((directory) =>
      rmSync(directory, { recursive: true, force: true }),
    );
});
function fixture(workspace = new WorkspaceStore(':memory:', 'owner')) {
  databases.push(workspace);
  const id = workspace.dots()[0].id;
  let paused = false;
  const browser = {
    id: 'browser-id',
    status: 'active' as const,
    cdpUrl: 'https://private.cdp.browser-use.com',
    liveUrl: 'https://live.browser-use.com/view',
    timeoutAt: '2026-10-10T12:15:00Z',
    recordingAvailable: true,
  };
  const completed = {
    id: 'run-id',
    sessionId: 'session-id',
    workspaceId: 'workspace-id',
    status: 'completed' as const,
    result: 'Example Domain',
    error: null,
    totalCostUsd: '0.01',
  };
  const client = {
    workspaces: {
      create: vi.fn().mockResolvedValue({ id: 'private-workspace-id' }),
    },
    browsers: {
      create: vi.fn().mockResolvedValue(browser),
      stop: vi.fn().mockResolvedValue({ ...browser, status: 'stopped' }),
    },
    runs: {
      create: vi.fn().mockResolvedValue({ ...completed, status: 'queued' }),
      status: vi.fn().mockResolvedValue({ status: 'completed' }),
      get: vi.fn().mockResolvedValue(completed),
      cancel: vi.fn().mockResolvedValue({ ...completed, status: 'cancelled' }),
    },
  };
  const config = {
    browserUseApiKey: 'server-only-key',
    clawdProfile: 'profile-id',
    cdpUrl: browser.cdpUrl,
    browserUseWorkspaceId: 'workspace-id',
    browserUseModel: 'gpt-6-luna',
  };
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) =>
    String(input).includes('/browsers?')
      ? Response.json({ items: [] })
      : Response.json({
          ...browser,
          status: 'stopped',
          recordingAvailable: false,
        }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const service = new BrowserUseService(
    workspace,
    config,
    () => paused,
    client as unknown as BrowserUse,
  );
  return {
    service,
    client,
    workspace,
    id,
    config,
    browser,
    fetchMock,
    pause: () => {
      paused = true;
    },
  };
}
it('resolves both environment spellings without exposing secrets in status', async () => {
  expect(
    browserUseConfigFromEnv({
      BROWSERUSE_API_KEY: ' canonical ',
      BROWSER_USE_API_KEY: 'alias',
    }).browserUseApiKey,
  ).toBe('canonical');
  expect(
    browserUseConfigFromEnv({
      BROWSERUSE_API_KEY: ' ',
      BROWSER_USE_API_KEY: ' alias ',
    }).browserUseApiKey,
  ).toBe('alias');
  const f = fixture();
  const state = await f.service.status(f.id);
  expect(state).toMatchObject({
    enabled: false,
    configured: true,
    model: 'gpt-6-luna',
    suppliedCdpConfigured: true,
  });
  expect(JSON.stringify(state)).not.toContain('server-only-key');
  expect(JSON.stringify(state)).not.toContain('private.cdp');
});
it('blocks disabled permissions, pauses, unknown dots, empty tasks and unowned follow-ups before billing', async () => {
  const f = fixture();
  await expect(f.service.startBrowser(f.id)).rejects.toThrow(
    'Enable Browser Use',
  );
  await expect(
    f.service.createRun('unknown', { task: 'Test' }),
  ).rejects.toThrow('Dot not found');
  await f.service.permission(f.id, true);
  await expect(f.service.createRun(f.id, { task: ' ' })).rejects.toThrow();
  await expect(
    f.service.createRun(f.id, { task: 'Test', followup: true }),
  ).rejects.toThrow('Start a task');
  f.pause();
  await expect(f.service.createRun(f.id, { task: 'Test' })).rejects.toThrow(
    'paused',
  );
  expect(f.client.runs.create).not.toHaveBeenCalled();
  expect(f.client.browsers.create).not.toHaveBeenCalled();
});
it('creates the requested Japan browser, stops it on CDP failure, and ends unavailable recording polling', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  await expect(
    f.service.withStandaloneBrowser(f.id, async (cdp) => {
      expect(cdp).toBe(f.browser.cdpUrl);
      throw new Error('CDP failed');
    }),
  ).rejects.toThrow('CDP failed');
  expect(f.client.browsers.create).toHaveBeenCalledWith({
    profileId: 'profile-id',
    proxyCountryCode: 'jp',
    timeout: 15,
    allowResizing: true,
    enableRecording: true,
  });
  expect(f.client.browsers.stop).toHaveBeenCalledWith('browser-id');
  expect((await f.service.waitForRecording(f.id)).recordingAvailable).toBe(
    false,
  );
  expect(
    f.fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('/browsers/browser-id'),
    ).length,
  ).toBe(2);
});
it('uses the exact run model, reasoning, workspace and viewport, preserving follow-up session ownership', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  await f.service.createRun(f.id, { task: 'Open example.com' });
  expect(f.client.runs.create).toHaveBeenCalledWith({
    task: 'Open example.com',
    model: 'gpt-6-luna',
    modelParams: { reasoning: { effort: 'high' }, service_tier: 'default' },
    workspaceId: 'workspace-id',
    judge: {},
    browserSettings: {
      profileId: 'profile-id',
      proxyCountryCode: 'us',
      screenWidth: 1440,
      screenHeight: 900,
      record: true,
    },
  });
  const done = await f.service.waitForRun(
    f.id,
    'run-id',
    new AbortController().signal,
  );
  expect(done.result).toBe('Example Domain');
  expect(f.client.runs.get).toHaveBeenCalledTimes(1);
  expect(f.client.runs.cancel).not.toHaveBeenCalled();
  expect(f.client.workspaces.create).not.toHaveBeenCalled();
  await f.service.createRun(f.id, { task: 'Continue', followup: true });
  expect(f.client.runs.create.mock.calls[1][0].sessionId).toBe('session-id');
});
function isolatedService(f: ReturnType<typeof fixture>) {
  f.client.runs.create.mockImplementation(async (body) => ({
    id: 'private-run-id',
    sessionId: 'private-session-id',
    workspaceId: body.workspaceId,
    status: 'queued',
  }));
  return new BrowserUseService(
    f.workspace,
    { ...f.config, browserUseIsolatedWorkspace: true },
    () => false,
    f.client as unknown as BrowserUse,
  );
}
it('uses distinct persisted provider workspaces for wallet users instead of the owner namespace', async () => {
  const first = fixture();
  const second = fixture();
  first.client.workspaces.create.mockResolvedValue({ id: 'user-one-files' });
  second.client.workspaces.create.mockResolvedValue({ id: 'user-two-files' });
  const firstService = isolatedService(first);
  const secondService = isolatedService(second);
  await firstService.permission(first.id, true);
  await secondService.permission(second.id, true);
  await firstService.createRun(first.id, { task: 'First user task' });
  await secondService.createRun(second.id, { task: 'Second user task' });
  expect(first.client.runs.create.mock.calls[0][0].workspaceId).toBe(
    'user-one-files',
  );
  expect(second.client.runs.create.mock.calls[0][0].workspaceId).toBe(
    'user-two-files',
  );
  expect(first.workspace.browserUse.providerWorkspaceId()).toBe(
    'user-one-files',
  );
  expect(second.workspace.browserUse.providerWorkspaceId()).toBe(
    'user-two-files',
  );
  expect(first.config.browserUseWorkspaceId).toBe('workspace-id');
});
it('creates one provider workspace across concurrent service instances and Dots for the same user', async () => {
  const f = fixture();
  const otherDot = f.workspace.createDot(
    f.workspace.spaces()[0].id,
    'Other Dot',
    'Help with another task.',
    true,
    true,
  );
  const first = isolatedService(f);
  const second = isolatedService(f);
  await first.permission(f.id, true);
  await second.permission(otherDot.id, true);
  let resolveWorkspace: (value: { id: string }) => void = () => {};
  f.client.workspaces.create.mockReturnValue(
    new Promise((resolve) => {
      resolveWorkspace = resolve;
    }),
  );
  const creating = first.createRun(f.id, { task: 'First Dot task' });
  const other = second.createRun(otherDot.id, { task: 'Other Dot task' });
  expect(f.client.workspaces.create).toHaveBeenCalledTimes(1);
  resolveWorkspace({ id: 'same-user-files' });
  await Promise.all([creating, other]);
  expect(
    f.client.runs.create.mock.calls.map(([body]) => body.workspaceId),
  ).toEqual(['same-user-files', 'same-user-files']);
});
it('restores a private provider workspace after reopening the local database and preserves follow-ups and new sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chatgptee-browser-use-'));
  directories.push(directory);
  const path = join(directory, 'workspace.sqlite');
  const f = fixture(new WorkspaceStore(path, 'wallet-user'));
  const service = isolatedService(f);
  await service.permission(f.id, true);
  await service.createRun(f.id, { task: 'Create persistent files' });
  await service.status(f.id);
  databases.splice(databases.indexOf(f.workspace), 1);
  f.workspace.close();
  const reopened = fixture(new WorkspaceStore(path, 'wallet-user'));
  const resumed = isolatedService(reopened);
  await resumed.createRun(reopened.id, {
    task: 'Continue reading files',
    followup: true,
  });
  expect(reopened.client.runs.create.mock.calls[0][0]).toMatchObject({
    sessionId: 'private-session-id',
    workspaceId: 'private-workspace-id',
  });
  await resumed.status(reopened.id);
  await resumed.createRun(reopened.id, {
    task: 'Start a different conversation',
  });
  expect(reopened.client.runs.create.mock.calls[1][0].workspaceId).toBe(
    'private-workspace-id',
  );
  expect(
    reopened.client.runs.create.mock.calls[1][0].sessionId,
  ).toBeUndefined();
  expect(reopened.client.workspaces.create).not.toHaveBeenCalled();
});
it('requires a new private task before continuing an older session in the shared namespace', async () => {
  const f = fixture();
  f.workspace.browserUse.save(f.id, {
    enabled: true,
    run: {
      id: 'old-run',
      sessionId: 'old-session',
      workspaceId: 'workspace-id',
      status: 'completed',
      browser: f.browser,
    },
  });
  const service = isolatedService(f);
  await expect(
    service.createRun(f.id, { task: 'Continue', followup: true }),
  ).rejects.toThrow('Start a new Browser Use task');
  f.workspace.browserUse.saveProviderWorkspaceId('private-workspace-id');
  await expect(
    service.createRun(f.id, { task: 'Continue', followup: true }),
  ).rejects.toThrow('Start a new Browser Use task');
  expect(f.client.runs.create).not.toHaveBeenCalled();
  expect(f.client.workspaces.create).not.toHaveBeenCalled();
  expect(f.client.browsers.stop).not.toHaveBeenCalled();
  await service.createRun(f.id, { task: 'A new private task' });
  expect(f.client.runs.create.mock.calls[0][0].workspaceId).toBe(
    'private-workspace-id',
  );
  expect(f.client.runs.create.mock.calls[0][0].sessionId).toBeUndefined();
});
it('fails closed when private workspace creation fails and allows a later retry', async () => {
  const f = fixture();
  const service = isolatedService(f);
  await service.permission(f.id, true);
  f.client.workspaces.create.mockRejectedValueOnce(
    new Error('provider unavailable'),
  );
  await expect(service.createRun(f.id, { task: 'Task' })).rejects.toThrow(
    'Browser Use request failed',
  );
  expect(f.client.runs.create).not.toHaveBeenCalled();
  expect(f.workspace.browserUse.providerWorkspaceId()).toBeUndefined();
  await service.createRun(f.id, { task: 'Retry task' });
  expect(f.client.workspaces.create).toHaveBeenCalledTimes(2);
  expect(f.client.runs.create.mock.calls[0][0].workspaceId).toBe(
    'private-workspace-id',
  );
});
it('cancels aborted and timed-out paid tasks while preserving a separate owner browser', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  await f.service.startBrowser(f.id);
  await f.service.createRun(f.id, { task: 'Test' });
  const abort = new AbortController();
  abort.abort(new Error('owner cancelled'));
  await expect(
    f.service.waitForRun(f.id, 'run-id', abort.signal),
  ).rejects.toThrow('owner cancelled');
  expect(f.client.runs.cancel).toHaveBeenCalledTimes(1);
  expect(f.client.browsers.stop).not.toHaveBeenCalled();
  f.client.runs.status.mockResolvedValue({ status: 'running' });
  await f.service.createRun(f.id, { task: 'Test timeout' });
  await expect(
    f.service.waitForRun(f.id, 'run-id', new AbortController().signal, 0),
  ).rejects.toThrow('timed out');
  expect(f.client.runs.cancel).toHaveBeenCalledTimes(2);
});
it('serializes API and Dot-agent creation to avoid duplicate paid browsers', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  let resolve: (value: typeof f.browser) => void = () => {};
  f.client.browsers.create.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const creating = f.service.startBrowser(f.id);
  const other = new BrowserUseService(
    f.workspace,
    f.config,
    () => false,
    f.client as unknown as BrowserUse,
  );
  await expect(other.startBrowser(f.id)).rejects.toThrow('busy');
  resolve(f.browser);
  await creating;
  expect(f.client.browsers.create).toHaveBeenCalledTimes(1);
  await expect(other.startBrowser(f.id)).rejects.toThrow('Stop the current');
});
it('revocation cancels owned tasks and browsers, and redacts provider errors', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  await f.service.startBrowser(f.id);
  await f.service.createRun(f.id, { task: 'Test' });
  const state = await f.service.permission(f.id, false);
  expect(state.enabled).toBe(false);
  expect(f.client.runs.cancel).toHaveBeenCalledTimes(1);
  expect(f.client.browsers.stop).toHaveBeenCalledWith('browser-id');
  await f.service.permission(f.id, true);
  f.client.browsers.create.mockRejectedValue(
    Object.assign(new Error('server-only-key in provider payload'), {
      status: 402,
    }),
  );
  await expect(f.service.startBrowser(f.id)).rejects.toThrow('HTTP 402');
  await expect(f.service.startBrowser(f.id)).rejects.not.toThrow(
    'server-only-key',
  );
});
it('protects all browser routes with owner authentication and origin checks', async () => {
  const f = fixture();
  const store = new Store(':memory:');
  databases.push(store);
  const config = { mode: 'sample' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, f.workspace, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    ownerToken: 'owner-token',
    platform,
  });
  const path = `/api/dots/${f.id}/browser-use`;
  expect((await app.request(path)).status).toBe(401);
  expect(
    (
      await app.request(path, {
        headers: { Authorization: 'Bearer owner-token' },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(path, {
        headers: {
          Authorization: 'Bearer owner-token',
          Origin: 'https://evil.example',
        },
      })
    ).status,
  ).toBe(403);
  const routes = browserUseRoutes(f.service);
  expect(
    (
      await routes.request(`/dots/${f.id}/browser-use/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: '' }),
      })
    ).status,
  ).toBe(400);
});
it('waits for concurrent status checks instead of cancelling a task because polling overlapped', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  await f.service.createRun(f.id, { task: 'Test' });
  const states = await Promise.all([
    f.service.status(f.id),
    f.service.status(f.id),
  ]);
  expect(states.map((state) => state.run?.status)).toEqual([
    'completed',
    'completed',
  ]);
  expect(f.client.runs.cancel).not.toHaveBeenCalled();
});
it('keeps a revoked permission disabled and stops the standalone browser even if run cancellation fails', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  await f.service.startBrowser(f.id);
  await f.service.createRun(f.id, { task: 'Test' });
  f.client.runs.cancel.mockRejectedValue(
    new Error('temporary provider failure'),
  );
  await expect(f.service.permission(f.id, false)).rejects.toThrow(
    'Browser Use request failed',
  );
  expect(f.workspace.browserUse.get(f.id).enabled).toBe(false);
  expect(f.client.browsers.stop).toHaveBeenCalledWith('browser-id');
});
it('stops a newly created paid browser when ownership cannot be saved', async () => {
  const f = fixture();
  await f.service.permission(f.id, true);
  vi.spyOn(f.workspace.browserUse, 'save').mockImplementation(() => {
    throw new Error('database unavailable');
  });
  await expect(f.service.startBrowser(f.id)).rejects.toThrow(
    'database unavailable',
  );
  expect(f.client.browsers.stop).toHaveBeenCalledWith('browser-id');
});
