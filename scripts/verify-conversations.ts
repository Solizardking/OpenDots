import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.js';
import { modelConfigFromEnv } from '../src/server/model-config.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

// Uses the configured model's credits in an isolated temporary workspace.
const folder = mkdtempSync(join(tmpdir(), 'opendots-conversations-'));
const database = join(folder, 'workspace.sqlite');
const model = modelConfigFromEnv(process.env);
const evidence: Record<string, unknown> = {
  model: model.model,
  success: false,
};
mkdirSync('artifacts/verification', { recursive: true });

async function start() {
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'conversation-verification');
  const config = {
    mode: 'live' as const,
    ...model,
    webSearchProvider: 'disabled' as const,
  };
  const platform = new Platform(store, workspace, {
    ...config,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  const app = createApp({
    store,
    platform,
    config,
    runner: new Runner(store, config),
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected an HTTP port.');
  const origin = `http://127.0.0.1:${address.port}`;
  platform.config.runtimeUrl = `${origin}/api/copilotkit`;
  return {
    store,
    workspace,
    platform,
    origin,
    async close() {
      await platform.stop();
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      workspace.close();
    },
  };
}
let instance: Awaited<ReturnType<typeof start>> | undefined;
try {
  instance = await start();
  const dot = instance.workspace.dots()[0];
  const created = await fetch(`${instance.origin}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dotId: dot.id,
      title: 'Live local chat verification',
    }),
  });
  if (created.status !== 201)
    throw new Error(`Conversation creation returned HTTP ${created.status}.`);
  const thread = (await created.json()) as { id: string };
  const reply = await instance.platform.turn(
    thread.id,
    'Remember the word acorn for this conversation. Reply with exactly: CHAT_READY acorn',
    AbortSignal.timeout(90000),
  );
  if (!reply.includes('CHAT_READY acorn'))
    throw new Error('The configured model did not return the expected reply.');
  evidence.initialReply = reply;
  evidence.creationStatus = created.status;
  const completed = instance;
  instance = undefined;
  await completed.close();
  instance = await start();
  const history = await instance.platform.history(thread.id);
  if (!history.includes('CHAT_READY acorn'))
    throw new Error('History did not survive the server restart.');
  evidence.historySurvivedRestart = true;
  const followup = await instance.platform.turn(
    thread.id,
    'Which word did I ask you to remember? Reply with only the word.',
    AbortSignal.timeout(90000),
  );
  if (!followup.toLowerCase().includes('acorn'))
    throw new Error('The follow-up did not retain prior conversation context.');
  evidence.followupReply = followup;
  const page = await instance.platform.pages.saveConversation(
    thread.id,
    'Verified chat',
    null,
  );
  evidence.savedPageContainsReplies =
    page.content.includes('CHAT_READY acorn') &&
    page.content.includes(followup);
  evidence.success = true;
  console.log(JSON.stringify(evidence));
} finally {
  await instance?.close();
  writeFileSync(
    'artifacts/verification/conversation-results.json',
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  rmSync(folder, { recursive: true, force: true });
}
