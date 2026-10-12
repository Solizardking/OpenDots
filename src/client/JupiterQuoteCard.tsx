import { useEffect, useState } from 'react';
import type { JupiterQuote } from '../shared/jupiter-types';
import {
  computerToolResult,
  type ComputerToolRenderProps,
} from './ComputerToolCard';
import './jupiter.css';

export function isJupiterQuote(value: unknown): value is JupiterQuote {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<JupiterQuote>;
  return (
    data.source === 'Jupiter' &&
    data.network === 'solana-mainnet' &&
    (data.mode === 'order' || data.mode === 'build') &&
    typeof data.inputAmount === 'string' &&
    typeof data.expectedOutput === 'string' &&
    typeof data.minimumOutput === 'string' &&
    typeof data.inputMint === 'string' &&
    typeof data.outputMint === 'string' &&
    typeof data.router === 'string' &&
    typeof data.expiresAt === 'number' &&
    Number.isFinite(data.expiresAt) &&
    !!data.input &&
    Array.isArray(data.route)
  );
}

export function JupiterQuoteValues({ quote }: { quote: JupiterQuote }) {
  return (
    <dl className="jupiter-values">
      <div>
        <dt>Input</dt>
        <dd>
          {quote.inputAmount}
          <code>{quote.inputMint}</code>
        </dd>
      </div>
      <div>
        <dt>Expected output</dt>
        <dd>
          {quote.expectedOutput}
          <code>{quote.outputMint}</code>
        </dd>
      </div>
      <div>
        <dt>Minimum output</dt>
        <dd>{quote.minimumOutput}</dd>
      </div>
      <div>
        <dt>Winning router / route</dt>
        <dd>
          {quote.router} ·{' '}
          {quote.route.map((hop) => hop.label).join(' → ') || 'Direct'}
        </dd>
      </div>
      <div>
        <dt>Slippage</dt>
        <dd>
          {quote.input.slippageBps === 'rtse' ? 'Automatic (RTSE)' : 'Fixed'} ·{' '}
          {quote.slippageBps / 100}%
        </dd>
      </div>
      <div>
        <dt>Price impact</dt>
        <dd>
          {quote.priceImpactPercent === undefined
            ? 'Not provided'
            : `${quote.priceImpactPercent}%`}
        </dd>
      </div>
      <div>
        <dt>Total swap fee</dt>
        <dd>
          {quote.feeBps / 100}% ({quote.feeBps} bps)
          <code>{quote.feeMint ?? 'Fee mint not provided'}</code>
        </dd>
      </div>
      <div>
        <dt>Platform fee</dt>
        <dd>
          {quote.platformFeeBps / 100}% ({quote.platformFeeBps} bps)
          {quote.platformFeeAmount
            ? ` · ${quote.platformFeeAmount} base units`
            : ''}
        </dd>
      </div>
      <div>
        <dt>Signature fee / payer</dt>
        <dd>
          {quote.signatureFeeLamports} lamports
          <code>{quote.signatureFeePayer ?? 'Not provided'}</code>
        </dd>
      </div>
      <div>
        <dt>Priority fee / payer</dt>
        <dd>
          {quote.prioritizationFeeLamports} lamports
          <code>{quote.prioritizationFeePayer ?? 'Not provided'}</code>
        </dd>
      </div>
      <div>
        <dt>Account rent / payer</dt>
        <dd>
          {quote.rentFeeLamports} lamports
          <code>{quote.rentFeePayer ?? 'Not provided'}</code>
        </dd>
      </div>
      <div>
        <dt>Gas sponsorship</dt>
        <dd>
          {quote.gasless
            ? 'Provider sponsored where shown above'
            : 'See fee payers above'}
        </dd>
      </div>
      <div>
        <dt>Mode</dt>
        <dd>
          {quote.mode === 'order'
            ? 'Managed order · Jupiter execution'
            : 'Custom build · app RPC submission'}
          {quote.input.fast ? ' · Fast routes (beta)' : ''}
        </dd>
      </div>
      <div>
        <dt>Expires</dt>
        <dd>{new Date(quote.expiresAt).toLocaleString()}</dd>
      </div>
    </dl>
  );
}

export function JupiterQuoteView({ quote }: { quote: JupiterQuote }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <article className="jupiter-quote-card" aria-label="Jupiter quote">
      <header>
        <strong>Jupiter quote</strong>
        <span>
          {now >= quote.expiresAt ? 'Expired · refresh quote' : 'Quote preview'}
        </span>
      </header>
      <JupiterQuoteValues quote={quote} />
      {quote.preparationError && <p role="status">{quote.preparationError}</p>}
      <p>
        Quote only. Prepare a fresh transaction review to see the exact wallet,
        simulation and signing request.
      </p>
    </article>
  );
}

export function JupiterQuoteCard({ status, result }: ComputerToolRenderProps) {
  const data = computerToolResult(result);
  if (isJupiterQuote(data)) return <JupiterQuoteView quote={data} />;
  return (
    <article className="jupiter-quote-card" aria-label="Jupiter quote">
      <strong>Jupiter quote</strong>
      <p role="status">
        {typeof data.error === 'string'
          ? data.error
          : data.status === 'error' && typeof data.message === 'string'
            ? data.message
            : status === 'complete'
              ? 'No valid quote was returned.'
              : 'Fetching a fresh Jupiter quote…'}
      </p>
    </article>
  );
}
