import { useEffect, useRef, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  jupiterActionSchema,
  type JupiterReview,
} from '../shared/jupiter-types';
import { api } from './api';
import {
  bytesBase64,
  decodeJupiterReview,
  validateJupiterSignature,
} from './jupiter-signing';
import { JupiterQuoteValues } from './JupiterQuoteCard';
import './jupiter.css';

export function JupiterTransactionCard({
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
  onOutcome?: (review: JupiterReview) => void;
}) {
  const { publicKey, connected, signTransaction, wallet } = useWallet();
  const address = publicKey?.toBase58();
  const supportsV0 = !!wallet?.adapter.supportedTransactionVersions?.has(0);
  const parsed = jupiterActionSchema.safeParse(args);
  const requestId = parsed.success ? parsed.data.requestId : '';
  const path = `/conversations/${encodeURIComponent(threadId)}/jupiter/requests/${encodeURIComponent(requestId)}`;
  const [review, setReview] = useState<JupiterReview>();
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [attempt, setAttempt] = useState(0);
  const current = useRef({
    address,
    connected,
    supportsV0,
    path,
    review,
    checked,
    status,
  });
  current.current = {
    address,
    connected,
    supportsV0,
    path,
    review,
    checked,
    status,
  };
  const mounted = useRef(false),
    pending = useRef(false),
    generation = useRef(0);
  const previousWallet = useRef({ address, connected });
  const trackedReview = useRef<
    { path: string; value: JupiterReview } | undefined
  >(undefined);
  const outcome = useRef(onOutcome);
  outcome.current = onOutcome;
  const updateReview = (value: JupiterReview | undefined) => {
    trackedReview.current = value ? { path, value } : undefined;
    setReview(value);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const ownedPath = path;
    generation.current++;
    const loadGeneration = generation.current;
    updateReview(undefined);
    setError('');
    setChecked(false);
    if (requestId)
      void api<JupiterReview>(path, 'GET', undefined, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          if (generation.current !== loadGeneration) {
            if (value.status === 'prepared')
              void api(`${ownedPath}/decline`, 'POST', {}).catch(() => {});
            return;
          }
          updateReview(value);
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setError(
              cause instanceof Error ? cause.message : 'Review unavailable.',
            );
        });
    return () => {
      controller.abort();
      generation.current++;
      const tracked = trackedReview.current;
      // A StrictMode remount or a status refresh keeps ownership of this request.
      // A real close/context change declines even if its GET was still pending.
      queueMicrotask(() => {
        if (mounted.current && current.current.path === ownedPath) return;
        if (
          requestId &&
          (!tracked ||
            tracked.path !== ownedPath ||
            tracked.value.status === 'prepared')
        )
          void api(`${ownedPath}/decline`, 'POST', {}).catch(() => {});
      });
    };
  }, [path, requestId, attempt]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (review?.status !== 'submitted') return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void api<JupiterReview>(path, 'GET', undefined, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) updateReview(value);
        })
        .catch(() => {});
    }, 2500);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [path, review?.status]);
  useEffect(() => {
    const previous = previousWallet.current;
    previousWallet.current = { address, connected };
    setChecked(false);
    if (previous.address === address && previous.connected === connected)
      return;
    generation.current++;
    const value = current.current.review;
    if (value?.status === 'prepared') {
      updateReview({ ...value, status: 'declined' });
      setError(
        'The connected wallet changed. Prepare a fresh transaction review.',
      );
      void api<JupiterReview>(`${path}/decline`, 'POST', {})
        .then((result) => {
          if (mounted.current && current.current.path === path) {
            updateReview(result);
            outcome.current?.(result);
          }
        })
        .catch(() => {});
    }
  }, [address, connected, path]);

  const expired = !!review && now >= review.expiresAt;
  const ready =
    review?.status === 'prepared' && !expired && status !== 'complete';
  const matches =
    connected && address === review?.address && !!signTransaction && supportsV0;
  const reply = async (value: JupiterReview) => {
    outcome.current?.(value);
    await respond?.({
      requestId: value.id,
      status: value.status,
      signature: value.signature,
      message:
        value.status === 'confirmed'
          ? 'Jupiter swap confirmed on Solana mainnet.'
          : value.status === 'declined'
            ? 'The transaction was declined. Prepare a new review only if requested.'
            : 'The transaction is not confirmed. Check its recorded status and signature; do not retry submission automatically.',
    });
  };
  const decide = async (approve: boolean) => {
    if (
      !review ||
      pending.current ||
      (approve && (!ready || !checked || !matches))
    )
      return;
    pending.current = true;
    setBusy(true);
    setError('');
    const snapshot = generation.current;
    try {
      if (!approve) {
        const value = await api<JupiterReview>(`${path}/decline`, 'POST', {});
        if (mounted.current && current.current.path === path) {
          updateReview(value);
          await reply(value);
        }
        return;
      }
      if (!signTransaction)
        throw Error('Connect a wallet with Solana v0 signing support.');
      const original = await decodeJupiterReview(review);
      if (
        !mounted.current ||
        generation.current !== snapshot ||
        current.current.status === 'complete' ||
        Date.now() >= review.expiresAt
      )
        throw Error(
          'The review changed or expired. Prepare a fresh transaction.',
        );
      // Wallet adapters may mutate their input. Keep the reviewed bytes untouched.
      const signed = await signTransaction(
        VersionedTransaction.deserialize(original.serialize()),
      );
      if (!mounted.current) return;
      if (
        generation.current !== snapshot ||
        current.current.path !== path ||
        !current.current.connected ||
        current.current.address !== review.address ||
        !current.current.checked ||
        !current.current.supportsV0 ||
        current.current.status === 'complete' ||
        Date.now() >= review.expiresAt
      )
        throw Error(
          'The wallet or review changed, or the review expired. No transaction was submitted.',
        );
      validateJupiterSignature(original, signed, review);
      // A submission may reach Jupiter even if its response is lost. Never retry it automatically.
      updateReview({ ...review, status: 'submitted' });
      const value = await api<JupiterReview>(`${path}/submit`, 'POST', {
        confirm: true,
        transactionHash: review.transactionHash,
        signedTransactionBase64: bytesBase64(signed.serialize()),
      });
      if (mounted.current && current.current.path === path) {
        updateReview(value);
        await reply(value);
      }
    } catch (cause) {
      if (mounted.current && current.current.path === path)
        setError(
          cause instanceof Error
            ? cause.message
            : 'The transaction could not be processed.',
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className="jupiter-transaction-card"
      aria-label="Review Jupiter transaction"
    >
      <header>
        <strong>Jupiter swap · immutable review</strong>
        <span>
          {review?.status === 'prepared' && expired
            ? 'Expired'
            : (review?.status ?? 'Loading')}
        </span>
      </header>
      {review ? (
        <>
          <JupiterQuoteValues quote={review} />
          <dl className="jupiter-values">
            <div>
              <dt>Network / version</dt>
              <dd>Solana mainnet · v0</dd>
            </div>
            <div>
              <dt>Connected signing wallet</dt>
              <dd>
                <code>{review.address}</code>
              </dd>
            </div>
            <div>
              <dt>Transaction fee payer</dt>
              <dd>
                <code>{review.feePayer}</code>
              </dd>
            </div>
            <div>
              <dt>Wallet SOL / input balance</dt>
              <dd>
                {review.balanceSol} SOL / {review.inputBalance} input tokens
              </dd>
            </div>
            <div>
              <dt>Network fee / estimated SOL debit</dt>
              <dd>
                {review.networkFeeSol} SOL / {review.estimatedSolDebit} SOL
              </dd>
            </div>
            <div>
              <dt>Simulation</dt>
              <dd>
                {review.simulation.status}
                {review.simulation.unitsConsumed === undefined
                  ? ''
                  : ` · ${review.simulation.unitsConsumed} compute units`}
              </dd>
            </div>
            <div>
              <dt>Compute limit / unit price</dt>
              <dd>
                {review.computeUnitLimit ?? 'Provider selected'} /{' '}
                {review.computeUnitPriceMicroLamports ?? 'Provider selected'}{' '}
                micro-lamports
              </dd>
            </div>
            <div>
              <dt>Unit price ceiling</dt>
              <dd>
                {review.computeUnitPriceCeilingMicroLamports} micro-lamports
              </dd>
            </div>
            <div>
              <dt>Deferred provider signers</dt>
              <dd>
                {review.deferredSigners.length
                  ? review.deferredSigners.map((key) => (
                      <code key={key}>{key}</code>
                    ))
                  : 'None'}
              </dd>
            </div>
            <div>
              <dt>Exact transaction hash</dt>
              <dd>
                <code>{review.transactionHash}</code>
              </dd>
            </div>
          </dl>
          <details>
            <summary>Inspect exact transaction and instructions</summary>
            <textarea
              aria-label="Jupiter unsigned transaction"
              readOnly
              value={review.transactionBase64}
            />
            <pre>{JSON.stringify(review.instructions, null, 2)}</pre>
          </details>
          {review.error && (
            <p role="alert">
              {review.error}
              {review.providerCode === undefined
                ? ''
                : ` (provider code ${review.providerCode})`}
            </p>
          )}
          {review.signature && (
            <p>
              <a
                href={`https://solscan.io/tx/${encodeURIComponent(review.signature)}`}
                target="_blank"
                rel="noreferrer"
              >
                View transaction on Solscan
              </a>
            </p>
          )}
          {review.status === 'submitted' && (
            <p role="status">
              Submitted; confirmation is pending. Do not submit this swap again.
            </p>
          )}
          {ready && (
            <div className="jupiter-review-controls">
              {!matches && (
                <p role="status">
                  Connect the reviewed wallet with Solana v0 transaction signing
                  support.
                </p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy || !matches}
                  onChange={(event) => setChecked(event.target.checked)}
                />
                I reviewed the wallet, tokens, amounts, fees and mainnet
                transaction
              </label>
              <div className="jupiter-review-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!checked || !matches || busy}
                  onClick={() => void decide(true)}
                >
                  {busy ? 'Waiting for wallet…' : 'Sign & submit swap'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide(false)}
                >
                  Decline transaction
                </button>
              </div>
            </div>
          )}
          {review.status === 'prepared' && expired && (
            <p role="status">
              This review expired. Prepare a new swap before signing.
            </p>
          )}
        </>
      ) : (
        <p role="status">
          {requestId
            ? 'Loading exact transaction review…'
            : 'A valid transaction request is required.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {error && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          Refresh recorded status
        </button>
      )}
    </section>
  );
}
