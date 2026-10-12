import { IntelligenceAgent } from '@copilotkit/core';
import { HttpAgent } from '@ag-ui/client';
import type { Message } from '@ag-ui/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../shared/scheduled-message.js';

export function currentTurnText(messages: Message[], error?: Error): string {
  if (error) throw error;
  const content = messages
    .filter((message) => message.role === 'assistant')
    .at(-1)?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new Error('The current compute turn returned no assistant response.');
  return content;
}

const runtimeInfoSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('intelligence'),
    intelligence: z.object({ wsUrl: z.url() }),
    agents: z.record(z.string(), z.unknown()),
  }),
  z.object({
    mode: z.literal('sse'),
    agents: z.record(z.string(), z.unknown()),
  }),
]);

export async function runThreadTurn(
  runtimeUrl: string,
  headers: Record<string, string>,
  dotId: string,
  threadId: string,
  prompt: string,
  signal: AbortSignal,
  metadata?: Record<string, unknown>,
): Promise<string> {
  signal.throwIfAborted();
  const response = await fetch(`${runtimeUrl}/info`, { headers, signal });
  if (!response.ok)
    throw new Error(`Conversation runtime returned HTTP ${response.status}.`);
  const info = runtimeInfoSchema.parse(await response.json());
  if (!Object.hasOwn(info.agents, dotId))
    throw new Error('The selected Dot is unavailable in the runtime.');
  const abortableFetch: typeof fetch = (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    });
  const agent =
    info.mode === 'intelligence'
      ? new IntelligenceAgent({
          url: info.intelligence.wsUrl,
          runtimeUrl,
          agentId: dotId,
          headers,
          fetch: abortableFetch,
        })
      : new HttpAgent({
          url: `${runtimeUrl}/agent/${encodeURIComponent(dotId)}/run`,
          agentId: dotId,
          headers,
          fetch: abortableFetch,
        });
  agent.threadId = threadId;
  let runError: Error | undefined;
  const subscription = agent.subscribe({
    onRunErrorEvent: ({ event }) => {
      runError = new Error(event.message);
    },
  });
  const runId = randomUUID();
  let runStarted = false;
  let stopping: Promise<unknown> | undefined;
  const stop = () => {
    agent.abortRun();
    if (info.mode === 'sse' && runStarted)
      stopping = fetch(
        `${runtimeUrl}/agent/${encodeURIComponent(dotId)}/stop/${encodeURIComponent(threadId)}`,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId }),
          signal: AbortSignal.timeout(5000),
        },
      ).catch(() => undefined);
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted();
    if (info.mode === 'sse') {
      const history = await abortableFetch(
        `${runtimeUrl}/threads/${encodeURIComponent(threadId)}/messages`,
        { headers },
      );
      if (!history.ok)
        throw new Error(
          `Conversation history returned HTTP ${history.status}.`,
        );
      const data = (await history.json()) as { messages: Message[] };
      agent.setMessages(data.messages);
    }
    const idPrefix =
      metadata?.opendotsSource === 'voice_receipt'
        ? voiceReceiptMessagePrefix
        : metadata?.opendotsSource === 'scheduled_task'
          ? scheduledTaskMessagePrefix
          : '';
    agent.addMessage({
      id: `${idPrefix}${randomUUID()}`,
      role: 'user',
      content: prompt,
      ...(metadata ? { metadata } : {}),
    });
    runStarted = true;
    const result = await agent.runAgent({ runId });
    signal.throwIfAborted();
    return currentTurnText(result.newMessages, runError);
  } finally {
    signal.removeEventListener('abort', stop);
    subscription.unsubscribe();
    await stopping;
    if (agent instanceof IntelligenceAgent) await agent.detachActiveRun();
  }
}
