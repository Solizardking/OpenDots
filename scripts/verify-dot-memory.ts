// Uses real configured Mem0 and model APIs in an isolated temporary workspace.
// Run: node --env-file=.env --import tsx scripts/verify-dot-memory.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { mem0ConfigFromEnv } from '../src/server/dot-memory.js';
import { modelConfigFromEnv } from '../src/server/model-config.js';

process.env.DO_NOT_TRACK = '1';
const directory = mkdtempSync(join(tmpdir(), 'opendots-memory-live-'));
const path = join(directory, 'workspace.sqlite');
const owner = `opendots-verification-${randomUUID()}`;
const project = `Amber-${randomUUID().slice(0, 8)}`;
const mem0 = mem0ConfigFromEnv(process.env);
const memoryOnly = process.argv.includes('--mem0-only');
assert(mem0.mem0ApiKey, 'MEM0_API_KEY is required.');
const model = modelConfigFromEnv(process.env);
if (!memoryOnly)
  assert(model.apiKey && model.model, 'A configured chat model is required.');
let active: Awaited<ReturnType<typeof open>> | undefined;
let dotId: string | undefined;
let cleanupSucceeded = false;
async function open() {
  const store = new Store(path);
  const workspace = new WorkspaceStore(path, owner);
  const config = {
    ...model,
    ...mem0,
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    webSearchProvider: 'disabled' as const,
  };
  const platform = new Platform(store, workspace, config);
  const research = {
    ...model,
    mode: 'live' as const,
    webSearchProvider: 'disabled' as const,
  };
  const app = memoryOnly
    ? undefined
    : (await import('../src/server/app.js')).createApp({
        store,
        platform,
        config: research,
        runner: new Runner(store, research),
      });
  return { store, workspace, platform, app };
}
async function close() {
  if (!active) return;
  await active.platform.stop();
  active.workspace.close();
  active.store.close();
  active = undefined;
}
async function ask(threadId: string, prompt: string) {
  assert(active && dotId);
  if (memoryOnly) {
    const user = { id: randomUUID(), role: 'user' as const, content: prompt };
    const facts =
      threadId === 'second'
        ? await active.platform.memory.recall(dotId, prompt)
        : [];
    if (threadId === 'second')
      assert(
        facts.some((fact) => /amber/i.test(fact.text)),
        'The new conversation could not recall the fact.',
      );
    const reply =
      threadId === 'second'
        ? facts.map((fact) => fact.text).join('\n')
        : 'I will remember your amber dashboard preference.';
    active.workspace.localConversations.save(threadId, {
      messages: [user, { id: randomUUID(), role: 'assistant', content: reply }],
      state: {},
      events: [],
      updatedAt: Date.now(),
    });
    active.platform.memory.record(dotId, threadId, randomUUID(), user, reply);
    await active.platform.memory.flush();
    return reply;
  }
  assert(active.app);
  const response = await active.app.request(
    `/api/copilotkit/agent/${dotId}/run`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId,
        runId: randomUUID(),
        messages: [{ id: randomUUID(), role: 'user', content: prompt }],
        state: {},
        tools: [],
        context: [],
        forwardedProps: {},
      }),
    },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert(!text.includes('RUN_ERROR'), 'The model turn failed.');
  assert(text.includes('RUN_FINISHED'), 'The model turn did not finish.');
  await active.platform.memory.flush();
  return text;
}
async function settle() {
  assert(active && dotId);
  const deadline = Date.now() + 90000;
  while (
    active.platform.memory.status(dotId).pending &&
    Date.now() < deadline
  ) {
    await delay(1000);
    await active.platform.memory.flush();
  }
  assert.equal(
    active.platform.memory.status(dotId).pending,
    0,
    'Mem0 processing did not complete.',
  );
}
try {
  active = await open();
  dotId = active.workspace.dots()[0].id;
  active.workspace.bindThread('first', dotId, 'Memory verification');
  await ask(
    'first',
    `Remember that my dashboard accent color for project ${project} is amber. Reply with a short confirmation.`,
  );
  console.log(
    JSON.stringify({
      firstChatCompleted: !memoryOnly,
      syntheticTurnStored: memoryOnly,
      memory: {
        pending: active.platform.memory.status(dotId).pending,
        synced: active.platform.memory.status(dotId).synced,
      },
    }),
  );
  // Restart while processing is pending, proving that the event ID and turn persist.
  await close();
  active = await open();
  assert.equal(active.workspace.dots()[0].id, dotId);
  assert(
    active.workspace.localConversations
      .get('first')
      .messages.some((message) => message.role === 'assistant'),
  );
  await settle();
  const recalled = await active.platform.memory.recall(
    dotId,
    `What dashboard accent color do I prefer for project ${project}?`,
  );
  assert(
    recalled.some((memory) => /amber/i.test(memory.text)),
    'Mem0 did not retrieve the remembered fact.',
  );
  console.log(
    JSON.stringify({
      restartPersistence: true,
      extractionSucceeded: true,
      relevantMemories: recalled.length,
    }),
  );
  active.workspace.bindThread('second', dotId, 'Recall in a new conversation');
  const second = await ask(
    'second',
    `What is my dashboard accent color for project ${project}? Reply with just the color.`,
  );
  assert(
    /amber/i.test(second),
    'The new conversation did not recall the preference.',
  );
  await settle();
  const otherDot = active.workspace.createDot(
    active.workspace.dots()[0].spaceId,
    'Isolated verification Dot',
    'Help with the isolated memory test.',
    false,
    true,
  );
  assert.deepEqual(
    await active.platform.memory.recall(
      otherDot.id,
      `What is the dashboard color for ${project}?`,
    ),
    [],
  );
  const report = {
    verifiedAt: new Date().toISOString(),
    provider: 'mem0',
    model: model.model,
    normalChatApi: !memoryOnly,
    liveModelResponses: !memoryOnly,
    durableHistoryAfterRestart: true,
    pendingEventAfterRestart: true,
    extractionConfirmed: true,
    newConversationRecall: true,
    dotIsolation: true,
    pending: active.platform.memory.status(dotId).pending,
    synced: active.platform.memory.status(dotId).synced,
  };
  mkdirSync('artifacts', { recursive: true });
  writeFileSync(
    'artifacts/dot-memory-verification.json',
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  await close();
  // Delete only this script's synthetic user/agent scope, never real owner data.
  if (dotId) {
    cleanupSucceeded = true;
    for (const entity of ['user_id', 'agent_id']) {
      const url = new URL('/v1/memories/', mem0.mem0BaseUrl);
      url.searchParams.set(entity, `opendots:${owner}:${dotId}`);
      if (mem0.mem0OrgId) url.searchParams.set('org_id', mem0.mem0OrgId);
      if (mem0.mem0ProjectId)
        url.searchParams.set('project_id', mem0.mem0ProjectId);
      const response = await fetch(url, {
        method: 'DELETE',
        redirect: 'error',
        headers: { Authorization: `Token ${mem0.mem0ApiKey}` },
        signal: AbortSignal.timeout(10000),
      });
      cleanupSucceeded = cleanupSucceeded && response.ok;
    }
  }
  console.log(JSON.stringify({ syntheticMemoryCleanup: cleanupSucceeded }));
  rmSync(directory, { recursive: true, force: true });
}
