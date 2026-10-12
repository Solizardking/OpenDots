import { useEffect, useState } from 'react';
import { api } from './api';
import type {
  TradingConfig,
  TradingRecord,
  TradingView,
  TradingStrategyInput,
} from '../shared/trading-types';
import './trading-brain.css';
const defaults: TradingStrategyInput = {
  prompt:
    'Watch this Pump.fun token. Review sustained momentum with deep liquidity and wait when evidence is weak.',
  mint: '',
  maxSol: 0.01,
  minLiquidityUsd: 20000,
  confidence: 0.85,
};
export function TradingBrainPanel({
  dotId,
  paused,
  onReview,
}: {
  dotId: string;
  paused: boolean;
  onReview: (record: TradingRecord) => Promise<void>;
}) {
  const base = `/dots/${encodeURIComponent(dotId)}/trading`;
  const [config, setConfig] = useState<TradingConfig>(),
    [view, setView] = useState<TradingView>();
  const [draft, setDraft] = useState(defaults),
    [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [node, setNode] = useState<string>();
  useEffect(() => {
    let active = true,
      loaded = false;
    const refresh = async () => {
      try {
        const [c, v] = await Promise.all([
          api<TradingConfig>('/markets/brain/config'),
          api<TradingView>(base),
        ]);
        if (!active) return;
        setConfig(c);
        setView(v);
        if (!loaded && v.strategy) {
          setDraft(v.strategy);
          loaded = true;
        }
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load the trading brain.',
          );
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base]);
  const work = async (run: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run();
      setView(await api<TradingView>(base));
      setNotice(message);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The request could not be completed.',
      );
    } finally {
      setBusy(false);
    }
  };
  const decide = (ask = false) =>
    work(
      () =>
        api(base + '/decide', 'POST', {
          requestId: crypto.randomUUID(),
          ...(ask && command.trim() ? { command: command.trim() } : {}),
        }),
      'Decision saved with its evidence.',
    );
  const decision = view?.records.find((r) => r.type === 'decision');
  const latest = decision?.data;
  const eligible =
    latest?.gate === 'wallet_review' &&
    latest.strategyVersion === view?.strategy?.version &&
    Date.now() - Number(latest.evaluatedAt) < 45000;
  const monitoring =
    !!view?.strategy?.monitorUntil && view.strategy.monitorUntil > Date.now();
  const disabled = busy || paused;
  const graph = view?.graph,
    nodes = graph?.nodes.slice(0, 18) ?? [];
  const point = (id: string) => {
    const i = nodes.findIndex((n) => n.id === id);
    return i < 0
      ? null
      : { x: 40 + (i % 6) * 95, y: 32 + Math.floor(i / 6) * 58 };
  };
  return (
    <section className="trading-brain" aria-label="Trading intelligence">
      <p>
        Describe your strategy. Recall private decisions and compare real
        Pump.fun observations. Each trade requires wallet approval.
      </p>
      <p role="status">
        Supermemory:{' '}
        {config?.memoryConfigured ? 'configured' : 'not configured'} · TypeSafe:{' '}
        {config?.decisionsConfigured ? 'configured' : 'not configured'} ·{' '}
        {paused ? 'workspace paused' : 'read-only decisions'}
      </p>
      <div className="trading-feeds">
        {config?.feeds.sources.map((source) => (
          <article key={source.id}>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.id === 'pump' ? 'Pump stream' : 'CLAWD stream'}
            </a>
            <strong>{source.status}</strong>
            <small>
              Source health: {source.healthStatus ?? 'checking'}.{' '}
              {source.message}
            </small>
          </article>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void work(
            () => api(base + '/strategy', 'PUT', draft),
            'Strategy saved for this Dot.',
          );
        }}
      >
        <label>
          Natural-language strategy
          <textarea
            aria-label="Trading strategy"
            rows={3}
            maxLength={2000}
            value={draft.prompt}
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
            required
          />
        </label>
        <label>
          Token mint
          <input
            aria-label="Trading token mint"
            value={draft.mint}
            onChange={(e) => setDraft({ ...draft, mint: e.target.value })}
            maxLength={44}
            required
          />
        </label>
        <div className="trading-limits">
          {(
            [
              ['maxSol', 'Maximum trade · SOL', 0.001, 0.1, 0.001],
              [
                'minLiquidityUsd',
                'Minimum liquidity · USD',
                20000,
                100000000,
                1000,
              ],
              ['confidence', 'Minimum confidence', 0.8, 0.99, 0.01],
            ] as const
          ).map(([key, label, min, max, step]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                aria-label={label}
                min={min}
                max={max}
                step={step}
                value={draft[key]}
                onChange={(e) =>
                  setDraft({ ...draft, [key]: Number(e.target.value) })
                }
                required
              />
            </label>
          ))}
        </div>
        <button className="primary" disabled={disabled}>
          Save strategy
        </button>
      </form>
      <div className="trading-actions">
        <button
          disabled={disabled || !view?.strategy}
          onClick={() => void decide()}
        >
          Evaluate now
        </button>
        <button
          disabled={busy || (!monitoring && (paused || !view?.strategy))}
          onClick={() =>
            void work(
              () => api(base + '/monitor', 'POST', { enabled: !monitoring }),
              monitoring
                ? 'Monitoring paused.'
                : 'Monitoring started for one hour.',
            )
          }
        >
          {monitoring ? 'Pause monitoring' : 'Monitor for one hour'}
        </button>
      </div>
      <small>
        One evaluation per minute, up to 60 per Dot per day. Monitoring
        continues while the app server runs after closing this panel. Research
        and memory permissions must stay enabled.
      </small>
      <form
        className="trading-command"
        onSubmit={(event) => {
          event.preventDefault();
          void decide(true);
        }}
      >
        <label>
          Ask your brain
          <input
            aria-label="Ask your trading brain"
            placeholder="Recall my decisions, compare both feeds, or explain outcomes"
            maxLength={1000}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
        </label>
        <button
          disabled={disabled || !view?.strategy || command.trim().length < 3}
        >
          Ask
        </button>
      </form>
      {error && (
        <p className="pump-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {latest?.answers && (
        <article className="trading-decision">
          <header>
            <strong>{latest.answers.action.choice.toUpperCase()}</strong>
            <span>
              {latest.model} · {latest.gate}
            </span>
          </header>
          <p>
            Action confidence{' '}
            {(latest.answers.action.confidence * 100).toFixed(1)}% · risk{' '}
            {(latest.answers.risk.normalized * 100).toFixed(1)}% · strategy
            match {(latest.answers.strategy_match.noul * 100).toFixed(1)}%
          </p>
          <ul>
            {latest.reasons?.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {latest.market && (
            <p>
              Observed price ${latest.market.priceUsd} · pool liquidity $
              {latest.market.liquidityUsd?.toLocaleString()} ·{' '}
              {new Date(latest.market.observedAt).toLocaleTimeString()}
            </p>
          )}
          {latest.dispatch && (
            <details>
              <summary>Command: {latest.dispatch.function}</summary>
              <pre>{JSON.stringify(latest.dispatch.result, null, 2)}</pre>
            </details>
          )}
          {eligible && decision && (
            <button
              disabled={disabled}
              onClick={() =>
                void work(
                  () => onReview(decision),
                  'Review the exact transaction in your wallet.',
                )
              }
            >
              Review {latest.answers.action.choice} in Pump.fun
            </button>
          )}
          <details>
            <summary>Decision evidence</summary>
            <pre>{JSON.stringify(latest, null, 2)}</pre>
          </details>
        </article>
      )}
      <p>
        Adaptive confidence:{' '}
        {((view?.learning.threshold ?? 0.85) * 100).toFixed(1)}% ·{' '}
        {view?.learning.samples ?? 0} observed outcomes. {view?.learning.method}{' '}
        No model weights are retrained.
      </p>
      <details open>
        <summary>Private memory graph</summary>
        {nodes.length ? (
          <>
            <svg
              viewBox="0 0 600 190"
              role="img"
              aria-label="Strategy, token, decision and memory relationships"
            >
              {graph?.edges.map((edge, i) => {
                const a = point(edge.from),
                  b = point(edge.to);
                return a && b ? (
                  <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                ) : null;
              })}
              {nodes.map((n) => {
                const p = point(n.id)!;
                return (
                  <g
                    key={n.id}
                    tabIndex={0}
                    role="button"
                    aria-label={n.label}
                    onClick={() => setNode(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') setNode(n.id);
                    }}
                  >
                    <circle cx={p.x} cy={p.y} r={9} />
                    <text x={p.x - 28} y={p.y + 23}>
                      {n.type.slice(0, 12)}
                    </text>
                  </g>
                );
              })}
            </svg>
            {node && (
              <p>
                {graph?.nodes.find((n) => n.id === node)?.label}{' '}
                <code>{node}</code>
              </p>
            )}
            <details>
              <summary>All graph relationships</summary>
              <pre>{JSON.stringify(graph, null, 2)}</pre>
            </details>
          </>
        ) : (
          <p>Save a strategy to begin your journal.</p>
        )}
      </details>
      <details>
        <summary>
          Decision and outcome journal ({view?.records.length ?? 0})
        </summary>
        {view?.records.map((record) => (
          <details key={record.id}>
            <summary>
              {record.type} · {new Date(record.created_at).toLocaleTimeString()}{' '}
              · memory {record.sync_status}
            </summary>
            <pre>{JSON.stringify(record.data, null, 2)}</pre>
          </details>
        ))}
      </details>
      <details>
        <summary>Fresh observations from both feeds</summary>
        {config?.feeds.events.slice(0, 20).map((event) => (
          <article className="trading-event" key={event.id}>
            <strong>{event.name || event.symbol || 'Unnamed token'}</strong>
            <small>
              {event.source} · {event.type}
            </small>
            <code>{event.mint}</code>
            <button
              disabled={disabled}
              onClick={() => setDraft({ ...draft, mint: event.mint })}
            >
              Use this mint
            </button>
          </article>
        ))}
        {!config?.feeds.events.length && (
          <p>
            Waiting for fresh observations. Replay and stale messages are
            excluded.
          </p>
        )}
      </details>
    </section>
  );
}
