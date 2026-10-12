import type { DatabaseSync } from 'node:sqlite';
export class BrainStore {
  constructor(
    db: DatabaseSync,
    owner: string,
    now?: () => number,
    allowedScopes?: () => string[],
  );
}
