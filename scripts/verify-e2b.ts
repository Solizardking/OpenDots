import { ComputerService } from '../src/server/computer-service.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Sandbox } from '@e2b/desktop';
import { mkdirSync, writeFileSync } from 'node:fs';

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required.');
mkdirSync('artifacts/verification', { recursive: true });
const workspace = new WorkspaceStore(':memory:', 'integration-verification');
const id = workspace.dots()[0].id;
workspace.computers.patch(id, {
  enabled: true,
  browser: true,
  files: true,
  shell: true,
});
const computers = new ComputerService(
  workspace,
  {
    baseUrl: 'https://api.x.ai/v1',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
    computerProvider: 'e2b',
    e2bApiKey: process.env.E2B_API_KEY,
  },
  () => false,
);
try {
  if ((await computers.status(id)).state !== 'stopped')
    throw new Error('Unexpected initial state.');
  await computers.start(id);
  const originalSandboxId = workspace.computers.e2b(id)?.sandboxId;
  if (!originalSandboxId) throw new Error('Sandbox ID was not persisted.');
  console.log('Started E2B desktop.');
  await computers.action(id, 'snapshot', {}, 'agent');
  const navigation = await computers.action(
    id,
    'navigate',
    { url: 'https://example.com' },
    'agent',
  );
  const page = await computers.action(id, 'snapshot', {}, 'agent');
  console.log('Read example.com through the browser.');
  const screen = (await computers.action(id, 'screenshot', {})) as {
    base64: string;
    width: number;
    height: number;
  };
  writeFileSync(
    'artifacts/verification/e2b-desktop.png',
    Buffer.from(screen.base64, 'base64'),
  );
  await computers.action(id, 'files_write', {
    path: 'verification/hello.txt',
    contents: 'persisted E2B file',
  });
  const terminal = await computers.action(
    id,
    'exec',
    { command: 'pwd && cat verification/hello.txt', timeoutMs: 10000 },
    'agent',
  );
  await computers.control(id, 'take');
  try {
    await computers.action(
      id,
      'navigate',
      { url: 'https://example.org' },
      'agent',
    );
    throw new Error('Agent bypassed takeover.');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('owner has control')
    )
      throw error;
  }
  await computers.control(id, 'release');
  try {
    await computers.action(
      id,
      'navigate',
      { url: 'https://example.org' },
      'agent',
    );
    throw new Error('Agent bypassed snapshot gate.');
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('computer_snapshot')
    )
      throw error;
  }
  await computers.stop(id);
  if ((await computers.status(id)).state !== 'stopped')
    throw new Error('Sandbox did not pause.');
  await computers.start(id);
  if (workspace.computers.e2b(id)?.sandboxId !== originalSandboxId)
    throw new Error('Start replaced the paused sandbox.');
  const file = (await computers.action(id, 'files_read', {
    path: 'verification/hello.txt',
  })) as { text: string };
  if (file.text !== 'persisted E2B file')
    throw new Error('File did not survive pause and resume.');
  await computers.stop(id);
  const evidence = {
    success: true,
    navigation,
    page,
    terminal,
    screen: { width: screen.width, height: screen.height },
    takeoverEnforced: true,
    handbackSnapshotEnforced: true,
    fileSurvivedResume: true,
  };
  writeFileSync(
    'artifacts/verification/e2b-results.json',
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence));
} finally {
  const sandboxId = workspace.computers.e2b(id)?.sandboxId;
  if (sandboxId)
    await Sandbox.kill(sandboxId, { apiKey: process.env.E2B_API_KEY });
  workspace.close();
}
