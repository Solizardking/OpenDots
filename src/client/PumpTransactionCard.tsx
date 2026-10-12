import { useEffect, useRef, useState } from 'react';
import { pumpActionSchema, type PumpReview } from '../shared/pump-types';
import { api } from './api';
import { useWallet } from '@solana/wallet-adapter-react';
import { Transaction } from '@solana/web3.js';

export function PumpTransactionCard({
  args,
  threadId,
  status,
  respond,
  onOutcome,
}: {
  args: unknown;
  threadId: string;
  status?: string;
  respond?: (result: unknown) => Promise<void>;
  onOutcome?: (review: PumpReview) => void;
}) {
  const { publicKey, connected, signTransaction } = useWallet();
  const activeAddress = publicKey?.toBase58();
  const walletState = useRef({ activeAddress, connected });
  walletState.current = { activeAddress, connected };
  const parsed = pumpActionSchema.safeParse(args);
  const requestId = parsed.success ? parsed.data.requestId : '';
  const path = `/conversations/${encodeURIComponent(threadId)}/pump/requests/${encodeURIComponent(requestId)}`;
  const [review, setReview] = useState<PumpReview>();
  const [error, setError] = useState('');
  const [credential, setCredential] = useState('');
  const [credentialType, setCredentialType] = useState<'owner' | 'api_token'>(
    'owner',
  );
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!requestId) return;
    let active = true;
    setReview(undefined);
    setError('');
    setCredential('');
    setChecked(false);
    void api<PumpReview>(path)
      .then((value) => active && setReview(value))
      .catch((cause) => active && setError(cause.message));
    return () => {
      active = false;
    };
  }, [threadId, requestId, attempt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (review?.status !== 'submitted' && review?.status !== 'signing') return;
    let active = true;
    const timer = setInterval(() => {
      void api<PumpReview>(path)
        .then((value) => active && setReview(value))
        .catch(() => {});
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path, review?.status]);
  const expired =
    !!review && review.status === 'prepared' && now >= review.expiresAt;
  const seconds = review
    ? Math.max(0, Math.ceil((review.expiresAt - now) / 1000))
    : 0;
  const ready =
    review?.status === 'prepared' && !expired && status !== 'complete';
  const browserSigner = review?.signerMode === 'connected';
  const walletMatches =
    connected && activeAddress === review?.address && !!signTransaction;
  useEffect(() => {
    setChecked(false);
  }, [activeAddress, connected]);
  const reply = async (value: PumpReview) => {
    onOutcome?.(value);
    await respond?.({
      requestId: value.id,
      status: value.status,
      mint: value.mint,
      signature: value.signature,
      message:
        value.status === 'confirmed'
          ? 'Transaction confirmed on Solana mainnet.'
          : value.status === 'declined'
            ? 'Owner declined. Do not retry without a new request.'
            : 'Transaction is not confirmed. Check the recorded signature; do not submit another transaction automatically.',
    });
  };
  const decide = async (approve: boolean) => {
    if (!review || pending.current || (!ready && approve)) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const supplied = credential;
    setCredential('');
    try {
      if (approve && browserSigner) {
        if (!walletMatches || !signTransaction)
          throw Error(
            'Connect the wallet shown in this review before signing.',
          );
        const transaction = Transaction.from(
          Uint8Array.from(atob(review.transactionBase64), (c) =>
            c.charCodeAt(0),
          ),
        );
        const message = transaction.serializeMessage();
        const signed = await signTransaction(transaction);
        if (!mounted.current) return;
        if (
          !walletState.current.connected ||
          walletState.current.activeAddress !== review.address
        )
          throw Error(
            'The connected wallet changed. Prepare and review a fresh transaction.',
          );
        if (
          !signed.serializeMessage().equals(message) ||
          !signed.verifySignatures()
        )
          throw Error(
            'Your wallet must sign the exact reviewed transaction with every required signature.',
          );
        const signedTransactionBase64 = btoa(
          Array.from(signed.serialize(), (c) => String.fromCharCode(c)).join(
            '',
          ),
        );
        const value = await api<PumpReview>(`${path}/submit`, 'POST', {
          confirm: true,
          transactionHash: review.transactionHash,
          signedTransactionBase64,
        });
        setReview(value);
        await reply(value);
        return;
      }
      const value = await api<PumpReview>(
        `${path}/${approve ? 'approve' : 'decline'}`,
        'POST',
        approve
          ? {
              confirm: true,
              transactionHash: review.transactionHash,
              credential: { type: credentialType, value: supplied },
            }
          : {},
      );
      setReview(value);
      await reply(value);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The transaction could not be processed.',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="page-review-card pump-transaction-card"
      aria-label="Review Pump.fun transaction"
    >
      <header>
        <strong>Pump.fun · {review?.kind ?? 'Transaction'}</strong>
        <span>{expired ? 'Expired' : (review?.status ?? 'Loading')}</span>
      </header>
      {review ? (
        <div className="page-review-body">
          <h3>
            {review.kind === 'launch'
              ? `Launch ${review.name} (${review.symbol})`
              : `${review.kind === 'buy' ? 'Buy' : 'Sell'} token`}
          </h3>
          <dl className="pump-review-values">
            <div>
              <dt>Network / venue</dt>
              <dd>Solana mainnet · {review.venue}</dd>
            </div>
            <div>
              <dt>Wallet</dt>
              <dd>
                {review.walletName}
                <code>{review.address}</code>
              </dd>
            </div>
            <div>
              <dt>Token mint</dt>
              <dd>
                <code>{review.mint}</code>
              </dd>
            </div>
            <div>
              <dt>Quote asset</dt>
              <dd>
                {review.quoteLabel}
                <code>{review.quoteMint}</code>
              </dd>
            </div>
            <div>
              <dt>
                {review.kind === 'sell'
                  ? 'Tokens to sell'
                  : review.kind === 'launch'
                    ? 'Initial buy'
                    : 'Buy amount'}
              </dt>
              <dd>
                {review.inputAmount}{' '}
                {review.kind === 'sell' ? 'tokens' : review.quoteLabel}
              </dd>
            </div>
            {review.kind !== 'sell' && (
              <div>
                <dt>Maximum quote spend</dt>
                <dd>
                  {review.maximumQuote} {review.quoteLabel}
                </dd>
              </div>
            )}
            <div>
              <dt>Expected / minimum received</dt>
              <dd>
                {review.expectedOutput} / {review.minimumOutput}{' '}
                {review.kind === 'sell' ? review.quoteLabel : 'tokens'}
              </dd>
            </div>
            <div>
              <dt>Slippage</dt>
              <dd>{review.slippageBps / 100}%</dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>{review.networkFeeSol} SOL</dd>
            </div>
            <div>
              <dt>Trading fees</dt>
              <dd>
                Protocol and creator fees are included in the quote. No
                additional app fee.
              </dd>
            </div>
            <div>
              <dt>Estimated SOL debit, including rent</dt>
              <dd>
                {review.estimatedSolDebit} SOL · balance {review.balanceSol} SOL
              </dd>
            </div>
            {review.uri && (
              <div>
                <dt>Metadata URI</dt>
                <dd>{review.uri}</dd>
              </div>
            )}
            {review.kind === 'launch' && (
              <div>
                <dt>Creator fees</dt>
                <dd>
                  {review.holderReward
                    ? 'Paid to holders permanently'
                    : 'Paid to the assigned wallet'}
                </dd>
              </div>
            )}
          </dl>
          <details>
            <summary>Exact transaction and accounts</summary>
            <p>
              Simulation passed when prepared. Wallet signing uses these exact
              bytes.
            </p>
            <code>{review.transactionHash}</code>
            <pre>{JSON.stringify(review.instructions, null, 2)}</pre>
            <textarea
              aria-label="Prepared transaction base64"
              readOnly
              value={review.transactionBase64}
            />
          </details>
          {review.signature && (
            <p>
              <a
                href={`https://solscan.io/tx/${review.signature}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction on Solscan
              </a>
              <code>{review.signature}</code>
            </p>
          )}
          {review.error && <p role="status">{review.error}</p>}
          {ready && (
            <div className="pump-unlock">
              <p>
                Review expires in {seconds}s. Signing and submission happen only
                when you approve.
              </p>
              {browserSigner ? (
                <p>
                  {walletMatches
                    ? 'Your connected wallet will ask you to approve this exact transaction.'
                    : 'Connect the wallet shown above to sign this transaction.'}
                </p>
              ) : (
                <>
                  <label>
                    Wallet credential
                    <select
                      aria-label="Pump wallet credential type"
                      value={credentialType}
                      onChange={(event) => {
                        setCredentialType(
                          event.target.value as 'owner' | 'api_token',
                        );
                        setCredential('');
                      }}
                    >
                      <option value="owner">Wallet passphrase</option>
                      <option value="api_token">Scoped OWS token</option>
                    </select>
                  </label>
                  <input
                    aria-label="Unlock wallet for Pump transaction"
                    type="password"
                    autoComplete="off"
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                    placeholder="Sent only to the local wallet signer"
                  />
                </>
              )}
              <label className="pump-confirm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                I reviewed the wallet, token, amounts and mainnet transaction
              </label>
            </div>
          )}
          {expired && <p>Prepare a fresh quote and review it again.</p>}
        </div>
      ) : (
        <p className="page-review-body">
          Loading the server’s transaction record…
        </p>
      )}
      {error && (
        <p className="pump-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        {ready ? (
          <>
            <button
              type="button"
              className="review-primary"
              disabled={
                busy ||
                !checked ||
                (browserSigner ? !walletMatches : !credential)
              }
              onClick={() => void decide(true)}
            >
              {busy
                ? 'Signing…'
                : browserSigner
                  ? 'Review in wallet & submit'
                  : 'Approve & submit'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Decline
            </button>
          </>
        ) : respond &&
          review &&
          status !== 'complete' &&
          !['signing', 'prepared'].includes(review.status) ? (
          <button type="button" onClick={() => void reply(review)}>
            Continue conversation
          </button>
        ) : null}
        {!review && error && (
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </button>
        )}
      </footer>
    </section>
  );
}
