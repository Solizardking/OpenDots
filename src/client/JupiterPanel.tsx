import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import {
  jupiterSwapSchema,
  type JupiterAvailability,
  type JupiterQuote,
  type JupiterReview,
  type JupiterSwap,
} from '../shared/jupiter-types';
import { api } from './api';
import { isJupiterQuote, JupiterQuoteView } from './JupiterQuoteCard';
import { JupiterTransactionCard } from './JupiterTransactionCard';
import './jupiter.css';

export function JupiterPanel({
  threadId,
  onPrepare,
  paused,
  onClose,
  initialInputMint = 'So11111111111111111111111111111111111111112',
  initialOutputMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}: {
  threadId?: string;
  onPrepare?: () => Promise<string>;
  paused: boolean;
  onClose?: () => void;
  initialInputMint?: string;
  initialOutputMint?: string;
}) {
  const { publicKey, connected, signTransaction, wallet } = useWallet();
  const address = connected ? publicKey?.toBase58() : undefined;
  const supportsV0 = !!wallet?.adapter.supportedTransactionVersions?.has(0);
  const [inputMint, setInputMint] = useState(initialInputMint),
    [outputMint, setOutputMint] = useState(initialOutputMint);
  const [amount, setAmount] = useState('0.1'),
    [mode, setMode] = useState<'order' | 'build'>('order');
  const [policy, setPolicy] = useState<'rtse' | 'fixed'>('rtse'),
    [slippage, setSlippage] = useState('0.5');
  const [fast, setFast] = useState(false),
    [maxAccounts, setMaxAccounts] = useState('64');
  const [availability, setAvailability] = useState<JupiterAvailability>();
  const [quote, setQuote] = useState<JupiterQuote>(),
    [prepared, setPrepared] = useState<JupiterReview>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState<'quote' | 'prepare' | undefined>();
  const fingerprint = JSON.stringify({
    inputMint,
    outputMint,
    amount,
    mode,
    policy,
    slippage,
    fast,
    maxAccounts,
    address,
    paused,
  });
  const current = useRef({ fingerprint, threadId, address });
  current.current = { fingerprint, threadId, address };
  const pending = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const previousThread = useRef(threadId);
  const ownContext = useRef({
    pending: false,
    observed: undefined as string | undefined,
    accepted: undefined as string | undefined,
  });

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<JupiterAvailability>(
      '/markets/jupiter/status',
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setAvailability(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Jupiter availability could not be checked.',
          );
      });
    return () => {
      mounted.current = false;
      controller.abort();
      pending.current?.abort();
    };
  }, []);
  useEffect(() => {
    pending.current?.abort();
    pending.current = undefined;
    setQuote(undefined);
    setPrepared(undefined);
    setError('');
    setBusy(undefined);
  }, [fingerprint]);
  useEffect(() => {
    setInputMint(initialInputMint);
    setOutputMint(initialOutputMint);
  }, [initialInputMint, initialOutputMint]);
  useEffect(() => {
    const previous = previousThread.current;
    previousThread.current = threadId;
    if (previous === threadId) return;
    // Creating the first independent context updates App before its callback resolves.
    if (
      !previous &&
      threadId &&
      (ownContext.current.pending || ownContext.current.accepted === threadId)
    ) {
      ownContext.current.observed = threadId;
      return;
    }
    pending.current?.abort();
    pending.current = undefined;
    setQuote(undefined);
    setPrepared(undefined);
    setError('');
    setBusy(undefined);
  }, [threadId]);

  const getInput = (): JupiterSwap => {
    let slippageBps: number | 'rtse' = 'rtse';
    if (policy === 'fixed') {
      if (!/^\d+(?:\.\d{1,2})?$/.test(slippage.trim()))
        throw Error(
          'Use fixed slippage from 0% to 5%, with at most two decimal places.',
        );
      const [whole, fraction = ''] = slippage.trim().split('.');
      slippageBps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    }
    const parsed = jupiterSwapSchema.safeParse({
      inputMint,
      outputMint,
      amount,
      mode,
      slippageBps,
      fast: mode === 'build' && fast,
      maxAccounts: mode === 'build' ? Number(maxAccounts) : 64,
    });
    if (!parsed.success)
      throw Error(
        'Check the token mints, positive amount, slippage (0–5%) and account limit (1–64).',
      );
    if (!/[1-9]/.test(parsed.data.amount))
      throw Error('Enter a positive swap amount.');
    if (parsed.data.inputMint === parsed.data.outputMint)
      throw Error('Choose two different token mints.');
    if (mode === 'build' && !address)
      throw Error('Connect a wallet to request custom build quotes.');
    return parsed.data;
  };
  const run = async (prepare: boolean) => {
    if (paused || availability?.configured === false) return;
    let input: JupiterSwap;
    try {
      input = getInput();
      if (prepare && (!address || !signTransaction || !supportsV0))
        throw Error(
          'Connect a wallet with Solana v0 transaction signing support to prepare a swap.',
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid swap.');
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const snapshot = fingerprint;
    setBusy(prepare ? 'prepare' : 'quote');
    setError('');
    setPrepared(undefined);
    setQuote(undefined);
    const stillCurrent = () =>
      mounted.current &&
      !controller.signal.aborted &&
      pending.current === controller &&
      current.current.fingerprint === snapshot;
    try {
      if (!prepare) {
        const value = await api<JupiterQuote>(
          '/markets/jupiter/quote',
          'POST',
          { input, ...(address ? { address } : {}) },
          AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
        );
        if (stillCurrent()) {
          if (!isJupiterQuote(value))
            throw Error('Jupiter returned an unreadable quote.');
          setQuote(value);
        }
        return;
      }
      let context = current.current.threadId;
      if (!context) {
        if (!onPrepare)
          throw Error('Create a conversation context before preparing a swap.');
        ownContext.current = {
          pending: true,
          observed: undefined,
          accepted: undefined,
        };
        try {
          context = await onPrepare();
          if (
            !context ||
            (ownContext.current.observed &&
              ownContext.current.observed !== context)
          )
            throw Error(
              'The active context changed. Prepare a new swap review.',
            );
          ownContext.current.accepted = context;
        } finally {
          ownContext.current.pending = false;
        }
      }
      if (!stillCurrent()) return;
      const value = await api<JupiterReview>(
        `/conversations/${encodeURIComponent(context)}/jupiter/prepare`,
        'POST',
        { input, address },
        AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
      );
      if (
        !stillCurrent() ||
        (current.current.threadId && current.current.threadId !== context)
      ) {
        void api(
          `/conversations/${encodeURIComponent(context)}/jupiter/requests/${encodeURIComponent(value.id)}/decline`,
          'POST',
          {},
        ).catch(() => {});
        return;
      }
      setPrepared(value);
    } catch (cause) {
      if (stillCurrent())
        setError(
          cause instanceof Error
            ? cause.message
            : 'Jupiter request unavailable.',
        );
    } finally {
      if (pending.current === controller) {
        pending.current = undefined;
        if (mounted.current) setBusy(undefined);
      }
    }
  };
  return (
    <section className="jupiter-panel" aria-label="Jupiter swaps">
      <header>
        <h2>Jupiter swaps</h2>
        {onClose && (
          <button
            type="button"
            aria-label="Close Jupiter panel"
            onClick={onClose}
          >
            Close
          </button>
        )}
      </header>
      <p>
        Compare a live Solana quote, then review an exact transaction for your
        connected wallet. Your account remains signed in when you change trading
        wallets.
      </p>
      <WalletMultiButton />
      {availability && <p role="status">{availability.message}</p>}
      {paused && (
        <p role="status">
          Trading is paused. Resume the workspace to request a swap.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(false);
        }}
      >
        <label>
          Input token mint
          <input
            required
            aria-label="Jupiter input mint"
            value={inputMint}
            onChange={(event) => setInputMint(event.target.value)}
          />
        </label>
        <label>
          Output token mint
          <input
            required
            aria-label="Jupiter output mint"
            value={outputMint}
            onChange={(event) => setOutputMint(event.target.value)}
          />
        </label>
        <label>
          Input amount
          <input
            required
            aria-label="Jupiter amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label>
          Execution mode
          <select
            aria-label="Jupiter mode"
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as 'order' | 'build')
            }
          >
            <option value="order">Managed order (recommended)</option>
            <option value="build">Custom build</option>
          </select>
        </label>
        <label>
          Slippage policy
          <select
            aria-label="Jupiter slippage policy"
            value={policy}
            onChange={(event) =>
              setPolicy(event.target.value as 'rtse' | 'fixed')
            }
          >
            <option value="rtse">Automatic (RTSE)</option>
            <option value="fixed">Fixed slippage</option>
          </select>
        </label>
        {policy === 'fixed' && (
          <label>
            Slippage (%)
            <input
              aria-label="Jupiter slippage"
              type="number"
              min="0"
              max="5"
              step="0.01"
              value={slippage}
              onChange={(event) => setSlippage(event.target.value)}
            />
          </label>
        )}
        {mode === 'build' && (
          <>
            <label>
              Maximum swap accounts
              <input
                aria-label="Jupiter max accounts"
                type="number"
                min="1"
                max="64"
                step="1"
                value={maxAccounts}
                onChange={(event) => setMaxAccounts(event.target.value)}
              />
            </label>
            <small>
              Reducing the account limit can worsen pricing or leave no
              available route.
            </small>
            <label className="jupiter-check">
              <input
                type="checkbox"
                checked={fast}
                onChange={(event) => setFast(event.target.checked)}
              />
              Fast routes (beta)
            </label>
            <p className="jupiter-notice">
              Fast mode reduces quote latency and can choose a less favorable
              route. Its default priority price uses the 90th percentile
              estimate; the final review shows the fee cap. Custom builds are
              simulated and submitted through the app’s Solana RPC.
            </p>
          </>
        )}
        <div className="jupiter-panel-actions">
          <button
            className="primary"
            type="submit"
            disabled={!!busy || paused || availability?.configured === false}
          >
            {busy === 'quote' ? 'Loading Jupiter quote…' : 'Get Jupiter quote'}
          </button>
          <button
            type="button"
            disabled={
              !!busy ||
              paused ||
              availability?.configured === false ||
              !address ||
              !supportsV0 ||
              !signTransaction ||
              (!threadId && !onPrepare)
            }
            onClick={() => void run(true)}
          >
            {busy === 'prepare'
              ? 'Preparing swap review…'
              : 'Prepare swap review'}
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {quote && <JupiterQuoteView quote={quote} />}
      {prepared && (
        <JupiterTransactionCard
          key={prepared.id}
          args={{ requestId: prepared.id }}
          threadId={prepared.threadId}
          onOutcome={(value) => setPrepared(value)}
        />
      )}
    </section>
  );
}
