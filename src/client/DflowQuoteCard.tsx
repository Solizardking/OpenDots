import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import {
  dflowQuoteSchema,
  percentageBasisPoints,
  displayUnits,
  type DflowQuote,
} from '../shared/dflow-types';
import {
  computerToolResult,
  type ComputerToolRenderProps,
} from './ComputerToolCard';

export function DflowQuoteView({ quote }: { quote: DflowQuote }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <article className="dflow-quote-card" aria-label="DFlow quote">
      <header>
        <strong>DFlow quote</strong>
        <span>
          {now >= quote.expiresAt ? 'Expired · refresh quote' : 'Quote preview'}
        </span>
      </header>
      <dl>
        <div>
          <dt>Input</dt>
          <dd>
            {displayUnits(quote.inAmount, quote.inputDecimals)}{' '}
            {quote.side === 'buy' ? 'SOL' : 'tokens'}
          </dd>
        </div>
        <div>
          <dt>Estimated output</dt>
          <dd>
            {displayUnits(quote.outAmount, quote.outputDecimals)}{' '}
            {quote.side === 'buy' ? 'tokens' : 'SOL'}
          </dd>
        </div>
        <div>
          <dt>Minimum output</dt>
          <dd>
            {displayUnits(quote.minimumOutput, quote.outputDecimals)}{' '}
            {quote.side === 'buy' ? 'tokens' : 'SOL'}
          </dd>
        </div>
        <div>
          <dt>Slippage</dt>
          <dd>{quote.slippageBps / 100}%</dd>
        </div>
        <div>
          <dt>Platform fee</dt>
          <dd>
            {quote.platformFeeSol} SOL ({quote.platformFeeBps / 100}%, included)
          </dd>
        </div>
      </dl>
      <code>{quote.mint}</code>
      <p>
        Quote only. A Pump.fun trade builds a separate transaction with its own
        price and fees. Network fees and account rent are shown in that review.
      </p>
    </article>
  );
}

export function DflowQuoteCard({ status, result }: ComputerToolRenderProps) {
  const data = computerToolResult(result);
  const parsed = dflowQuoteSchema.safeParse(data);
  if (parsed.success) return <DflowQuoteView quote={parsed.data} />;
  return (
    <article className="dflow-quote-card" aria-label="DFlow quote">
      <strong>DFlow quote</strong>
      <p role="status">
        {typeof data.error === 'string'
          ? data.error
          : status === 'complete'
            ? 'No valid quote was returned.'
            : 'Fetching a fresh quote…'}
      </p>
    </article>
  );
}

export function DflowQuoteForm({ initialMint = '' }: { initialMint?: string }) {
  const [mint, setMint] = useState(initialMint),
    [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.1'),
    [slippage, setSlippage] = useState('0.5');
  const [quote, setQuote] = useState<DflowQuote>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    pending.current?.abort();
    pending.current = undefined;
    setQuote(undefined);
    setError('');
    setBusy(false);
  }, [mint, side, amount, slippage]);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    setMint(initialMint);
  }, [initialMint]);
  return (
    <section className="dflow-quote-form" aria-label="DFlow spot quotes">
      <h3>Compare a DFlow quote</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          let slippageBps: number;
          try {
            slippageBps = percentageBasisPoints(slippage);
            if (slippageBps < 1 || slippageBps > 500)
              throw new Error('Use slippage from 0.01% to 5%.');
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : 'Invalid slippage.',
            );
            return;
          }
          setBusy(true);
          setError('');
          setQuote(undefined);
          const controller = new AbortController();
          pending.current?.abort();
          pending.current = controller;
          const input = {
            mint: mint.trim(),
            side,
            amount,
            slippageBps,
          };
          void api<DflowQuote>(
            '/markets/dflow/quote',
            'POST',
            input,
            AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
          )
            .then((value) => {
              if (!controller.signal.aborted)
                setQuote(dflowQuoteSchema.parse(value));
            })
            .catch((cause) => {
              if (!controller.signal.aborted)
                setError(
                  cause instanceof Error ? cause.message : 'Quote unavailable.',
                );
            })
            .finally(() => {
              if (pending.current === controller) {
                pending.current = undefined;
                setBusy(false);
              }
            });
        }}
      >
        <label>
          Token mint
          <input
            required
            aria-label="DFlow token mint"
            value={mint}
            disabled={busy}
            onChange={(event) => setMint(event.target.value)}
          />
        </label>
        <div className="solana-form-row">
          <label>
            Side
            <select
              aria-label="DFlow quote side"
              value={side}
              disabled={busy}
              onChange={(event) =>
                setSide(event.target.value as 'buy' | 'sell')
              }
            >
              <option value="buy">Buy with SOL</option>
              <option value="sell">Sell token</option>
            </select>
          </label>
          <label>
            Amount ({side === 'buy' ? 'SOL' : 'tokens'})
            <input
              required
              aria-label="DFlow quote amount"
              inputMode="decimal"
              value={amount}
              disabled={busy}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
        </div>
        <label>
          Slippage (%)
          <input
            required
            aria-label="DFlow slippage"
            type="number"
            min="0.01"
            max="5"
            step="0.01"
            value={slippage}
            disabled={busy}
            onChange={(event) => setSlippage(event.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? 'Loading quote…' : 'Get fresh quote'}
        </button>
      </form>
      {error && (
        <p role="alert" className="pump-error">
          {error}
        </p>
      )}
      {quote && <DflowQuoteView quote={quote} />}
    </section>
  );
}
