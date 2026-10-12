import type { DatabaseSync } from 'node:sqlite';

export interface MemoryTurn {
  id: string;
  dotId: string;
  threadId: string;
  runId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  eventId?: string;
  attempts: number;
}
export interface RecalledMemory {
  id: string;
  text: string;
}

// The outbox and recall cache live beside the Dot and conversation records.
export class DotMemoryStore {
  constructor(
    private db: DatabaseSync,
    private ownerId: string,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dot_memory_jobs (
        id TEXT PRIMARY KEY, dotId TEXT NOT NULL, value TEXT NOT NULL,
        status TEXT NOT NULL, nextAttemptAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dot_memory_due ON dot_memory_jobs(status, nextAttemptAt);
      CREATE TABLE IF NOT EXISTS dot_memory_cache (
        dotId TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(dotId, id)
      );
      CREATE TABLE IF NOT EXISTS dot_memory_health (
        dotId TEXT PRIMARY KEY, error TEXT, lastRecallAt INTEGER
      );
    `);
  }
  private scoped(dotId: string) {
    return JSON.stringify([this.ownerId, dotId]);
  }
  enqueue(turn: MemoryTurn) {
    return (
      this.db
        .prepare(
          'INSERT OR IGNORE INTO dot_memory_jobs VALUES (?, ?, ?, ?, 0, ?)',
        )
        .run(
          turn.id,
          this.scoped(turn.dotId),
          JSON.stringify(turn),
          'queued',
          Date.now(),
        ).changes > 0
    );
  }
  due(now = Date.now(), dotIds?: string[]): MemoryTurn[] {
    if (dotIds?.length === 0) return [];
    return this.db
      .prepare(
        `SELECT value FROM dot_memory_jobs WHERE status != 'synced' AND nextAttemptAt <= ? ${dotIds ? `AND dotId IN (${dotIds.map(() => '?').join(',')})` : ''} ORDER BY updatedAt LIMIT 10`,
      )
      .all(now, ...(dotIds || []).map((id) => this.scoped(id)))
      .map((row) => JSON.parse(String(row.value)) as MemoryTurn);
  }
  update(turn: MemoryTurn, status: 'queued' | 'pending' | 'synced', delay = 0) {
    this.db
      .prepare(
        'UPDATE dot_memory_jobs SET value=?, status=?, nextAttemptAt=?, updatedAt=? WHERE id=?',
      )
      .run(
        JSON.stringify(status === 'synced' ? { ...turn, messages: [] } : turn),
        status,
        Date.now() + delay,
        Date.now(),
        turn.id,
      );
  }
  cache(dotId: string, memories: RecalledMemory[]) {
    dotId = this.scoped(dotId);
    const statement = this.db.prepare(
      'INSERT INTO dot_memory_cache VALUES (?, ?, ?, ?) ON CONFLICT(dotId, id) DO UPDATE SET text=excluded.text, updatedAt=excluded.updatedAt',
    );
    for (const memory of memories)
      statement.run(dotId, memory.id, memory.text, Date.now());
    this.db
      .prepare(
        'DELETE FROM dot_memory_cache WHERE dotId=? AND id NOT IN (SELECT id FROM dot_memory_cache WHERE dotId=? ORDER BY updatedAt DESC LIMIT 100)',
      )
      .run(dotId, dotId);
    this.db
      .prepare(
        'INSERT INTO dot_memory_health VALUES (?, NULL, ?) ON CONFLICT(dotId) DO UPDATE SET error=NULL, lastRecallAt=excluded.lastRecallAt',
      )
      .run(dotId, Date.now());
  }
  memories(dotId: string): RecalledMemory[] {
    dotId = this.scoped(dotId);
    return this.db
      .prepare(
        'SELECT id, text FROM dot_memory_cache WHERE dotId=? ORDER BY updatedAt DESC LIMIT 100',
      )
      .all(dotId) as unknown as RecalledMemory[];
  }
  error(dotId: string, error: string | null) {
    dotId = this.scoped(dotId);
    this.db
      .prepare(
        'INSERT INTO dot_memory_health VALUES (?, ?, NULL) ON CONFLICT(dotId) DO UPDATE SET error=excluded.error',
      )
      .run(dotId, error);
  }
  status(dotId: string) {
    dotId = this.scoped(dotId);
    const counts = this.db
      .prepare(
        "SELECT SUM(status != 'synced') AS pending, SUM(status = 'synced') AS synced FROM dot_memory_jobs WHERE dotId=?",
      )
      .get(dotId)!;
    const health = this.db
      .prepare(
        'SELECT error, lastRecallAt FROM dot_memory_health WHERE dotId=?',
      )
      .get(dotId);
    return {
      pending: Number(counts.pending ?? 0),
      synced: Number(counts.synced ?? 0),
      error: health?.error ? String(health.error) : null,
      lastRecallAt: health?.lastRecallAt ? Number(health.lastRecallAt) : null,
    };
  }
}
