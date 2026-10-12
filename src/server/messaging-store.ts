import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MessagingPlatform } from '../shared/messaging-types.js';

export type MessagingBinding = {
  id: string;
  ownerId: string;
  dotId: string;
  platform: MessagingPlatform;
  scope: string;
  senderId: string;
  spaceId: string;
  phone?: string;
  threadId?: string;
};
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
export class MessagingStore {
  constructor(
    private db: DatabaseSync,
    private now = Date.now,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messaging_links (
        hash TEXT PRIMARY KEY, ownerId TEXT NOT NULL, dotId TEXT NOT NULL,
        platform TEXT NOT NULL, scope TEXT NOT NULL, expiresAt INTEGER NOT NULL,
        UNIQUE(ownerId, platform));
      CREATE TABLE IF NOT EXISTS messaging_bindings (
        id TEXT NOT NULL UNIQUE, ownerId TEXT NOT NULL, dotId TEXT NOT NULL,
        platform TEXT NOT NULL, scope TEXT NOT NULL, senderId TEXT NOT NULL,
        spaceId TEXT NOT NULL, phone TEXT, threadId TEXT,
        PRIMARY KEY(ownerId, platform), UNIQUE(scope, platform, senderId));
      CREATE TABLE IF NOT EXISTS messaging_seen (
        id TEXT PRIMARY KEY, receivedAt INTEGER NOT NULL);
    `);
  }
  issue(
    ownerId: string,
    dotId: string,
    platform: MessagingPlatform,
    scope: string,
  ) {
    const code = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + 600000;
    this.db
      .prepare('DELETE FROM messaging_links WHERE expiresAt <= ?')
      .run(this.now());
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messaging_links
      (hash,ownerId,dotId,platform,scope,expiresAt) VALUES (?,?,?,?,?,?)`,
      )
      .run(hash(code), ownerId, dotId, platform, scope, expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }
  claim(
    code: string,
    identity: Omit<MessagingBinding, 'id' | 'ownerId' | 'dotId' | 'threadId'>,
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const pending = this.db
        .prepare(
          `SELECT ownerId,dotId FROM messaging_links
        WHERE hash=? AND platform=? AND scope=? AND expiresAt>?`,
        )
        .get(hash(code), identity.platform, identity.scope, this.now()) as
        { ownerId: string; dotId: string } | undefined;
      const existing = this.identity(
        identity.platform,
        identity.scope,
        identity.senderId,
      );
      if (!pending || (existing && existing.ownerId !== pending.ownerId)) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const binding: MessagingBinding = {
        ...identity,
        ...pending,
        id: randomUUID(),
      };
      this.db
        .prepare('DELETE FROM messaging_links WHERE hash=?')
        .run(hash(code));
      this.db
        .prepare(
          `INSERT OR REPLACE INTO messaging_bindings
        (id,ownerId,dotId,platform,scope,senderId,spaceId,phone) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          binding.id,
          binding.ownerId,
          binding.dotId,
          binding.platform,
          binding.scope,
          binding.senderId,
          binding.spaceId,
          binding.phone ?? null,
        );
      this.db.exec('COMMIT');
      return binding;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  hasLink(code: string, platform: MessagingPlatform, scope: string) {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM messaging_links WHERE hash=? AND platform=? AND scope=? AND expiresAt>?',
        )
        .get(hash(code), platform, scope, this.now()),
    );
  }
  private row(value: unknown): MessagingBinding | undefined {
    if (!value) return undefined;
    const row = value as MessagingBinding;
    return {
      ...row,
      phone: row.phone || undefined,
      threadId: row.threadId || undefined,
    };
  }
  binding(ownerId: string, platform: MessagingPlatform) {
    return this.row(
      this.db
        .prepare(
          'SELECT * FROM messaging_bindings WHERE ownerId=? AND platform=?',
        )
        .get(ownerId, platform),
    );
  }
  identity(platform: MessagingPlatform, scope: string, senderId: string) {
    return this.row(
      this.db
        .prepare(
          'SELECT * FROM messaging_bindings WHERE platform=? AND scope=? AND senderId=?',
        )
        .get(platform, scope, senderId),
    );
  }
  current(binding: MessagingBinding) {
    return this.binding(binding.ownerId, binding.platform)?.id === binding.id;
  }
  thread(binding: MessagingBinding, threadId: string) {
    return (
      this.db
        .prepare('UPDATE messaging_bindings SET threadId=? WHERE id=?')
        .run(threadId, binding.id).changes === 1
    );
  }
  unlink(ownerId: string, platform: MessagingPlatform) {
    const old = this.binding(ownerId, platform);
    this.db
      .prepare('DELETE FROM messaging_links WHERE ownerId=? AND platform=?')
      .run(ownerId, platform);
    this.db
      .prepare('DELETE FROM messaging_bindings WHERE ownerId=? AND platform=?')
      .run(ownerId, platform);
    return old;
  }
  seen(
    platform: MessagingPlatform,
    scope: string,
    spaceId: string,
    messageId: string,
    phone?: string,
  ) {
    const id = hash(
      JSON.stringify([platform, scope, spaceId, messageId, phone ?? '']),
    );
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO messaging_seen VALUES (?,?)')
        .run(id, this.now()).changes === 0
    );
  }
}
