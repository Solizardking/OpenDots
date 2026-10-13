import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const matches = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
export interface PairedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}
interface SavedDevice extends PairedDevice {
  tokenHash: string;
}

/** Pairing credentials are single-use, short-lived, and never persisted. */
export class CompanionRegistry {
  private devices: SavedDevice[] = [];
  private window?: {
    code: string;
    token: string;
    expiresAt: number;
    attempts: number;
  };
  constructor(
    private path: string,
    private now = Date.now,
  ) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (
        !Array.isArray(saved) ||
        saved.some(
          (d) =>
            typeof d.tokenHash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(d.tokenHash) ||
            typeof d.expiresAt !== 'number',
        )
      )
        throw Error('Invalid paired-device registry.');
      this.devices = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private persist(next: SavedDevice[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + '.tmp';
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.devices = next;
  }
  list(): PairedDevice[] {
    return this.devices
      .filter((d) => d.expiresAt > this.now())
      .map(({ tokenHash: _hash, ...device }) => device);
  }
  pairing() {
    if (this.window && this.window.expiresAt <= this.now())
      this.window = undefined;
    return this.window
      ? {
          code: this.window.code,
          token: this.window.token,
          expiresAt: this.window.expiresAt,
        }
      : null;
  }
  open() {
    this.window = {
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      token: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + 120_000,
      attempts: 5,
    };
    return this.pairing();
  }
  cancel() {
    this.window = undefined;
  }
  pair(credential: string, name: string) {
    const window = this.pairing();
    if (!window) throw Error('Start pairing from Phone on your Mac.');
    if (
      !matches(credential, window.code) &&
      !matches(credential, window.token)
    ) {
      if (--this.window!.attempts <= 0) this.cancel();
      throw Error('That code is incorrect or expired.');
    }
    if (this.list().length >= 8)
      throw Error('Remove a paired device before adding another.');
    const token = randomBytes(32).toString('base64url');
    const device: SavedDevice = {
      id: randomUUID(),
      name:
        [...name.trim()]
          .filter(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          )
          .join('')
          .slice(0, 60) || 'Phone',
      tokenHash: digest(token),
      createdAt: this.now(),
      lastSeenAt: this.now(),
      expiresAt: this.now() + 30 * 86400_000,
    };
    this.persist([
      ...this.devices.filter((d) => d.expiresAt > this.now()),
      device,
    ]);
    this.cancel();
    return { token, device: this.list().find((d) => d.id === device.id)! };
  }
  authenticate(token: string) {
    if (!token || token.length > 128) return undefined;
    const device = this.devices.find(
      (d) => d.expiresAt > this.now() && matches(d.tokenHash, digest(token)),
    );
    if (!device) return undefined;
    // Save last-seen at most once a minute, without replacing the token.
    if (this.now() - device.lastSeenAt > 60_000) {
      this.persist(
        this.devices.map((d) =>
          d.id === device.id ? { ...d, lastSeenAt: this.now() } : d,
        ),
      );
    }
    return device.id;
  }
  revoke(id: string) {
    this.persist(this.devices.filter((d) => d.id !== id));
  }
}

/** Phone access is deliberate. Keys, wallet signing, connection writes and settings stay on the Mac. */
export function companionAllows(method: string, path: string) {
  // Paired phones may perform scoped market reads; durable alert changes stay
  // in the owner's desktop workspace alongside provider credentials.
  if (method === 'GET' && /^\/api\/birdeye\/(?:status|alerts)$/.test(path))
    return true;
  if (method === 'POST' && /^\/api\/birdeye\/(?:query|stream)$/.test(path))
    return true;
  if (method === 'GET' && path.startsWith('/api/copilotkit/')) return true;
  if (method === 'GET')
    return /^\/api\/(?:state|workspace|memories|tasks(?:\/[\w-]+)?|conversations\/[\w-]+\/(?:capture|page-context|reviewed-page\/[\w-]+)|spaces(?:\/[\w-]+(?:\/pages(?:\/[\w-]+(?:\/history)?)?)?)|avatars\/[\w.-]+|auth\/(?:config|session))$/.test(
      path,
    );
  if (method === 'POST')
    return /^\/api\/(?:copilotkit(?:\/.*)?|conversations(?:\/[\w-]+\/(?:page|reviewed-page))?|setup-telemetry|spaces(?:\/[\w-]+\/pages(?:\/[\w-]+\/conversation)?)?)$/.test(
      path,
    );
  if (method === 'PATCH' || method === 'DELETE')
    return /^\/api\/spaces\/[\w-]+\/pages\/[\w-]+$/.test(path);
  // The CopilotKit SSE transport owns both history reads and chat operations.
  return false;
}
