import type { BaseEvent, Message } from '@ag-ui/core';
import type { DatabaseSync } from 'node:sqlite';

export interface ConversationSnapshot {
  messages: Message[];
  state: Record<string, unknown>;
  events: BaseEvent[];
  updatedAt: number;
}

export class LocalConversations {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS conversation_snapshots(threadId TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
  }
  get(threadId: string): ConversationSnapshot {
    const row = this.db
      .prepare('SELECT value FROM conversation_snapshots WHERE threadId=?')
      .get(threadId);
    return row
      ? (JSON.parse(String(row.value)) as ConversationSnapshot)
      : { messages: [], state: {}, events: [], updatedAt: 0 };
  }
  save(threadId: string, value: ConversationSnapshot) {
    this.db
      .prepare(
        'INSERT INTO conversation_snapshots VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
}
