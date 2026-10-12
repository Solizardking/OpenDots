import { compactEvents } from '@ag-ui/client';
import { EventType, type BaseEvent } from '@ag-ui/core';
import {
  AgentRunner,
  finalizeRunEvents,
  type AgentRunnerRunRequest,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerStopRequest,
} from '@copilotkit/runtime/v2';
import { Observable, ReplaySubject } from 'rxjs';
import type { WorkspaceStore } from './workspace.js';

interface ActiveTurn {
  request: AgentRunnerRunRequest;
  events: ReplaySubject<BaseEvent>;
  stopped: boolean;
  done: Promise<void>;
}

// The existing CopilotKit chat and review tools use SSE when Intelligence is
// absent. SQLite owns history; each runner owns only its currently active turns.
export class LocalConversationRunner extends AgentRunner {
  readonly ɵsupportsLocalThreadEndpoints = true;
  private active = new Map<string, ActiveTurn>();
  constructor(private workspace: WorkspaceStore) {
    super();
  }
  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { threadId, agent } = request;
    this.workspace.requireThread(threadId, agent.agentId);
    if (this.active.has(threadId))
      throw new Error('Conversation already running.');
    const prior = this.workspace.localConversations.get(threadId);
    const messages = new Map(
      prior.messages.map((message) => [message.id, message]),
    );
    for (const message of request.input.messages)
      messages.set(message.id, message);
    const input = {
      ...request.input,
      messages: [...messages.values()],
      state: { ...prior.state, ...request.input.state },
    };
    agent.threadId = threadId;
    agent.setMessages(input.messages);
    agent.setState(input.state);
    this.workspace.localConversations.save(threadId, {
      ...prior,
      messages: input.messages,
      state: input.state,
      updatedAt: Date.now(),
    });
    const turn: ActiveTurn = {
      request,
      events: new ReplaySubject<BaseEvent>(),
      stopped: false,
      done: Promise.resolve(),
    };
    this.active.set(threadId, turn);
    turn.done = this.execute(turn, input);
    return turn.events.asObservable();
  }
  private async execute(
    turn: ActiveTurn,
    input: AgentRunnerRunRequest['input'],
  ) {
    const { threadId, agent } = turn.request;
    const events: BaseEvent[] = [];
    const emit = (event: BaseEvent) => {
      events.push(event);
      turn.events.next(event);
    };
    let interruptionMessage: string | undefined;
    try {
      await agent.runAgent(input, { onEvent: ({ event }) => emit(event) });
    } catch (error) {
      interruptionMessage =
        error instanceof Error ? error.message : 'Conversation failed.';
    }
    try {
      for (const event of finalizeRunEvents(events, {
        stopRequested: turn.stopped,
        ...(interruptionMessage ? { interruptionMessage } : {}),
      }))
        emit(event);
      this.workspace.localConversations.save(threadId, {
        messages: agent.messages,
        state: agent.state,
        events: compactEvents(events),
        updatedAt: Date.now(),
      });
    } catch {
      emit({
        type: EventType.RUN_ERROR,
        message: 'Conversation history could not be saved. Please retry.',
      });
    } finally {
      this.active.delete(threadId);
      turn.events.complete();
    }
  }
  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    this.workspace.requireThread(request.threadId, request.agentId);
    return new Observable((subscriber) => {
      const saved = this.workspace.localConversations.get(request.threadId);
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: saved.messages,
      });
      subscriber.next({
        type: EventType.STATE_SNAPSHOT,
        snapshot: saved.state,
      });
      const turn = this.active.get(request.threadId);
      if (turn) return turn.events.subscribe(subscriber);
      subscriber.complete();
    });
  }
  async isRunning(request: AgentRunnerIsRunningRequest) {
    this.workspace.requireThread(request.threadId);
    return this.active.has(request.threadId);
  }
  async stop(request: AgentRunnerStopRequest) {
    this.workspace.requireThread(request.threadId);
    const turn = this.active.get(request.threadId);
    if (
      !turn ||
      turn.stopped ||
      (request.runId && turn.request.input.runId !== request.runId)
    )
      return false;
    turn.stopped = true;
    turn.request.agent.abortRun();
    return true;
  }
  async stopAll() {
    const turns = [...this.active.values()];
    for (const turn of turns)
      await this.stop({ threadId: turn.request.threadId });
    await Promise.all(turns.map((turn) => turn.done));
  }
  listThreads() {
    return this.workspace.conversations().map((thread) => ({
      id: thread.id,
      name: thread.title,
      agentId: thread.dotId,
      organizationId: '',
      createdById: thread.ownerId,
      archived: false,
      createdAt: new Date(thread.createdAt).toISOString(),
      updatedAt: new Date(
        this.workspace.localConversations.get(thread.id).updatedAt ||
          thread.createdAt,
      ).toISOString(),
    }));
  }
  getThreadMessages(threadId: string) {
    this.workspace.requireThread(threadId);
    return this.workspace.localConversations.get(threadId).messages;
  }
  getThreadEvents(threadId: string) {
    this.workspace.requireThread(threadId);
    return this.workspace.localConversations.get(threadId).events;
  }
  getThreadState(threadId: string) {
    this.workspace.requireThread(threadId);
    return this.workspace.localConversations.get(threadId).state;
  }
  clearThreads(): never {
    throw new Error('Clearing conversation history is not enabled.');
  }
}
