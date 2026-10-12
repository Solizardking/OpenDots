import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WalletService,
  canonicalWalletChain,
  walletCredential,
} from '../src/server/wallet-service.js';
import { walletRoutes } from '../src/server/wallet-routes.js';
import { WorkspaceStore } from '../src/server/workspace.js';
const directories: string[] = [];
afterEach(() => {
  directories
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
it('preserves OWS encryption, public descriptors, owner signing, token policy enforcement and revocation', () => {
  const vault = mkdtempSync(join(tmpdir(), 'ows-'));
  directories.push(vault);
  const service = new WalletService(vault);
  const passphrase = 'fixture-encryption-passphrase';
  const wallet = service.create('Dot test', passphrase);
  expect(
    wallet.accounts.some((account) => account.chainId.startsWith('solana:')),
  ).toBe(true);
  expect(Object.keys(wallet).sort()).toEqual([
    'accounts',
    'createdAt',
    'id',
    'name',
  ]);
  const files = readdirSync(join(vault, 'wallets'))
    .map((file) => readFileSync(join(vault, 'wallets', file), 'utf8'))
    .join('');
  expect(files).not.toContain(passphrase);
  expect(files).toContain('ciphertext');
  const owner = service.sign(
    wallet.id,
    'solana',
    'signMessage',
    'OpenDots signing verification',
    { type: 'owner', value: passphrase },
  );
  expect(owner).toMatchObject({
    broadcast: false,
    chainId: canonicalWalletChain('solana'),
  });
  expect('signature' in owner && owner.signature).toMatch(/^[0-9a-f]+$/i);
  service.createPolicy({
    id: 'base-only',
    name: 'Base only',
    version: 1,
    created_at: new Date().toISOString(),
    rules: [{ type: 'allowed_chains', chain_ids: ['eip155:8453'] }],
    action: 'deny',
  });
  const access = service.createKey(
    'Scoped agent',
    [wallet.id],
    ['base-only'],
    passphrase,
  );
  expect(() =>
    service.sign(wallet.id, 'solana', 'signMessage', 'hello', {
      type: 'api_token',
      value: access.token,
    }),
  ).toThrow(/policy|allowlist/i);
  expect(
    service.sign(wallet.id, 'base', 'signMessage', 'hello', {
      type: 'api_token',
      value: access.token,
    }),
  ).toMatchObject({ broadcast: false, chainId: 'eip155:8453' });
  expect(JSON.stringify(service.keys())).not.toContain(access.token);
  service.revokeKey(access.id);
  expect(() =>
    service.sign(wallet.id, 'base', 'signMessage', 'hello', {
      type: 'api_token',
      value: access.token,
    }),
  ).toThrow();
  expect(() =>
    walletCredential({ type: 'owner', value: access.token }),
  ).toThrow('credential type');
  expect(() =>
    walletCredential({ type: 'api_token', value: passphrase }),
  ).toThrow('credential type');
  service.delete(wallet.id);
  expect(service.list()).toEqual([]);
}, 30000);
it('requires explicit signing approval and prevents deleting an assigned wallet', async () => {
  const vault = mkdtempSync(join(tmpdir(), 'ows-routes-'));
  directories.push(vault);
  const service = new WalletService(vault);
  const workspace = new WorkspaceStore(':memory:', 'owner');
  try {
    const wallet = service.create('Approval test', 'fixture-long-passphrase');
    const app = walletRoutes(service, workspace);
    const request = (data: unknown) => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const unsigned = await app.request(
      `/wallets/${wallet.id}/sign`,
      request({
        operation: 'signMessage',
        chainId: 'solana',
        payload: 'hello',
        credential: { type: 'owner', value: 'fixture-long-passphrase' },
      }),
    );
    expect(unsigned.status).toBe(400);
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, { ...dot, walletId: wallet.id });
    expect(
      (
        await app.request(`/wallets/${wallet.id}`, {
          ...request({ confirm: true }),
          method: 'DELETE',
        })
      ).status,
    ).toBe(409);
  } finally {
    workspace.close();
  }
}, 30000);
