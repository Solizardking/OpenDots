import * as ows from '@open-wallet-standard/core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WalletCredential } from '../shared/wallet-types.js';

export class WalletError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const aliases: Record<string, string> = {
  evm: 'eip155:1',
  ethereum: 'eip155:1',
  base: 'eip155:8453',
  polygon: 'eip155:137',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  bitcoin: 'bip122:000000000019d6689c085ae165831e93',
};
export function canonicalWalletChain(chain: string) {
  const canonical = aliases[chain] ?? chain;
  if (!/^[a-z0-9-]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(canonical))
    throw new WalletError(
      'CAIP_PARSE_ERROR',
      'Choose a canonical CAIP-2 chain or a supported chain alias.',
    );
  return canonical;
}
export function walletCredential(credential: WalletCredential) {
  const token = credential.value.startsWith('ows_key_');
  if ((credential.type === 'api_token') !== token)
    throw new WalletError(
      'INVALID_INPUT',
      'The credential type does not match its value.',
    );
  if (!credential.value)
    throw new WalletError(
      'INVALID_PASSPHRASE',
      'A wallet credential is required.',
      401,
    );
  return credential.value;
}
/** Profile A: the reference Rust signer shares the server process; no secrets leave it. */
export class WalletService {
  readonly vault: string;
  constructor(vaultPath: string) {
    this.vault = resolve(vaultPath);
    mkdirSync(this.vault, { recursive: true, mode: 0o700 });
  }
  private run<T>(fn: () => T, secret?: string): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof WalletError) throw error;
      let message =
        error instanceof Error ? error.message : 'OWS operation failed.';
      if (secret) message = message.split(secret).join('[redacted]');
      const mappings: [RegExp, string, number][] = [
        [/policy.*denied|not in allowlist|not allowed/i, 'POLICY_DENIED', 403],
        [/api.?key.*expired|token.*expired/i, 'API_KEY_EXPIRED', 403],
        [
          /api.?key.*not found|key not found|invalid api.?key/i,
          'API_KEY_NOT_FOUND',
          401,
        ],
        [
          /passphrase|decryption|decrypt|authentication tag/i,
          'INVALID_PASSPHRASE',
          401,
        ],
        [/wallet.*not found|wallet.*does not exist/i, 'WALLET_NOT_FOUND', 404],
        [
          /unsupported.*chain|chain.*not supported/i,
          'CHAIN_NOT_SUPPORTED',
          400,
        ],
        [/caip|chain.*parse/i, 'CAIP_PARSE_ERROR', 400],
      ];
      const [, code, status] = mappings.find(([pattern]) =>
        pattern.test(message),
      ) ?? [null, 'INVALID_INPUT', 400];
      throw new WalletError(code, message.slice(0, 400), status);
    }
  }
  private owner(value: string) {
    return walletCredential({ type: 'owner', value });
  }
  list() {
    return this.run(() => ows.listWallets(this.vault));
  }
  get(id: string) {
    return this.run(() => ows.getWallet(id, this.vault));
  }
  create(name: string, passphrase: string) {
    return this.run(
      () => ows.createWallet(name, this.owner(passphrase), 24, this.vault),
      passphrase,
    );
  }
  import(
    name: string,
    kind: 'mnemonic' | 'private_key',
    value: string,
    passphrase: string,
    chain?: string,
  ) {
    return this.run(
      () =>
        kind === 'mnemonic'
          ? ows.importWalletMnemonic(
              name,
              value,
              this.owner(passphrase),
              undefined,
              this.vault,
            )
          : ows.importWalletPrivateKey(
              name,
              value,
              this.owner(passphrase),
              this.vault,
              chain,
            ),
      value,
    );
  }
  delete(id: string) {
    return this.run(() => {
      ows.deleteWallet(id, this.vault);
      return { deleted: true };
    });
  }
  sign(
    id: string,
    chain: string,
    operation: 'sign' | 'signAndSend' | 'signMessage' | 'signTypedData',
    payload: string,
    credential: WalletCredential,
    rpcUrl?: string,
    encoding: 'utf8' | 'hex' = 'utf8',
  ) {
    const wallet = this.get(id);
    const canonical = canonicalWalletChain(chain);
    const value = walletCredential(credential);
    // The core evaluates token scope and attached policies before decryption. Never retry as owner.
    return this.run(() => {
      if (operation === 'signMessage')
        return {
          ...ows.signMessage(
            wallet.id,
            canonical,
            payload,
            value,
            encoding,
            undefined,
            this.vault,
          ),
          chainId: canonical,
          broadcast: false,
        };
      if (operation === 'signTypedData')
        return {
          ...ows.signTypedData(
            wallet.id,
            canonical,
            payload,
            value,
            undefined,
            this.vault,
          ),
          chainId: canonical,
          broadcast: false,
        };
      if (operation === 'signAndSend')
        return {
          ...ows.signAndSend(
            wallet.id,
            canonical,
            payload,
            value,
            undefined,
            rpcUrl,
            this.vault,
          ),
          chainId: canonical,
          broadcast: true,
        };
      return {
        ...ows.signTransaction(
          wallet.id,
          canonical,
          payload,
          value,
          undefined,
          this.vault,
        ),
        chainId: canonical,
        broadcast: false,
      };
    }, value);
  }
  policies() {
    return this.run(
      () => ows.listPolicies(this.vault) as Record<string, unknown>[],
    );
  }
  policy(id: string) {
    return this.run(
      () => ows.getPolicy(id, this.vault) as Record<string, unknown>,
    );
  }
  createPolicy(policy: Record<string, unknown>) {
    return this.run(() => {
      ows.createPolicy(JSON.stringify(policy), this.vault);
      return this.policy(String(policy.id));
    });
  }
  deletePolicy(id: string) {
    return this.run(() => {
      ows.deletePolicy(id, this.vault);
      return { deleted: true };
    });
  }
  keys() {
    return this.run(
      () => ows.listApiKeys(this.vault) as Record<string, unknown>[],
    );
  }
  createKey(
    name: string,
    walletIds: string[],
    policyIds: string[],
    passphrase: string,
    expiresAt?: string,
  ) {
    return this.run(
      () =>
        ows.createApiKey(
          name,
          walletIds.map((id) => this.get(id).id),
          policyIds,
          this.owner(passphrase),
          expiresAt,
          this.vault,
        ),
      passphrase,
    );
  }
  revokeKey(id: string) {
    return this.run(() => {
      ows.revokeApiKey(id, this.vault);
      return { deleted: true };
    });
  }
}
