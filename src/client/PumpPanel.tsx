import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { X } from 'lucide-react';
import { api } from './api';
import { PumpTransactionCard } from './PumpTransactionCard';
import {
  pumpSlippageBps,
  type PumpReview,
  type PumpToken,
} from '../shared/pump-types';

export function PumpPanel({
  threadId,
  walletId,
  paused,
  onClose,
  initialMint,
  initialMode,
  brainDecision,
}: {
  threadId: string;
  walletId?: string | null;
  paused: boolean;
  onClose: () => void;
  initialMint?: string;
  initialMode?: 'launch' | 'buy' | 'sell';
  brainDecision?: { dotId: string; id: string };
}) {
  const base = `/conversations/${encodeURIComponent(threadId)}/pump`;
  const { publicKey, connected } = useWallet();
  const address = connected ? publicKey?.toBase58() : undefined;
  const [signer, setSigner] = useState<'connected' | 'local'>(() =>
    address || !walletId ? 'connected' : 'local',
  );
  const connectedSigner = signer === 'connected';
  const canPrepare = connectedSigner ? !!address : !!walletId;
  useEffect(() => {
    if (signer === 'local' && !walletId) setSigner('connected');
  }, [signer, walletId]);
  const [mode, setMode] = useState<'launch' | 'buy' | 'sell'>(
    initialMode ?? (initialMint ? 'buy' : 'launch'),
  );
  const [name, setName] = useState(''),
    [symbol, setSymbol] = useState(''),
    [uri, setUri] = useState('');
  const [mint, setMint] = useState(initialMint ?? ''),
    [amount, setAmount] = useState('0.01'),
    [initialBuySol, setInitialBuySol] = useState('0');
  const [slippage, setSlippage] = useState('1'),
    [holderReward, setHolderReward] = useState(false);
  const [token, setToken] = useState<PumpToken>(),
    [request, setRequest] = useState<PumpReview>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const requestRef = useRef(request);
  requestRef.current = request;
  const draft = JSON.stringify([
    threadId,
    signer,
    address,
    walletId,
    mode,
    name,
    symbol,
    uri,
    mint,
    amount,
    initialBuySol,
    slippage,
    holderReward,
  ]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const previousDraft = useRef(draft);
  useEffect(() => {
    if (previousDraft.current === draft) return;
    previousDraft.current = draft;
    const previous = requestRef.current;
    if (previous?.status === 'prepared')
      void api(`${base}/requests/${previous.id}/decline`, 'POST', {}).catch(
        () => {},
      );
    setRequest(undefined);
  }, [draft, base]);
  useEffect(() => {
    setToken(undefined);
  }, [signer, address, walletId]);
  useEffect(() => {
    let active = true;
    const snapshot = draftRef.current;
    void api<{ requests: PumpReview[] }>(`${base}/requests`)
      .then((value) => {
        if (active && draftRef.current === snapshot)
          setRequest(value.requests[0]);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [threadId]);
  const inspect = async () => {
    setError('');
    setBusy(true);
    try {
      const snapshot = draftRef.current;
      const inspected = await api<PumpToken>(
        `${base}/${connectedSigner ? 'connected/' : ''}token/${encodeURIComponent(mint.trim())}${connectedSigner ? `?address=${encodeURIComponent(address ?? '')}` : ''}`,
      );
      if (draftRef.current === snapshot) setToken(inspected);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not inspect this coin.',
      );
    } finally {
      setBusy(false);
    }
  };
  const prepare = async () => {
    setError('');
    setBusy(true);
    try {
      const snapshot = draftRef.current;
      const slippageBps = pumpSlippageBps(slippage);
      const input =
        mode === 'launch'
          ? { name, symbol, uri, initialBuySol, holderReward, slippageBps }
          : {
              mint: mint.trim(),
              side: mode,
              amount,
              quoteMint: token?.quoteMint,
              slippageBps,
            };
      const review = brainDecision
        ? await api<PumpReview>(
            `/dots/${encodeURIComponent(brainDecision.dotId)}/trading/review`,
            'POST',
            {
              decisionId: brainDecision.id,
              threadId,
              amount,
              slippageBps,
              ...(connectedSigner ? { address } : {}),
            },
          )
        : await api<PumpReview>(
            `${base}/${connectedSigner ? 'connected/' : ''}${mode === 'launch' ? 'launch' : 'trade'}`,
            'POST',
            connectedSigner ? { address, input } : input,
          );
      if (draftRef.current === snapshot) setRequest(review);
      else
        void api(`${base}/requests/${review.id}/decline`, 'POST', {}).catch(
          () => {},
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not prepare this transaction.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="pump-panel" aria-label="Pump.fun in chat">
      <header>
        <div>
          <strong>Pump.fun</strong>
          <p>Launch and trade on Solana with your wallet</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close Pump.fun"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      <div className="pump-wallet-source">
        <label>
          Signing wallet
          <select
            aria-label="Pump signing wallet"
            value={signer}
            onChange={(event) =>
              setSigner(event.target.value as 'connected' | 'local')
            }
          >
            <option value="connected">Connected browser wallet</option>
            {walletId && <option value="local">Encrypted Dot wallet</option>}
          </select>
        </label>
        {connectedSigner && <WalletMultiButton />}
        {connectedSigner && address && <code>{address}</code>}
      </div>
      {!canPrepare ? (
        <p>
          Connect your Solana wallet to prepare a transaction. You will review
          and approve each transaction in your wallet.
        </p>
      ) : (
        <>
          <div className="pump-modes" role="group" aria-label="Pump action">
            {(['launch', 'buy', 'sell'] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={value === mode}
                disabled={!!brainDecision}
                onClick={() => {
                  setMode(value);
                  setError('');
                }}
              >
                {value === 'launch'
                  ? 'Launch coin'
                  : value === 'buy'
                    ? 'Buy'
                    : 'Sell'}
              </button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void prepare();
            }}
          >
            {mode === 'launch' ? (
              <>
                <label>
                  Coin name
                  <input
                    aria-label="Pump coin name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={32}
                    required
                  />
                </label>
                <label>
                  Symbol
                  <input
                    aria-label="Pump coin symbol"
                    value={symbol}
                    onChange={(event) => setSymbol(event.target.value)}
                    maxLength={13}
                    required
                  />
                </label>
                <label>
                  Metadata JSON URI
                  <input
                    aria-label="Pump metadata URI"
                    value={uri}
                    onChange={(event) => setUri(event.target.value)}
                    placeholder="ipfs://… or https://…"
                    maxLength={200}
                    required
                  />
                </label>
                <small>
                  Use a public JSON document with your coin’s name, symbol,
                  description and image. Creation uses Token-2022, paired with
                  SOL.
                </small>
                <label>
                  Initial buy (SOL, optional)
                  <input
                    aria-label="Pump initial buy SOL"
                    inputMode="decimal"
                    value={initialBuySol}
                    onChange={(event) => setInitialBuySol(event.target.value)}
                    required
                  />
                </label>
                <label className="pump-confirm">
                  <input
                    type="checkbox"
                    checked={holderReward}
                    onChange={(event) => setHolderReward(event.target.checked)}
                  />
                  Pay creator fees to holders permanently
                </label>
              </>
            ) : (
              <>
                <label>
                  Token mint
                  <input
                    aria-label="Pump token mint"
                    value={mint}
                    readOnly={!!brainDecision}
                    onChange={(event) => {
                      setMint(event.target.value);
                      setToken(undefined);
                    }}
                    placeholder="Solana mint address"
                    required
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || !mint.trim()}
                  onClick={() => void inspect()}
                >
                  Inspect coin & balance
                </button>
                {token && (
                  <p className="pump-token-info">
                    {token.venue} · Quote: {token.quoteLabel}
                    <br />
                    Token balance: {token.balance} · SOL balance:{' '}
                    {token.solBalance}
                  </p>
                )}
                <label>
                  {mode === 'buy'
                    ? `Amount to spend (${token?.quoteLabel ?? 'inspect coin first'})`
                    : 'Tokens to sell'}
                  <input
                    aria-label="Pump trade amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    required
                  />
                </label>
              </>
            )}
            <label>
              Slippage (%)
              <input
                aria-label="Pump slippage percent"
                type="number"
                min="0"
                max="20"
                step="0.1"
                value={slippage}
                onChange={(event) => setSlippage(event.target.value)}
                required
              />
            </label>
            <button
              type="submit"
              className="primary"
              disabled={busy || paused || (mode !== 'launch' && !token)}
            >
              {busy ? 'Preparing…' : 'Prepare for review'}
            </button>
          </form>
        </>
      )}
      {error && (
        <p className="pump-error" role="alert">
          {error}
        </p>
      )}
      {request && (
        <PumpTransactionCard
          key={request.id}
          args={{ requestId: request.id }}
          threadId={threadId}
          onOutcome={setRequest}
        />
      )}
    </section>
  );
}
