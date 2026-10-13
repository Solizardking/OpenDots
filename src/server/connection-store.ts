import type { DatabaseSync } from 'node:sqlite';
import {
  randomUUID,
  randomBytes,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SupermemoryOAuthCredentials } from './supermemory-oauth.js';
import type {
  Connection,
  ConnectionActionResult,
  ConnectionTool,
} from '../shared/connection-types.js';
type Row = Omit<Connection, 'hasToken' | 'tools'> & {
  token: string | null;
  tools: string;
};
export class ConnectionStore {
  private oauthKey?: Buffer;
  constructor(
    private db: DatabaseSync,
    readonly ownerId = 'local-owner',
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT, tools TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_actions(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, toolCallId));`);
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_oauth_credentials(connectionId TEXT PRIMARY KEY, encrypted TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_oauth_attempts(stateHash TEXT PRIMARY KEY, connectionId TEXT NOT NULL UNIQUE, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, callbackUrl TEXT NOT NULL, expiresAt INTEGER NOT NULL);`);
    // A receipt belongs to the approval that produced it.
    if (
      !db
        .prepare('PRAGMA table_info(mcp_actions)')
        .all()
        .some((column) => column.name === 'approvalId')
    )
      db.exec('ALTER TABLE mcp_actions ADD COLUMN approvalId TEXT');
  }
  private rows(dotId?: string) {
    return this.db
      .prepare(
        `SELECT * FROM mcp_connections ${dotId ? 'WHERE dotId=?' : ''} ORDER BY createdAt, rowid`,
      )
      .all(...(dotId ? [dotId] : [])) as unknown as Row[];
  }
  private view({ token, tools, ...row }: Row): Connection {
    const oauth = this.db
      .prepare('SELECT status FROM mcp_oauth_credentials WHERE connectionId=?')
      .get(row.id);
    return {
      ...row,
      hasToken: oauth ? oauth.status === 'connected' : !!token,
      tools: JSON.parse(tools),
      ...(oauth
        ? {
            provider: 'supermemory' as const,
            auth: 'oauth' as const,
            authStatus: oauth.status as 'pending' | 'connected' | 'expired',
          }
        : {}),
    };
  }
  list(dotId: string): Connection[] {
    return this.rows(dotId).map((row) => this.view(row));
  }
  get(id: string): Connection | undefined {
    const row = this.rows().find((row) => row.id === id);
    return row && this.view(row);
  }
  // Secrets never leave the server: only the MCP transport reads them.
  credentials(id: string) {
    const row = this.rows().find((row) => row.id === id);
    if (!row) throw new Error('Connection not found.');
    return { url: row.url, token: row.token ?? undefined, connectionId: id };
  }
  create(
    dotId: string,
    value: { name: string; url: string; token?: string },
    tools: ConnectionTool[],
  ): Connection {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO mcp_connections VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)',
      )
      .run(
        id,
        dotId,
        value.name,
        value.url,
        value.token || null,
        JSON.stringify(tools),
        now,
        now,
      );
    return this.get(id)!;
  }
  saveTools(id: string, tools: ConnectionTool[], error: string | null = null) {
    this.db
      .prepare(
        'UPDATE mcp_connections SET tools=?, error=?, updatedAt=? WHERE id=?',
      )
      .run(JSON.stringify(tools), error, this.tick(id), id);
    return this.get(id)!;
  }
  setError(id: string, error: string) {
    this.db
      .prepare('UPDATE mcp_connections SET error=?, updatedAt=? WHERE id=?')
      .run(error, this.tick(id), id);
    return this.get(id)!;
  }
  remove(id: string) {
    this.db
      .prepare('DELETE FROM mcp_oauth_attempts WHERE connectionId=?')
      .run(id);
    this.db
      .prepare('DELETE FROM mcp_oauth_credentials WHERE connectionId=?')
      .run(id);
    return (
      this.db.prepare('DELETE FROM mcp_connections WHERE id=?').run(id)
        .changes > 0
    );
  }
  // OAuth credentials are encrypted with a mode-0600 key beside the workspace
  // database. The private key survives releases on the same durable data volume.
  // Memory-only test workspaces keep their key in memory.
  private encryptionKey() {
    if (this.oauthKey) return this.oauthKey;
    const file = this.db
      .prepare('PRAGMA database_list')
      .all()
      .find((row) => row.name === 'main')?.file;
    if (!file) return (this.oauthKey = randomBytes(32));
    const keyPath = `${String(file)}.mcp-oauth.key`;
    mkdirSync(dirname(keyPath), { recursive: true });
    try {
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const key = readFileSync(keyPath);
    if (key.length !== 32)
      throw new Error('OAuth credential storage is unavailable.');
    return (this.oauthKey = key);
  }
  oauthCredentials(id: string): SupermemoryOAuthCredentials | undefined {
    const row = this.db
      .prepare(
        'SELECT encrypted FROM mcp_oauth_credentials WHERE connectionId=?',
      )
      .get(id);
    if (!row) return undefined;
    try {
      const [iv, tag, data] = String(row.encrypted)
        .split('.')
        .map((part) => Buffer.from(part, 'base64url'));
      const cipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), iv);
      cipher.setAAD(Buffer.from(id));
      cipher.setAuthTag(tag);
      return JSON.parse(
        Buffer.concat([cipher.update(data), cipher.final()]).toString(),
      );
    } catch {
      throw new Error(
        'OAuth credential storage is unavailable. Reconnect Supermemory.',
      );
    }
  }
  saveOAuth(
    id: string,
    credentials: SupermemoryOAuthCredentials,
    status?: 'pending' | 'connected' | 'expired',
  ) {
    if (!this.get(id)) throw new Error('Connection not found.');
    const previous = this.db
      .prepare('SELECT status FROM mcp_oauth_credentials WHERE connectionId=?')
      .get(id);
    const nextStatus = status ?? String(previous?.status ?? 'pending');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(credentials)),
      cipher.final(),
    ]);
    const encrypted = [iv, cipher.getAuthTag(), data]
      .map((part) => part.toString('base64url'))
      .join('.');
    this.db
      .prepare(
        'INSERT INTO mcp_oauth_credentials VALUES (?, ?, ?) ON CONFLICT(connectionId) DO UPDATE SET encrypted=excluded.encrypted,status=excluded.status',
      )
      .run(id, encrypted, nextStatus);
    this.db.prepare('UPDATE mcp_connections SET token=NULL WHERE id=?').run(id);
    if (nextStatus === 'pending')
      this.db
        .prepare('UPDATE mcp_connections SET error=NULL WHERE id=?')
        .run(id);
    if (previous?.status !== nextStatus)
      this.db
        .prepare('UPDATE mcp_connections SET updatedAt=? WHERE id=?')
        .run(this.tick(id), id);
  }
  beginOAuth(id: string, callbackUrl: string, ttlMs: number) {
    const connection = this.get(id);
    if (!connection) throw new Error('Connection not found.');
    const state = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(state).digest('hex');
    this.db
      .prepare(
        'DELETE FROM mcp_oauth_attempts WHERE connectionId=? OR expiresAt<=?',
      )
      .run(id, Date.now());
    this.db
      .prepare('INSERT INTO mcp_oauth_attempts VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        hash,
        id,
        connection.dotId,
        this.ownerId,
        callbackUrl,
        Date.now() + ttlMs,
      );
    return state;
  }
  consumeOAuth(state: string, callbackUrl?: string) {
    const hash = createHash('sha256').update(state).digest('hex');
    const attempt = this.db
      .prepare(
        `DELETE FROM mcp_oauth_attempts WHERE stateHash=? AND ownerId=? AND expiresAt>? ${callbackUrl ? 'AND callbackUrl=?' : ''} RETURNING *`,
      )
      .get(
        hash,
        this.ownerId,
        Date.now(),
        ...(callbackUrl ? [callbackUrl] : []),
      );
    if (!attempt)
      throw new Error(
        'Supermemory authorization expired or is not valid for this workspace. Reconnect Supermemory.',
      );
    const connection = this.get(String(attempt.connectionId));
    if (!connection || connection.dotId !== attempt.dotId)
      throw new Error('Supermemory connection no longer exists.');
    return { connection, callbackUrl: String(attempt.callbackUrl) };
  }
  // Running turns compare this to stop as soon as the owner changes access.
  fingerprint(dotId: string) {
    return this.rows(dotId)
      .map((row) => `${row.id}:${row.updatedAt}`)
      .join(',');
  }
  // Keep updatedAt strictly increasing so rapid edits always change the fingerprint.
  private tick(id: string) {
    return Math.max(Date.now(), (this.get(id)?.updatedAt ?? 0) + 1);
  }
  // Binds a gated call to its exact connection, tool, and arguments, so a
  // later approval runs that call and nothing else.
  createApproval(value: {
    threadId: string;
    dotId: string;
    connectionId: string;
    tool: string;
    arguments: Record<string, unknown>;
  }) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO mcp_approvals VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        value.threadId,
        value.dotId,
        value.connectionId,
        value.tool,
        JSON.stringify(value.arguments),
        Date.now(),
      );
    return id;
  }
  approval(id: string) {
    const row = this.db
      .prepare('SELECT * FROM mcp_approvals WHERE id=?')
      .get(id);
    if (!row) return undefined;
    return {
      id: String(row.id),
      threadId: String(row.threadId),
      dotId: String(row.dotId),
      connectionId: String(row.connectionId),
      tool: String(row.tool),
      arguments: JSON.parse(String(row.arguments)) as Record<string, unknown>,
      createdAt: Number(row.createdAt),
    };
  }
  action(threadId: string, toolCallId: string) {
    const row = this.db
      .prepare(
        'SELECT status, result, approvalId FROM mcp_actions WHERE threadId=? AND toolCallId=?',
      )
      .get(threadId, toolCallId);
    if (!row) return undefined;
    return {
      approvalId: typeof row.approvalId === 'string' ? row.approvalId : null,
      status: String(row.status) as 'running' | 'done',
      result:
        typeof row.result === 'string'
          ? (JSON.parse(row.result) as ConnectionActionResult)
          : null,
    };
  }
  // Claim an approved action once. Returns false if it was already claimed,
  // so a double click or a retried request never executes twice.
  claimAction(
    threadId: string,
    toolCallId: string,
    approvalId: string,
    connectionId: string,
    tool: string,
  ) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO mcp_actions (threadId, toolCallId, connectionId, tool, status, result, createdAt, approvalId) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)",
        )
        .run(threadId, toolCallId, connectionId, tool, Date.now(), approvalId)
        .changes > 0
    );
  }
  finishAction(
    threadId: string,
    toolCallId: string,
    result: ConnectionActionResult,
  ) {
    this.db
      .prepare(
        "UPDATE mcp_actions SET status='done', result=? WHERE threadId=? AND toolCallId=?",
      )
      .run(JSON.stringify(result), threadId, toolCallId);
  }
}
