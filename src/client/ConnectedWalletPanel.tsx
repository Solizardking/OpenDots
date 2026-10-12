import { useEffect, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useAuth } from './AuthGate';
import { api } from './api';

/** Wallet Standard connection stays in the browser; no private keys reach the app server. */
export function ConnectedWalletPanel({
  onOpenPump,
}: {
  onOpenPump?: () => void;
}) {
  const { publicKey, connected, disconnect, wallet } = useWallet();
  const { session } = useAuth();
  const [balance, setBalance] = useState<string>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const address = publicKey?.toBase58();
  useEffect(() => {
    let active = true;
    setBalance(undefined);
    setError('');
    if (!connected || !address) return;
    const controller = new AbortController();
    void api<{
      address: string;
      network: 'solana-mainnet';
      lamports: string;
      balanceSol: string;
    }>(
      `/markets/pump/wallet/${encodeURIComponent(address)}/balance`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (
          value.address !== address ||
          value.network !== 'solana-mainnet' ||
          !/^\d+$/.test(value.lamports) ||
          !/^\d+(?:\.\d{1,9})?$/.test(value.balanceSol)
        )
          throw Error('Invalid wallet balance.');
        if (active) setBalance(value.balanceSol);
      })
      .catch(() => {
        if (active)
          setError(
            'Balance unavailable. Refresh when the mainnet RPC is available.',
          );
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [address, connected, refresh]);
  return (
    <section
      className="connected-wallet-panel"
      aria-label="Connected Solana wallet"
    >
      <h2>Your Solana wallet</h2>
      <p>
        Connect a wallet to launch and trade on Pump.fun. Each transaction shows
        an exact review before your wallet asks for approval.
      </p>
      <WalletMultiButton />
      {session.user?.walletAddress && (
        <p className="connected-wallet-note">
          Account wallet: <code>{session.user.walletAddress}</code>
          {address &&
            address !== session.user.walletAddress &&
            'You are using a different wallet for transaction signing. Your account stays the same.'}
        </p>
      )}
      {connected && address && (
        <>
          <dl className="pump-review-values">
            <div>
              <dt>Wallet</dt>
              <dd>{wallet?.adapter.name ?? 'Connected wallet'}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd>
                <code>{address}</code>
              </dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Solana mainnet</dd>
            </div>
            <div>
              <dt>SOL balance</dt>
              <dd>
                {balance === undefined
                  ? error
                    ? 'Unavailable'
                    : 'Loading…'
                  : `${balance} SOL`}
              </dd>
            </div>
          </dl>
          {error && <p role="status">{error}</p>}
          <div className="connected-wallet-actions">
            <button
              type="button"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Refresh balance
            </button>
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(address)
                  .catch(() =>
                    setError(
                      'Could not copy the address. Select it above to copy.',
                    ),
                  )
              }
            >
              Copy address
            </button>
            <button
              type="button"
              onClick={() =>
                void disconnect().catch(() =>
                  setError('Could not disconnect this wallet.'),
                )
              }
            >
              Disconnect wallet
            </button>
            {onOpenPump && (
              <button type="button" className="primary" onClick={onOpenPump}>
                Open Pump.fun
              </button>
            )}
          </div>
        </>
      )}
      <p className="connected-wallet-note">
        Your wallet keeps its keys. Connecting does not authorize a transaction.
        Encrypted local Dot wallets are available separately in Dot settings.
      </p>
    </section>
  );
}
