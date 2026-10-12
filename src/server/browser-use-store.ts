import type { DatabaseSync } from 'node:sqlite';
import type { BrowserUseState } from '../shared/browser-use-types.js';

export class BrowserUseStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS browser_use(dotId TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS browser_use_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
  }
  providerWorkspaceId(): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM browser_use_metadata WHERE key=?')
      .get('provider_workspace_id_v4');
    return row ? String(row.value) : undefined;
  }
  saveProviderWorkspaceId(id: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO browser_use_metadata VALUES (?,?)')
      .run('provider_workspace_id_v4', id);
  }
  get(dotId: string): BrowserUseState {
    const row = this.db
      .prepare('SELECT value FROM browser_use WHERE dotId=?')
      .get(dotId);
    return row ? JSON.parse(String(row.value)) : { enabled: false };
  }
  save(dotId: string, state: BrowserUseState) {
    this.db
      .prepare('INSERT OR REPLACE INTO browser_use VALUES (?,?)')
      .run(dotId, JSON.stringify(state));
  }
  ids(): string[] {
    return this.db
      .prepare('SELECT dotId FROM browser_use')
      .all()
      .map((row) => String(row.dotId));
  }
}
