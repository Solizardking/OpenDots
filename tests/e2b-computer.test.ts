import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
const cloud = vi.hoisted(() => ({
  create: vi.fn(),
  connect: vi.fn(),
  getInfo: vi.fn(),
  pause: vi.fn(),
}));
vi.mock('@e2b/desktop', () => ({
  Sandbox: cloud,
  NotFoundError: class NotFoundError extends Error {},
}));
const stores: WorkspaceStore[] = [];
afterEach(() => {
  vi.clearAllMocks();
  stores.splice(0).forEach((store) => store.close());
});
function fixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  stores.push(workspace);
  const id = workspace.dots()[0].id;
  const sdk = {
    sandboxId: 'sandbox-one',
    files: { makeDir: vi.fn().mockResolvedValue(undefined) },
    commands: {
      run: vi.fn().mockResolvedValue({
        wait: async () => ({ stdout: 'hello', stderr: '', exitCode: 0 }),
        kill: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
  cloud.create.mockResolvedValue(sdk);
  cloud.connect.mockResolvedValue(sdk);
  cloud.pause.mockResolvedValue(true);
  cloud.getInfo.mockResolvedValue({
    state: 'running',
    metadata: { opendotsDotId: id, opendotsOwnerId: 'owner' },
  });
  const service = new ComputerService(
    workspace,
    {
      baseUrl: 'https://api.x.ai/v1',
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
      computerProvider: 'e2b',
      e2bApiKey: 'private-e2b-key',
    },
    () => false,
  );
  return { workspace, id, sdk, service };
}
it('status never provisions or resumes a computer and permissions are checked before provisioning', async () => {
  const f = fixture();
  expect((await f.service.status(f.id)).state).toBe('stopped');
  expect(cloud.create).not.toHaveBeenCalled();
  expect(cloud.connect).not.toHaveBeenCalled();
  await expect(f.service.start(f.id)).rejects.toThrow('permission');
  expect(cloud.create).not.toHaveBeenCalled();
  f.workspace.computers.patch(f.id, { enabled: true, shell: true });
  await f.service.start(f.id);
  expect(cloud.create.mock.calls[0][1]).toMatchObject({
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'pause', autoResume: false },
    metadata: { opendotsDotId: f.id, opendotsOwnerId: 'owner' },
  });
  const status = await f.service.status(f.id);
  expect(status).toMatchObject({
    provider: 'e2b',
    state: 'running',
    sandboxId: 'sandbox-one',
  });
  expect(JSON.stringify(status)).not.toContain('private-e2b-key');
});
it('resumes the same sandbox and rejects foreign ownership rather than replacing it', async () => {
  const f = fixture();
  f.workspace.computers.patch(f.id, { enabled: true });
  await f.service.start(f.id);
  await f.service.stop(f.id);
  await f.service.start(f.id);
  expect(cloud.create).toHaveBeenCalledTimes(1);
  expect(cloud.connect.mock.calls[0][0]).toBe('sandbox-one');
  cloud.getInfo.mockResolvedValue({
    state: 'running',
    metadata: { opendotsDotId: 'other-dot', opendotsOwnerId: 'owner' },
  });
  expect((await f.service.status(f.id)).state).toBe('unavailable');
  await expect(f.service.start(f.id)).rejects.toThrow('identity mismatch');
  expect(cloud.create).toHaveBeenCalledTimes(1);
});
it('honors human takeover and requires a fresh snapshot after handback', async () => {
  const f = fixture();
  f.workspace.computers.patch(f.id, {
    enabled: true,
    browser: true,
    shell: true,
  });
  await f.service.start(f.id);
  await f.service.control(f.id, 'take');
  await expect(
    f.service.action(
      f.id,
      'exec',
      { command: 'echo hello', timeoutMs: 1000 },
      'agent',
    ),
  ).rejects.toThrow('owner has control');
  expect(f.sdk.commands.run).not.toHaveBeenCalled();
  await f.service.control(f.id, 'release');
  await expect(
    f.service.action(f.id, 'navigate', { url: 'https://example.com' }, 'agent'),
  ).rejects.toThrow('computer_snapshot');
  expect(f.sdk.commands.run).not.toHaveBeenCalled();
  f.workspace.computers.patch(f.id, { shell: false });
  await expect(
    f.service.action(
      f.id,
      'exec',
      { command: 'echo hello', timeoutMs: 1000 },
      'agent',
    ),
  ).rejects.toThrow('permission');
});
