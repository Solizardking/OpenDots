import { useEffect, useState } from 'react';
import { api } from './api';
import type {
  WalletDescriptor,
  WalletKeyDescriptor,
} from '../shared/wallet-types';

export function WalletEditor({
  walletId,
  onChange,
  dotName,
  onBusy,
}: {
  walletId: string | null;
  onChange: (id: string | null) => void;
  dotName: string;
  onBusy: (busy: boolean) => void;
}) {
  const [wallets, setWallets] = useState<WalletDescriptor[]>([]);
  const [name, setName] = useState(
    dotName ? `${dotName} wallet` : 'Dot wallet',
  );
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [chain, setChain] = useState('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
  const [operation, setOperation] = useState<
    'signMessage' | 'sign' | 'signTypedData' | 'signAndSend'
  >('signMessage');
  const [payload, setPayload] = useState('');
  const [credentialType, setCredentialType] = useState<'owner' | 'api_token'>(
    'owner',
  );
  const [credential, setCredential] = useState('');
  const [receipt, setReceipt] = useState('');
  const [review, setReview] = useState(false);
  const [keys, setKeys] = useState<WalletKeyDescriptor[]>([]);
  const [token, setToken] = useState('');
  const [importKind, setImportKind] = useState<'mnemonic' | 'private_key'>(
    'mnemonic',
  );
  const [importValue, setImportValue] = useState('');
  const [policy, setPolicy] = useState('');
  const load = async () => {
    const [list, access] = await Promise.all([
      api<{ wallets: WalletDescriptor[] }>('/wallets'),
      api<{ keys: WalletKeyDescriptor[] }>('/wallet-api-keys'),
    ]);
    setWallets(list.wallets);
    setKeys(access.keys);
  };
  useEffect(() => {
    void load().catch((e) =>
      setError(e instanceof Error ? e.message : 'Could not load wallets.'),
    );
  }, []);
  const selected = wallets.find((wallet) => wallet.id === walletId);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Wallet operation failed.');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  const create = (importing = false) =>
    run(async () => {
      const secret = importing ? importValue : undefined;
      setPassphrase('');
      setImportValue('');
      const wallet = await api<WalletDescriptor>(
        importing ? '/wallets/import' : '/wallets',
        'POST',
        {
          name,
          passphrase,
          ...(importing
            ? {
                kind: importKind,
                value: secret,
                ...(importKind === 'private_key' ? { chain: 'solana' } : {}),
              }
            : {}),
        },
      );
      await load();
      onChange(wallet.id);
    });
  return (
    <fieldset className="wallet-editor space-access-fields">
      <legend>Wallet</legend>
      <p className="muted">
        OWS keeps wallet secrets encrypted in this server’s vault. Save these
        settings to attach a wallet to this Dot.
      </p>
      <label className="field-label" htmlFor="dot-wallet">
        Select a wallet
      </label>
      <select
        id="dot-wallet"
        value={walletId ?? ''}
        disabled={busy}
        onChange={(e) => {
          onChange(e.target.value || null);
          setReceipt('');
          setReview(false);
        }}
      >
        <option value="">No wallet</option>
        {wallets.map((wallet) => (
          <option key={wallet.id} value={wallet.id}>
            {wallet.name}
          </option>
        ))}
      </select>
      {selected && (
        <details className="wallet-accounts" open>
          <summary>Receive addresses</summary>
          {selected.accounts.map((account) => (
            <div key={account.chainId}>
              <small>{account.chainId}</small>
              <code>{account.address}</code>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(account.address)
                    .catch(() =>
                      setError('Select and copy the address manually.'),
                    )
                }
              >
                Copy address
              </button>
            </div>
          ))}
        </details>
      )}
      <details>
        <summary>Create or import an encrypted wallet</summary>
        <label className="field-label" htmlFor="wallet-name">
          Wallet name
        </label>
        <input
          id="wallet-name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="field-label" htmlFor="wallet-passphrase">
          Encryption passphrase (at least 12 characters)
        </label>
        <input
          id="wallet-passphrase"
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <button
          type="button"
          disabled={busy || !name.trim() || passphrase.length < 12}
          onClick={() => void create()}
        >
          Create wallet
        </button>
        <details>
          <summary>Import an existing wallet</summary>
          <select
            aria-label="Wallet import type"
            value={importKind}
            onChange={(e) => setImportKind(e.target.value as typeof importKind)}
          >
            <option value="mnemonic">Recovery phrase</option>
            <option value="private_key">Solana private key (hex)</option>
          </select>
          <input
            type="password"
            autoComplete="off"
            aria-label="Wallet import secret"
            value={importValue}
            onChange={(e) => setImportValue(e.target.value)}
          />
          <button
            type="button"
            disabled={
              busy ||
              !name.trim() ||
              passphrase.length < 12 ||
              !importValue.trim()
            }
            onClick={() => void create(true)}
          >
            Import wallet
          </button>
        </details>
        <p className="muted">
          Keep your passphrase and back up the encrypted vault. Creating a
          wallet does not fund it.
        </p>
      </details>
      {selected && (
        <details>
          <summary>Review and sign</summary>
          <label className="field-label" htmlFor="wallet-chain">
            Chain
          </label>
          <input
            id="wallet-chain"
            value={chain}
            onChange={(e) => {
              setChain(e.target.value);
              setReview(false);
            }}
          />
          <label className="field-label" htmlFor="wallet-operation">
            Action
          </label>
          <select
            id="wallet-operation"
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value as typeof operation);
              setReview(false);
            }}
          >
            <option value="signMessage">Sign a message</option>
            <option value="sign">Sign a transaction only</option>
            <option value="signTypedData">Sign EIP-712 typed data</option>
            <option value="signAndSend">
              Sign and broadcast a transaction
            </option>
          </select>
          <label className="field-label" htmlFor="wallet-payload">
            {operation === 'signMessage'
              ? 'Message to sign'
              : operation === 'signTypedData'
                ? 'EIP-712 JSON'
                : 'Serialized transaction (hex)'}
          </label>
          <textarea
            id="wallet-payload"
            rows={3}
            value={payload}
            onChange={(e) => {
              setPayload(e.target.value);
              setReview(false);
            }}
          />
          <label className="field-label" htmlFor="wallet-credential-type">
            Credential
          </label>
          <select
            id="wallet-credential-type"
            value={credentialType}
            onChange={(e) => {
              setCredentialType(e.target.value as typeof credentialType);
              setCredential('');
            }}
          >
            <option value="owner">Owner passphrase</option>
            <option value="api_token">Scoped OWS API token</option>
          </select>
          <input
            aria-label="Signing credential"
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
          />
          <p className="muted">
            {credentialType === 'owner'
              ? 'The owner passphrase bypasses OWS policies. Use a scoped API token to enforce its policies.'
              : 'OWS evaluates the token’s wallet scope and policies before decrypting any wallet secret.'}
          </p>
          <label className="permission-row">
            <input
              type="checkbox"
              checked={review}
              onChange={(e) => setReview(e.target.checked)}
            />
            <span>
              I reviewed this wallet, chain, and payload
              {operation === 'signAndSend'
                ? ' and authorize broadcasting this transaction'
                : ' and authorize this signature'}
              .
            </span>
          </label>
          <button
            type="button"
            disabled={busy || !payload || !credential || !review}
            onClick={() =>
              void run(async () => {
                setReceipt('');
                setCredential('');
                setReview(false);
                const result = await api<Record<string, unknown>>(
                  `/wallets/${selected.id}/sign`,
                  'POST',
                  {
                    operation,
                    chainId: chain,
                    payload,
                    credential: { type: credentialType, value: credential },
                    confirm: true,
                  },
                );
                setReceipt(JSON.stringify(result, null, 2));
              })
            }
          >
            {operation === 'signAndSend' ? 'Sign and broadcast' : 'Sign only'}
          </button>
          {receipt && (
            <pre className="wallet-receipt" aria-label="Wallet signing result">
              {receipt}
            </pre>
          )}
        </details>
      )}
      {selected && (
        <details>
          <summary>Scoped agent access</summary>
          <p className="muted">
            Create a policy and a token limited to this wallet. The token is
            shown once; save it securely.
          </p>
          <label className="field-label" htmlFor="wallet-policy">
            OWS policy JSON
          </label>
          <textarea
            id="wallet-policy"
            rows={5}
            value={policy}
            onChange={(e) => setPolicy(e.target.value)}
            placeholder={
              '{"id":"dot-solana-only","name":"Solana only","version":1,"created_at":"2026-10-10T00:00:00Z","rules":[{"type":"allowed_chains","chain_ids":["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]}],"action":"deny"}'
            }
          />
          <input
            aria-label="Owner passphrase for scoped access"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !policy || passphrase.length < 12}
            onClick={() =>
              void run(async () => {
                const parsed = JSON.parse(policy) as { id: string };
                const password = passphrase;
                setPassphrase('');
                setToken('');
                await api('/wallet-policies', 'POST', { policy: parsed });
                const access = await api<{ token: string }>(
                  '/wallet-api-keys',
                  'POST',
                  {
                    name: `${dotName || 'Dot'} access`,
                    walletIds: [selected.id],
                    policyIds: [parsed.id],
                    passphrase: password,
                  },
                );
                setToken(access.token);
                await load();
              })
            }
          >
            Create policy and token
          </button>
          {token && (
            <div>
              <label className="field-label" htmlFor="created-wallet-token">
                New API token (shown once)
              </label>
              <input
                id="created-wallet-token"
                type="password"
                value={token}
                readOnly
              />
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(token)
                    .catch(() =>
                      setError('Select and copy the token manually.'),
                    )
                }
              >
                Copy token
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setToken('')}
              >
                Dismiss token
              </button>
            </div>
          )}
          {keys
            .filter((key) => key.wallet_ids?.includes(selected.id))
            .map((key) => (
              <div key={key.id}>
                <span>{key.name}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/wallet-api-keys/${key.id}`, 'DELETE', {
                        confirm: true,
                      });
                      setToken('');
                      await load();
                    })
                  }
                >
                  Revoke access
                </button>
              </div>
            ))}
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {busy && <p role="status">Working with your wallet…</p>}
    </fieldset>
  );
}
