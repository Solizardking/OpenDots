import { randomUUID } from 'node:crypto';

// SQLite is the workspace source of truth. The journal is also a durable
// Supermemory outbox; failed provider calls remain retryable across restarts.
export class BrainStore {
  constructor(db, owner, now = Date.now, allowedScopes = () => null) {
    this.db = db;
    this.owner = owner;
    this.now = now;
    this.allowedScopes = allowedScopes;
    db.exec(`CREATE TABLE IF NOT EXISTS trading_strategies (
      owner TEXT NOT NULL, scope TEXT NOT NULL, data TEXT NOT NULL,
      last_attempt_at INTEGER, PRIMARY KEY(owner,scope));
      CREATE TABLE IF NOT EXISTS trading_journal (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, wallet TEXT NOT NULL,
      type TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'pending', sync_error TEXT,
      retry_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS trading_journal_scope
      ON trading_journal(owner,wallet,created_at DESC);`);
  }
  row(row) {
    return row ? { ...row, data: JSON.parse(row.data) } : null;
  }
  rows(sql, ...args) {
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => this.row(row));
  }
  async strategy(scope) {
    return (
      this.row(
        this.db
          .prepare(
            'SELECT data FROM trading_strategies WHERE owner=? AND scope=?',
          )
          .get(this.owner, scope),
      )?.data ?? null
    );
  }
  async save_strategy(scope, data) {
    this.db
      .prepare(
        `INSERT INTO trading_strategies(owner,scope,data) VALUES(?,?,?)
      ON CONFLICT(owner,scope) DO UPDATE SET data=excluded.data`,
      )
      .run(this.owner, scope, JSON.stringify(data));
    await this.record(scope, 'strategy', data);
    return data;
  }
  async monitoring(scope, enabled, until) {
    const data = await this.strategy(scope);
    if (!data) return null;
    data.monitorUntil = enabled ? until : null;
    this.db
      .prepare('UPDATE trading_strategies SET data=? WHERE owner=? AND scope=?')
      .run(JSON.stringify(data), this.owner, scope);
    return data;
  }
  async active() {
    return this.rows(
      `SELECT scope AS wallet,data FROM trading_strategies WHERE owner=?
      AND json_extract(data,'$.monitorUntil')>?
      AND (last_attempt_at IS NULL OR last_attempt_at<?)
      ORDER BY last_attempt_at LIMIT 20`,
      this.owner,
      this.now(),
      this.now() - 60000,
    );
  }
  async attempt(scope) {
    this.db
      .prepare(
        'UPDATE trading_strategies SET last_attempt_at=? WHERE owner=? AND scope=?',
      )
      .run(this.now(), this.owner, scope);
  }
  async record(scope, type, data, id = randomUUID()) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO trading_journal(id,owner,wallet,type,data,created_at,retry_at)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        this.owner,
        scope,
        type,
        JSON.stringify(data),
        this.now(),
        this.now(),
      );
    const row = await this.get(scope, id);
    if (!row) throw Error('Journal identity belongs to another scope.');
    return row;
  }
  async get(scope, id) {
    return this.row(
      this.db
        .prepare(
          'SELECT * FROM trading_journal WHERE owner=? AND wallet=? AND id=?',
        )
        .get(this.owner, scope, id),
    );
  }
  async recent(scope, limit = 50) {
    return this.rows(
      'SELECT * FROM trading_journal WHERE owner=? AND wallet=? ORDER BY created_at DESC,rowid DESC LIMIT ?',
      this.owner,
      scope,
      limit,
    );
  }
  async decision_count(scope) {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM trading_journal WHERE owner=? AND wallet=? AND type='decision' AND created_at>?",
        )
        .get(this.owner, scope, this.now() - 86400000).n,
    );
  }
  async benchmarks() {
    return this.bounded(
      `SELECT j.* FROM trading_journal j WHERE j.owner=? AND j.type='decision'
      AND j.created_at>? AND j.created_at<=?-COALESCE(json_extract(j.data,'$.observationWindowMs'),300000)
      AND json_extract(j.data,'$.gate')='wallet_review'
      AND NOT EXISTS(SELECT 1 FROM trading_journal o WHERE o.owner=j.owner AND o.wallet=j.wallet AND o.type='paper_outcome'
      AND json_extract(o.data,'$.decisionId')=j.id) ORDER BY j.created_at`,
      this.owner,
      this.now() - 3600000,
      this.now(),
    );
  }
  bounded(sql, ...args) {
    const scopes = this.allowedScopes(),
      allowed = scopes === null ? null : new Set(scopes);
    const result = [];
    for (const row of this.db.prepare(sql).iterate(...args)) {
      if (allowed && !allowed.has(row.wallet)) continue;
      result.push(this.row(row));
      if (result.length === 3) break;
    }
    return result;
  }
  async pending() {
    return this.bounded(
      "SELECT * FROM trading_journal WHERE owner=? AND sync_status IN ('pending','failed') AND retry_at<=? ORDER BY created_at",
      this.owner,
      this.now(),
    );
  }
  async synced(id, status, error = null) {
    this.db
      .prepare(
        'UPDATE trading_journal SET sync_status=?,sync_error=?,retry_at=? WHERE owner=? AND id=?',
      )
      .run(status, error, this.now() + 300000, this.owner, id);
  }
  async processing() {
    return this.bounded(
      "SELECT * FROM trading_journal WHERE owner=? AND sync_status='queued' AND retry_at<=? ORDER BY retry_at",
      this.owner,
      this.now(),
    );
  }
  // Execution remains in the existing Pump/Jupiter services and approval cards.
  async orders() {
    return [];
  }
}
