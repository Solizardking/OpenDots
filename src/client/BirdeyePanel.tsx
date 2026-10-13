import { useEffect, useRef, useState } from 'react';
import { Bird, ExternalLink, RefreshCw, X } from 'lucide-react';
import {
  birdeyeAddressSchema,
  birdeyeIntervals,
  birdeyeQuerySchema,
  birdeyeWorkflows,
  type BirdeyeQuery,
  type BirdeyeResult,
  type BirdeyeStatus,
  type BirdeyeWorkflow,
} from '../shared/birdeye-types';
import { api, authHeaders } from './api';
import {
  BirdeyeResultView,
  BirdeyeTable,
  birdeyeChartPoints,
  birdeyeLabels,
  birdeyeObject,
  birdeyeRows,
} from './BirdeyeToolCard';
import './birdeye.css';

const publicTokenWorkflows = new Set<BirdeyeWorkflow>([
  'investigation',
  'rug-check',
  'wash-trading',
  'cross-dex',
  'liquidity',
  'chart',
  'history',
  'price-stats',
  'whales',
]);
const noAddress = new Set<BirdeyeWorkflow>([
  'search',
  'trending',
  'screener',
  'new-listings',
  'watchlist',
  'credits',
]);
const walletWorkflows = new Set<BirdeyeWorkflow>([
  'portfolio',
  'wallet-history',
]);

/** Only a public token identifier and requested workflow leave the workspace. */
export function birdeyeChatGPTUrl(query: BirdeyeQuery): string | null {
  if (
    !publicTokenWorkflows.has(query.workflow) ||
    !query.address ||
    !birdeyeAddressSchema.safeParse(query.address).success
  )
    return null;
  return `https://chatgpt.com/?q=${encodeURIComponent(`Research the public Solana token ${query.address}: ${birdeyeLabels[query.workflow]}. Use current sources and distinguish observed facts from missing data.`)}`;
}
function requestPrompt(query: BirdeyeQuery, result?: BirdeyeResult) {
  const request = `Research with Birdeye: ${birdeyeLabels[query.workflow]}. Request: ${JSON.stringify(query)}.`;
  const excerpt = result
    ? JSON.stringify({
        warnings: result.warnings,
        partial: result.partial,
        data: result.data,
      })
    : '';
  return result
    ? `${request}\nObserved ${new Date(result.observedAt).toISOString()} using Birdeye. Evaluate the evidence and its limits; do not treat this as authorization to trade.\n${excerpt.slice(0, 2900)}${excerpt.length > 2900 ? '\n[Result excerpt ends here. Request the full report for omitted records.]' : ''}`
    : request;
}
function mergeHistory(previous: BirdeyeResult, next: BirdeyeResult) {
  const rows = [
    ...birdeyeRows(previous.data.items),
    ...birdeyeRows(next.data.items),
  ];
  const byTime = new Map<number, Record<string, unknown>>();
  for (const row of rows) {
    const time = Number(
      row.unix_time ?? row.unixTime ?? row.timestamp ?? row.time,
    );
    if (Number.isFinite(time)) byTime.set(time, row);
  }
  return {
    ...next,
    data: {
      ...next.data,
      items: [...byTime]
        .sort(([a], [b]) => a - b)
        .slice(-1000)
        .map(([, value]) => value),
    },
    warnings: [...new Set([...previous.warnings, ...next.warnings])],
  };
}

type Alert = {
  id: string;
  address: string;
  label?: string;
  kind: 'absolute' | 'percent';
  direction: 'above' | 'below';
  threshold: number;
  triggered: boolean;
  enabled?: boolean;
  lastPrice: number | null;
  lastError: string | null;
};
type Monitor = {
  alerts: Alert[];
  events?: unknown[];
  state?: string;
  error?: string;
  checkedAt?: string | number;
};
type LiveEvent = {
  id?: string;
  kind?: string;
  state?: string;
  observedAt?: string | number;
  data?: unknown;
  error?: string;
};

function BirdeyeWatch({
  threadId,
  address,
  wallet,
  paused,
  onCandle,
}: {
  threadId: string;
  address: string;
  wallet?: string;
  paused: boolean;
  onCandle: (event: LiveEvent) => void;
}) {
  const [monitor, setMonitor] = useState<Monitor>();
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'absolute' | 'percent'>('absolute');
  const [direction, setDirection] = useState<'above' | 'below'>('above');
  const [threshold, setThreshold] = useState('');
  const [timeframe, setTimeframe] = useState('24h');
  const [baseline, setBaseline] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [streamState, setStreamState] = useState('Stopped');
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [discovery, setDiscovery] = useState(false);
  const stream = useRef<AbortController | null>(null);
  const validAddress = birdeyeAddressSchema.safeParse(address).success;
  const liveCallback = useRef(onCandle);
  liveCallback.current = onCandle;
  useEffect(() => {
    const controller = new AbortController();
    void api<Monitor>(
      `/birdeye/alerts?threadId=${encodeURIComponent(threadId)}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setMonitor(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : 'Alerts could not load.',
          );
      });
    return () => controller.abort();
  }, [threadId]);
  useEffect(() => {
    return () => stream.current?.abort();
  }, []);
  useEffect(() => {
    stream.current?.abort();
    setLive(false);
    setStreamState('Stopped');
    setEvents([]);
  }, [address, wallet, discovery, paused]);
  async function alerts(path: string, method = 'POST', body?: unknown) {
    if (paused) return;
    setBusy(true);
    setError('');
    try {
      const response = await api<Monitor>(path, method, body);
      setMonitor(
        Array.isArray(response.alerts)
          ? response
          : await api<Monitor>(
              `/birdeye/alerts?threadId=${encodeURIComponent(threadId)}`,
            ),
      );
      if (response.error) setError(response.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Alert update failed.');
    } finally {
      setBusy(false);
    }
  }
  async function startStream() {
    if (paused || (!validAddress && !wallet && !discovery)) return;
    stream.current?.abort();
    const controller = new AbortController();
    stream.current = controller;
    setLive(true);
    setStreamState('Connecting');
    setError('');
    try {
      const response = await fetch('/api/birdeye/stream', {
        method: 'POST',
        signal: controller.signal,
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          prices: validAddress ? [address] : [],
          wallets: wallet ? [wallet] : [],
          newPairs: discovery,
          newListings: discovery,
          minVolume: 10000,
        }),
      });
      if (!response.ok) {
        const failed = await response.json().catch(() => ({}));
        throw new Error(
          (birdeyeObject(failed).error as string) ??
            `Live feed unavailable (${response.status}).`,
        );
      }
      if (
        !response.headers.get('content-type')?.includes('text/event-stream') ||
        !response.body
      )
        throw new Error(
          'The live feed did not return a readable event stream.',
        );
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(
          /\r\n/g,
          '\n',
        );
        if (buffer.length > 1_000_000)
          throw new Error(
            'Live feed sent an oversized event. Reconnect to resume.',
          );
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const payload = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!payload) continue;
          const event = birdeyeObject(JSON.parse(payload)) as LiveEvent;
          if (!event.kind) continue;
          if (controller.signal.aborted) break;
          setStreamState(
            event.state ??
              (event.kind === 'status' ? 'Connected' : 'Receiving'),
          );
          if (event.error) setError(event.error);
          setEvents((current) => [event, ...current].slice(0, 50));
          liveCallback.current(event);
        }
      }
      if (!controller.signal.aborted)
        setStreamState('Disconnected · reconnect to resume');
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(
          cause instanceof Error ? cause.message : 'Live feed disconnected.',
        );
        setStreamState('Unavailable');
      }
    } finally {
      if (stream.current === controller) setLive(false);
    }
  }
  return (
    <section
      className="birdeye-watch"
      aria-label="Birdeye alerts and live watch"
    >
      <h3>Watch & alerts</h3>
      <p className="birdeye-note">
        Alerts confirm on closed candles. Saved rules continue checking while
        workspace research is enabled. The live feed stops when this panel
        closes.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = Number(threshold);
          if (
            !validAddress ||
            !Number.isFinite(value) ||
            (kind === 'absolute' && value <= 0)
          ) {
            setError(
              'Select a token and enter a valid threshold. USD prices must be positive.',
            );
            return;
          }
          const baselineUnixTime =
            timeframe === 'custom'
              ? Math.floor(new Date(baseline).getTime() / 1000)
              : undefined;
          if (
            kind === 'percent' &&
            timeframe === 'custom' &&
            (!Number.isFinite(baselineUnixTime) ||
              baselineUnixTime! >= Date.now() / 1000 ||
              baselineUnixTime! < Date.now() / 1000 - 30 * 86400)
          ) {
            setError('Choose a past baseline within the last 30 days.');
            return;
          }
          void alerts('/birdeye/alerts', 'POST', {
            threadId,
            address,
            kind,
            direction,
            threshold: value,
            ...(kind === 'percent'
              ? timeframe === 'custom'
                ? { baselineUnixTime }
                : { timeframe }
              : {}),
          });
        }}
      >
        <div className="birdeye-form-grid">
          <label>
            Alert type
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as 'absolute' | 'percent')
              }
            >
              <option value="absolute">USD price</option>
              <option value="percent">Percent change</option>
            </select>
          </label>
          <label>
            Direction
            <select
              value={direction}
              onChange={(event) =>
                setDirection(event.target.value as 'above' | 'below')
              }
            >
              <option value="above">Above</option>
              <option value="below">Below</option>
            </select>
          </label>
          <label>
            {kind === 'absolute' ? 'Price in USD' : 'Change percent'}
            <input
              type="number"
              min={kind === 'absolute' ? '0.000000001' : undefined}
              step="any"
              required
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
            />
          </label>
          {kind === 'percent' && (
            <label>
              Baseline window
              <select
                value={timeframe}
                onChange={(event) => setTimeframe(event.target.value)}
              >
                <option value="1h">1 hour</option>
                <option value="4h">4 hours</option>
                <option value="24h">24 hours</option>
                <option value="custom">Custom candle baseline</option>
              </select>
            </label>
          )}
        </div>
        {kind === 'percent' && timeframe === 'custom' && (
          <label>
            Baseline date and time · last 30 days
            <input
              type="datetime-local"
              required
              value={baseline}
              onChange={(event) => setBaseline(event.target.value)}
            />
          </label>
        )}
        <div className="birdeye-actions">
          <button disabled={busy || paused || !validAddress} type="submit">
            Save alert
          </button>
          <button
            disabled={busy || paused}
            type="button"
            onClick={() =>
              void alerts('/birdeye/alerts/poll', 'POST', { threadId })
            }
          >
            Check saved alerts
          </button>
        </div>
      </form>
      {monitor?.alerts?.map((alert) => (
        <div className="birdeye-alert-row" key={alert.id}>
          <div>
            <strong>{alert.label || alert.address}</strong>
            <span>
              {alert.kind === 'absolute' ? '$' : ''}
              {alert.threshold}
              {alert.kind === 'percent' ? '%' : ''} {alert.direction} ·{' '}
              {alert.triggered ? 'Confirmed trigger' : 'Watching'}
              {alert.lastPrice !== null
                ? ` · last $${alert.lastPrice}`
                : ' · price unavailable'}
            </span>
            {alert.lastError && <span>{alert.lastError}</span>}
          </div>
          <button
            type="button"
            disabled={busy || paused}
            onClick={() =>
              void alerts(
                `/birdeye/alerts/${encodeURIComponent(alert.id)}?threadId=${encodeURIComponent(threadId)}`,
                'DELETE',
              )
            }
          >
            Delete
          </button>
        </div>
      ))}
      {monitor?.events && monitor.events.length > 0 && (
        <details>
          <summary>Confirmed alert events</summary>
          <BirdeyeTable items={monitor.events} />
        </details>
      )}
      <label className="birdeye-checkbox">
        <input
          type="checkbox"
          checked={discovery}
          onChange={(event) => setDiscovery(event.target.checked)}
        />
        Include new pools and token listings
      </label>
      <div className="birdeye-actions">
        <button
          type="button"
          disabled={paused || (!validAddress && !wallet && !discovery)}
          onClick={() => {
            if (live) {
              stream.current?.abort();
              setLive(false);
              setStreamState('Stopped');
            } else void startStream();
          }}
        >
          {live ? 'Stop live feed' : 'Start live feed'}
        </button>
        <span role="status">{streamState}</span>
      </div>
      <p className="birdeye-note">
        Streaming depends on your Birdeye plan. Discovery creates research
        candidates; select one and inspect its risk checks before acting.
      </p>
      {!!events.length && (
        <details open>
          <summary>Recent live observations · {events.length}/50</summary>
          <BirdeyeTable
            items={events.map((event) => ({
              kind: event.kind,
              state: event.state,
              observedAt: event.observedAt,
              ...birdeyeObject(event.data),
            }))}
          />
        </details>
      )}
      {error && (
        <p className="birdeye-warnings" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function BirdeyePanel({
  threadId,
  connectedAddress,
  paused,
  onClose,
  onAskDot,
}: {
  threadId: string;
  connectedAddress?: string;
  paused: boolean;
  onClose: () => void;
  onAskDot: (text: string) => void;
}) {
  const [workflow, setWorkflow] = useState<BirdeyeWorkflow>('portfolio');
  const [address, setAddress] = useState('');
  const [keyword, setKeyword] = useState('');
  const [wallets, setWallets] = useState('');
  const [addresses, setAddresses] = useState('');
  const [interval, setChartInterval] =
    useState<BirdeyeQuery['interval']>('15m');
  const [duration, setDuration] = useState<BirdeyeQuery['duration']>('30d');
  const [minLiquidity, setMinLiquidity] = useState('50000');
  const [minVolume, setMinVolume] = useState('100000');
  const [minHolders, setMinHolders] = useState('500');
  const [thresholdPercent, setThresholdPercent] = useState('3');
  const [result, setResult] = useState<BirdeyeResult>();
  const [resultQuery, setResultQuery] = useState<BirdeyeQuery>();
  const [status, setStatus] = useState<BirdeyeStatus>();
  const [statusRefresh, setStatusRefresh] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [refreshLive, setRefreshLive] = useState(false);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentResult = useRef(result);
  currentResult.current = result;
  useEffect(() => {
    const controller = new AbortController();
    void api<BirdeyeStatus>(
      `/birdeye/status?threadId=${encodeURIComponent(threadId)}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setStatus(undefined);
          setError(
            cause instanceof Error
              ? cause.message
              : 'Birdeye status is unavailable.',
          );
        }
      });
    return () => controller.abort();
  }, [threadId, statusRefresh]);
  useEffect(
    () => () => {
      request.current?.abort();
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    if (paused) {
      request.current?.abort();
      generation.current++;
      setBusy(false);
    }
  }, [paused]);
  function reset(next: BirdeyeWorkflow) {
    request.current?.abort();
    generation.current++;
    setBusy(false);
    setWorkflow(next);
    setResult(undefined);
    setResultQuery(undefined);
    setError('');
    setShareOpen(false);
    setRefreshLive(false);
  }
  function query(): BirdeyeQuery {
    const input: Record<string, unknown> = {
      workflow,
      limit: workflow === 'trending' || workflow === 'search' ? 20 : 100,
    };
    if (
      !noAddress.has(workflow) &&
      (workflow !== 'smart-money' || address.trim())
    )
      input.address = address.trim();
    if (workflow === 'search') input.keyword = keyword;
    if (
      workflow === 'pnl-comparison' ||
      (workflow === 'smart-money' && wallets.trim())
    )
      input.wallets = wallets.split(/[\s,]+/).filter(Boolean);
    if (workflow === 'watchlist')
      input.addresses = [...new Set(addresses.split(/[\s,]+/).filter(Boolean))];
    if (['chart', 'history', 'liquidity'].includes(workflow)) {
      input.interval = interval;
      input.timeTo = Math.floor(Date.now() / 1000);
      input.timeFrom = Number(input.timeTo) - 86400;
    }
    if (walletWorkflows.has(workflow) || workflow === 'smart-money')
      input.duration = workflow === 'smart-money' ? 'all' : duration;
    if (workflow === 'screener' || workflow === 'new-listings') {
      input.minLiquidity = Number(minLiquidity);
      input.minVolume = Number(minVolume);
      input.minHolders = Number(minHolders);
    }
    if (workflow === 'whales') input.minVolume = Number(minVolume);
    if (workflow === 'cross-dex')
      input.thresholdPercent = Number(thresholdPercent);
    return birdeyeQuerySchema.parse(input);
  }
  async function run(next: BirdeyeQuery, append = false, quiet = false) {
    if (paused) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++generation.current;
    if (!quiet) {
      setBusy(true);
      setError('');
    }
    try {
      const value = await api<BirdeyeResult>(
        '/birdeye/query',
        'POST',
        { threadId, ...next },
        controller.signal,
      );
      if (controller.signal.aborted || current !== generation.current) return;
      if (
        value.source !== 'Birdeye' ||
        value.workflow !== next.workflow ||
        typeof value.data !== 'object' ||
        !Array.isArray(value.warnings) ||
        !Number.isFinite(value.observedAt)
      )
        throw new Error(
          'Birdeye returned an unreadable result. Retry this request.',
        );
      setResult((previous) =>
        append && previous?.workflow === value.workflow
          ? mergeHistory(previous, value)
          : value,
      );
      if (!quiet) {
        setResultQuery(next);
        setShareOpen(false);
      }
    } catch (cause) {
      if (controller.signal.aborted || current !== generation.current) return;
      const parsed = birdeyeObject(cause);
      setError(
        cause instanceof Error
          ? cause.message
          : String(
              parsed.message ??
                'Birdeye research failed. Retry or check the provider status.',
            ),
      );
    } finally {
      if (current === generation.current && !controller.signal.aborted) {
        setBusy(false);
        setStatusRefresh((value) => value + 1);
      }
    }
  }
  useEffect(() => {
    if (
      !refreshLive ||
      !resultQuery ||
      !['chart', 'history'].includes(resultQuery.workflow) ||
      paused
    )
      return;
    const timer = setInterval(
      () => {
        if (
          document.hidden ||
          (request.current && !request.current.signal.aborted && busy)
        )
          return;
        const now = Math.floor(Date.now() / 1000);
        void run(
          {
            ...resultQuery,
            before: undefined,
            timeFrom: now - 3600,
            timeTo: now,
          },
          true,
          true,
        );
      },
      status?.credits?.low ? 180000 : 60000,
    );
    return () => clearInterval(timer);
  }, [refreshLive, resultQuery, paused, status?.credits?.low, busy]);
  function selectToken(mint: string) {
    reset('investigation');
    setAddress(mint);
    void run({ workflow: 'investigation', address: mint, limit: 100 });
  }
  function selectWallet(wallet: string) {
    reset('wallet-history');
    setAddress(wallet);
    void run({
      workflow: 'wallet-history',
      address: wallet,
      duration: 'all',
      limit: 100,
    });
  }
  const share = resultQuery ? birdeyeChatGPTUrl(resultQuery) : null;
  const token =
    resultQuery && publicTokenWorkflows.has(resultQuery.workflow)
      ? (resultQuery.address ?? '')
      : '';
  const activeWallet =
    resultQuery && walletWorkflows.has(resultQuery.workflow)
      ? resultQuery.address
      : undefined;
  const nextOffset =
    result?.data.nextOffset ??
    birdeyeObject(result?.data.pagination).nextOffset;
  return (
    <section className="birdeye-panel" aria-label="Birdeye research">
      <header className="birdeye-panel-header">
        <div>
          <span className="birdeye-eyebrow">
            <Bird size={16} /> RESEARCH / SOLANA
          </span>
          <h2>Follow the evidence.</h2>
          <p>Wallets, markets and risk in your conversation.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close Birdeye research"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="birdeye-provider">
        <span
          className={`birdeye-provider-dot ${status?.configured ? 'configured' : ''}`}
        />
        <span>{status ? status.message : 'Checking Birdeye connection…'}</span>
        {status?.credits && (
          <span className="birdeye-credit-label">
            {status.credits.remaining === null
              ? 'Credits unavailable'
              : `${status.credits.remaining.toLocaleString()} credits`}
            {status.credits.low ? ' · low budget' : ''}
          </span>
        )}
        <button
          type="button"
          aria-label="Refresh Birdeye status"
          onClick={() => {
            setError('');
            setStatusRefresh((value) => value + 1);
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <form
        className="birdeye-query"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            void run(query());
          } catch (cause) {
            const issue = birdeyeObject(cause).issues;
            setError(
              Array.isArray(issue)
                ? String(
                    birdeyeObject(issue[0]).message ??
                      'Check the request fields.',
                  )
                : 'Check the request fields.',
            );
          }
        }}
      >
        <label className="birdeye-workflow-label">
          Research view
          <select
            aria-label="Birdeye research workflow"
            value={workflow}
            onChange={(event) => reset(event.target.value as BirdeyeWorkflow)}
          >
            {birdeyeWorkflows.map((key) => (
              <option value={key} key={key}>
                {birdeyeLabels[key]}
              </option>
            ))}
          </select>
        </label>
        {workflow === 'search' ? (
          <label>
            Token name, symbol or mint
            <input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="Search, then select the exact token"
              maxLength={100}
              required
            />
          </label>
        ) : workflow === 'watchlist' ? (
          <label>
            Token mints · up to 100
            <textarea
              value={addresses}
              onChange={(event) => setAddresses(event.target.value)}
              rows={3}
              placeholder="One Solana mint per line"
              required
            />
          </label>
        ) : (
          !noAddress.has(workflow) && (
            <label>
              {walletWorkflows.has(workflow)
                ? 'Public wallet address'
                : workflow === 'smart-money'
                  ? 'Token mint · optional'
                  : 'Solana token mint'}
              <div className="birdeye-address-input">
                <input
                  aria-label={
                    walletWorkflows.has(workflow)
                      ? 'Birdeye wallet address'
                      : 'Birdeye token or wallet address'
                  }
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder={
                    workflow === 'smart-money'
                      ? 'Leave empty for market-wide smart money'
                      : 'Paste a full Solana address'
                  }
                  spellCheck={false}
                  required={workflow !== 'smart-money'}
                />
                {connectedAddress && walletWorkflows.has(workflow) && (
                  <button
                    type="button"
                    onClick={() => setAddress(connectedAddress)}
                  >
                    Use connected wallet
                  </button>
                )}
              </div>
            </label>
          )
        )}
        {(workflow === 'pnl-comparison' || workflow === 'smart-money') && (
          <label>
            {workflow === 'smart-money'
              ? 'Full track records · optional, up to 3 wallets'
              : 'Wallets to compare · up to 50'}
            <textarea
              value={wallets}
              onChange={(event) => setWallets(event.target.value)}
              rows={3}
              placeholder="One public wallet address per line"
              required={workflow === 'pnl-comparison'}
            />
          </label>
        )}
        <div className="birdeye-form-grid">
          {['chart', 'history'].includes(workflow) && (
            <label>
              Candle interval
              <select
                value={interval}
                onChange={(event) =>
                  setChartInterval(
                    event.target.value as BirdeyeQuery['interval'],
                  )
                }
              >
                {birdeyeIntervals.map((key) => (
                  <option key={key}>{key}</option>
                ))}
              </select>
            </label>
          )}
          {workflow === 'liquidity' && (
            <p className="birdeye-note">
              Liquidity uses minute candles from the deepest indexed pool.
            </p>
          )}
          {walletWorkflows.has(workflow) && (
            <label>
              PnL period
              <select
                value={duration}
                onChange={(event) =>
                  setDuration(event.target.value as BirdeyeQuery['duration'])
                }
              >
                <option value="1d">1 day</option>
                <option value="7d">7 days</option>
                <option value="30d">30 days</option>
                <option value="90d">90 days</option>
                <option value="all">All history</option>
              </select>
            </label>
          )}
          {['screener', 'new-listings'].includes(workflow) && (
            <>
              <label>
                Min liquidity · USD
                <input
                  type="number"
                  min="0"
                  value={minLiquidity}
                  onChange={(event) => setMinLiquidity(event.target.value)}
                />
              </label>
              <label>
                Min holders
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={minHolders}
                  onChange={(event) => setMinHolders(event.target.value)}
                />
              </label>
            </>
          )}
          {['screener', 'new-listings', 'whales'].includes(workflow) && (
            <label>
              Min volume · USD
              <input
                type="number"
                min="0"
                value={minVolume}
                onChange={(event) => setMinVolume(event.target.value)}
              />
            </label>
          )}
          {workflow === 'cross-dex' && (
            <label>
              Flag spread above · %
              <input
                type="number"
                min="0.1"
                max="1000"
                step="0.1"
                value={thresholdPercent}
                onChange={(event) => setThresholdPercent(event.target.value)}
              />
            </label>
          )}
        </div>
        <div className="birdeye-actions">
          <button
            className="birdeye-primary"
            type="submit"
            disabled={busy || paused || !status?.configured}
          >
            {busy
              ? 'Reading Birdeye…'
              : workflow === 'search'
                ? 'Find tokens'
                : 'Run research'}
          </button>
          <button
            type="button"
            disabled={busy || paused || !status?.configured}
            onClick={() => {
              reset('credits');
              void run({ workflow: 'credits' });
            }}
          >
            Credit budget
          </button>
          {busy && (
            <button
              type="button"
              onClick={() => {
                request.current?.abort();
                generation.current++;
                setBusy(false);
              }}
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={paused}
            onClick={() => {
              try {
                onAskDot(requestPrompt(query()));
              } catch (cause) {
                const issues = birdeyeObject(cause).issues;
                setError(
                  Array.isArray(issues)
                    ? String(
                        birdeyeObject(issues[0]).message ??
                          'Check the request fields.',
                      )
                    : 'Check the request fields.',
                );
              }
            }}
          >
            Draft request for Dot
          </button>
        </div>
      </form>
      {workflow === 'search' && (
        <p className="birdeye-note">
          Symbols can name multiple tokens. Select a result by its full mint;
          research never picks the first match for you.
        </p>
      )}
      {error && (
        <p className="birdeye-warnings" role="alert">
          {error}
        </p>
      )}
      {paused && (
        <p role="status" className="birdeye-note">
          This Dot is paused. Resume it before running research.
        </p>
      )}
      {result && (
        <>
          <div className="birdeye-result-heading">
            <h3>{birdeyeLabels[result.workflow]}</h3>
            <div className="birdeye-actions">
              <button
                type="button"
                onClick={() =>
                  resultQuery && onAskDot(requestPrompt(resultQuery, result))
                }
              >
                Ask Dot about this
              </button>
              {share && (
                <button type="button" onClick={() => setShareOpen(!shareOpen)}>
                  Open in ChatGPT <ExternalLink size={13} />
                </button>
              )}
            </div>
          </div>
          {resultQuery?.address && (
            <p className="birdeye-observed-address">
              Observed address <code>{resultQuery.address}</code>
            </p>
          )}
          {shareOpen && share && (
            <div className="birdeye-share">
              <p>
                This opens ChatGPT with the public token mint and research view.
                It includes no holdings, wallet identifiers or conversation
                text.
              </p>
              <a href={share} target="_blank" rel="noopener noreferrer">
                Continue to ChatGPT <ExternalLink size={13} />
              </a>
            </div>
          )}
          <BirdeyeResultView
            result={result}
            onSelect={selectToken}
            onWallet={selectWallet}
            threadId={threadId}
          />
          {typeof nextOffset === 'number' &&
            Number.isInteger(nextOffset) &&
            resultQuery && (
              <div className="birdeye-actions">
                <button
                  type="button"
                  disabled={busy || paused}
                  onClick={() =>
                    void run({ ...resultQuery, offset: nextOffset })
                  }
                >
                  Next page of records
                </button>
                <span className="birdeye-note">
                  Page starts at record {(resultQuery.offset ?? 0) + 1}
                </span>
              </div>
            )}
          {['chart', 'history'].includes(result.workflow) && (
            <div className="birdeye-actions">
              <button
                type="button"
                disabled={busy || paused || result.data.hasMore === false}
                onClick={() => {
                  if (!resultQuery) return;
                  const before =
                    Number(result.data.nextBefore) ||
                    birdeyeChartPoints(result.data.items)[0]?.time;
                  if (before)
                    void run(
                      {
                        ...resultQuery,
                        before,
                        timeTo: before - 1,
                        timeFrom: before - 86400,
                      },
                      true,
                    );
                }}
              >
                Load earlier history
              </button>
              <label className="birdeye-checkbox">
                <input
                  type="checkbox"
                  checked={refreshLive}
                  onChange={(event) => setRefreshLive(event.target.checked)}
                />
                Refresh visible chart every{' '}
                {status?.credits?.low ? '3 minutes' : 'minute'}
              </label>
            </div>
          )}
        </>
      )}
      <div className="birdeye-watch-toggle">
        <button
          type="button"
          aria-expanded={watchOpen}
          onClick={() => setWatchOpen(!watchOpen)}
        >
          {watchOpen ? 'Hide watch & alerts' : 'Watch & alerts'}
        </button>
        <span>Read-only research · Solana mainnet</span>
      </div>
      {watchOpen && (
        <BirdeyeWatch
          key={threadId}
          threadId={threadId}
          address={token || (publicTokenWorkflows.has(workflow) ? address : '')}
          wallet={activeWallet}
          paused={paused}
          onCandle={(event) => {
            const previous = currentResult.current;
            if (
              !previous ||
              previous.workflow !== 'chart' ||
              event.kind !== 'price'
            )
              return;
            const incoming = birdeyeObject(event.data);
            if (incoming.address && incoming.address !== previous.data.address)
              return;
            const rows = birdeyeRows(incoming).length
              ? birdeyeRows(incoming)
              : [incoming];
            if (!birdeyeChartPoints(rows).length) return;
            setResult(
              mergeHistory(previous, {
                ...previous,
                observedAt: Date.now(),
                data: { ...previous.data, items: rows },
              }),
            );
          }}
        />
      )}
    </section>
  );
}
