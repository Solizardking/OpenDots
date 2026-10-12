import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CompanionRegistry, companionAllows } from '../src/server/companion';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dots-companion-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
describe('phone pairing', () => {
  it('consumes the QR token once, persists only a hash, survives restart and revokes immediately', () => {
    const path = join(directory, 'devices.json');
    const registry = new CompanionRegistry(path);
    const window = registry.open()!;
    const { token, device } = registry.pair(window.token, 'My iPhone');
    expect(registry.authenticate(token)).toBe(device.id);
    expect(() => registry.pair(window.token, 'Other phone')).toThrow(
      'Start pairing',
    );
    expect(readFileSync(path, 'utf8')).not.toContain(token);
    expect(readFileSync(path, 'utf8')).not.toContain(window.token);
    const restored = new CompanionRegistry(path);
    expect(restored.authenticate(token)).toBe(device.id);
    restored.revoke(device.id);
    expect(restored.authenticate(token)).toBeUndefined();
    expect(new CompanionRegistry(path).list()).toEqual([]);
  });
  it('expires codes and device sessions and burns a code after five incorrect attempts', () => {
    let now = 1000;
    const registry = new CompanionRegistry(
      join(directory, 'devices.json'),
      () => now,
    );
    registry.open();
    for (let i = 0; i < 5; i++)
      expect(() => registry.pair('invalid', 'phone')).toThrow();
    expect(registry.pairing()).toBeNull();
    const expired = registry.open()!;
    now += 120001;
    expect(() => registry.pair(expired.code, 'phone')).toThrow('Start pairing');
    const { token } = registry.pair(registry.open()!.code, 'phone');
    now += 30 * 86400000 + 1;
    expect(registry.authenticate(token)).toBeUndefined();
  });
  it('does not let the ninth phone register and cancel ends the live pairing', () => {
    const registry = new CompanionRegistry(join(directory, 'devices.json'));
    for (let i = 0; i < 8; i++)
      registry.pair(registry.open()!.token, `Phone ${i}`);
    expect(() => registry.pair(registry.open()!.token, 'Ninth')).toThrow(
      'Remove a paired device',
    );
    registry.cancel();
    expect(registry.pairing()).toBeNull();
  });
  it('allows conversation transport and denies wallet signing, key changes and future APIs', () => {
    for (const [method, path] of [
      ['GET', '/api/workspace'],
      ['POST', '/api/conversations'],
      ['GET', '/api/conversations/123/page-context'],
      ['POST', '/api/conversations/123/page'],
      ['POST', '/api/copilotkit/agent/dot/run'],
      ['GET', '/api/copilotkit/threads/123/messages'],
    ])
      expect(companionAllows(method, path)).toBe(true);
    for (const [method, path] of [
      ['POST', '/api/wallets/123/sign'],
      ['GET', '/api/wallets'],
      ['PATCH', '/api/settings'],
      ['POST', '/api/companion/start'],
      ['DELETE', '/api/connections/123'],
      ['POST', '/api/spaces/123/future-feature'],
      ['POST', '/api/voice/calls'],
      ['POST', '/api/future-feature'],
    ])
      expect(companionAllows(method, path)).toBe(false);
  });
});
