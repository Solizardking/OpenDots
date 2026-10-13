import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bird, ChevronRight } from 'lucide-react';
import type { BirdeyeResult, BirdeyeWorkflow } from '../shared/birdeye-types';
import type { ComputerToolRenderProps } from './ComputerToolCard';
import { api } from './api';

export const birdeyeLabels: Record<BirdeyeWorkflow, string> = {
  portfolio: 'Wallet portfolio & PnL',
  'pnl-comparison': 'Compare wallet PnL',
  search: 'Find a token',
  investigation: 'Token investigation',
  'rug-check': 'Rug risk checks',
  'wash-trading': 'Wash trading signals',
  'cross-dex': 'Cross-DEX price scanner',
  liquidity: 'Pool liquidity',
  chart: 'Price candles',
  history: 'Price history',
  'price-stats': 'Price statistics',
  trending: 'Trending tokens',
  screener: 'Token screener',
  'new-listings': 'New token listings',
  watchlist: 'Watchlist prices',
  whales: 'Whale transactions',
  'smart-money': 'Smart money & track records',
  'wallet-history': 'Wallet transactions',
  credits: 'Credit budget',
};

export function birdeyeObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { error: value };
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function birdeyeNumber(value: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    typeof value === 'boolean'
  )
    return null;
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;
  return Number.isFinite(number) ? number : null;
}
function money(value: unknown) {
  const number = birdeyeNumber(value);
  return number === null
    ? 'Unavailable'
    : number.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: Math.abs(number) < 1 ? 8 : 2,
      });
}
function title(key: string) {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}
function format(value: unknown, key = '', context?: 'security'): string {
  if (
    context === 'security' &&
    value === null &&
    ['ownerAddress', 'freezeAuthority'].includes(key)
  )
    return 'Renounced';
  if (value === null || value === undefined) return 'Unavailable';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value))
    return value
      .map((item) =>
        typeof item === 'object' ? JSON.stringify(item) : String(item),
      )
      .join(', ')
      .slice(0, 250);
  if (typeof value === 'object')
    return Object.entries(birdeyeObject(value))
      .map(
        ([label, item]) => `${title(label)}: ${format(item, label, context)}`,
      )
      .join(' · ')
      .slice(0, 350);
  const number = birdeyeNumber(value);
  if (number !== null && ['observedAt', 'createdAt', 'checkedAt'].includes(key))
    return new Date(number).toLocaleString();
  if (
    number !== null &&
    [
      'unix_time',
      'unixTime',
      'blockUnixTime',
      'block_time',
      'lastObservedAt',
      'candleUnixTime',
    ].includes(key)
  )
    return new Date(number * 1000).toLocaleString();
  if (
    number !== null &&
    /usd|price|liquidity|totalValue|netWorth|net_worth|marketCap/i.test(key)
  )
    return money(number);
  if (number !== null && /percent|win_rate/i.test(key))
    return `${(['win_rate', 'top10HolderPercent', 'creatorPercentage'].includes(key) ? number * 100 : number).toFixed(2)}%`;
  if (number !== null && !/address|wallet|hash|symbol|name|time/i.test(key))
    return number.toLocaleString('en-US', { maximumFractionDigits: 8 });
  return String(value);
}
export function birdeyeRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(birdeyeObject);
  const object = birdeyeObject(value);
  for (const field of [
    'items',
    'tokens',
    'history',
    'data',
    'list',
    'result',
  ]) {
    if (Array.isArray(object[field]))
      return (object[field] as unknown[]).map(birdeyeObject);
  }
  return [];
}
function metrics(value: unknown): [string, unknown][] {
  return Object.entries(birdeyeObject(value)).filter(
    ([, item]) =>
      item === null || ['string', 'number', 'boolean'].includes(typeof item),
  );
}
export function BirdeyeMetrics({
  value,
  context,
}: {
  value: unknown;
  context?: 'security';
}) {
  const entries = metrics(value);
  if (!entries.length) return null;
  return (
    <dl className="birdeye-metrics">
      {entries.map(([key, item]) => (
        <div key={key}>
          <dt>{title(key)}</dt>
          <dd title={String(item ?? '')}>{format(item, key, context)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function BirdeyeTable({
  items,
  onSelect,
  onWallet,
  empty = 'No records returned for this request.',
}: {
  items: unknown;
  onSelect?: (address: string) => void;
  onWallet?: (address: string) => void;
  empty?: string;
}) {
  const rows = birdeyeRows(items);
  if (!rows.length) return <p className="birdeye-empty">{empty}</p>;
  const priority = [
    'symbol',
    'name',
    'address',
    'wallet',
    'owner',
    'source',
    'status',
    'gate',
    'priceUsd',
    'price',
    'value',
    'amount',
    'liquidity',
    'liquidityUsd',
    'volume_24h_usd',
    'volumeUsd',
    'realizedProfitUsd',
    'unrealizedUsd',
    'totalUsd',
    'pnl',
    'deviationPercent',
    'confirmed',
    'percent_of_supply',
    'tags',
  ];
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const columns = [
    ...priority.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !priority.includes(key)),
  ].slice(0, 10);
  return (
    <div className="birdeye-table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((key) => (
              <th key={key}>{title(key)}</th>
            ))}
            {(onSelect || onWallet) && <th>Research</th>}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row, index) => {
            const address =
              row.address ?? row.token_address ?? row.tokenAddress;
            const wallet =
              row.wallet ?? row.owner ?? row.ownerAddress ?? row.address;
            return (
              <tr key={`${String(address ?? wallet ?? index)}-${index}`}>
                {columns.map((key) => (
                  <td
                    key={key}
                    title={format(row[key], key)}
                    className={
                      /address|wallet|owner|hash/.test(key)
                        ? 'birdeye-address'
                        : ''
                    }
                  >
                    {format(row[key], key)}
                  </td>
                ))}
                {(onSelect || onWallet) && (
                  <td>
                    {onSelect &&
                      typeof address === 'string' &&
                      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && (
                        <button
                          type="button"
                          onClick={() => onSelect(address)}
                          aria-label={`Investigate token ${address}`}
                        >
                          Select <ChevronRight size={12} />
                        </button>
                      )}
                    {onWallet &&
                      typeof wallet === 'string' &&
                      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet) && (
                        <button type="button" onClick={() => onWallet(wallet)}>
                          Track record
                        </button>
                      )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 100 && (
        <p>
          Showing the first 100 records. Narrow the request for a smaller view.
        </p>
      )}
    </div>
  );
}

type ChartPoint = {
  time: number;
  close: number;
  open?: number;
  high?: number;
  low?: number;
};
export function birdeyeChartPoints(raw: unknown): ChartPoint[] {
  const deduplicated = new Map<number, ChartPoint>();
  for (const row of birdeyeRows(raw)) {
    const time = birdeyeNumber(
      row.unix_time ?? row.unixTime ?? row.timestamp ?? row.time ?? row.date,
    );
    const close = birdeyeNumber(
      row.c ??
        row.close ??
        row.close_liquidity_usd ??
        row.net_worth ??
        row.netWorth ??
        row.value,
    );
    if (time === null || close === null) continue;
    const open = birdeyeNumber(row.o ?? row.open ?? row.open_liquidity_usd);
    const high = birdeyeNumber(row.h ?? row.high ?? row.high_liquidity_usd);
    const low = birdeyeNumber(row.l ?? row.low ?? row.low_liquidity_usd);
    deduplicated.set(time, {
      time,
      close,
      ...(open === null ? {} : { open }),
      ...(high === null ? {} : { high }),
      ...(low === null ? {} : { low }),
    });
  }
  return [...deduplicated.values()]
    .sort((a, b) => a.time - b.time)
    .slice(-1000);
}
export function BirdeyeChart({
  items,
  label,
  candles = false,
}: {
  items: unknown;
  label: string;
  candles?: boolean;
}) {
  const points = birdeyeChartPoints(items);
  if (!points.length)
    return (
      <p className="birdeye-empty">
        {label}: history unavailable for this range.
      </p>
    );
  const min = Math.min(...points.map((point) => point.low ?? point.close));
  const max = Math.max(...points.map((point) => point.high ?? point.close));
  const y = (value: number) =>
    174 - ((value - min) / (max - min || Math.max(Math.abs(max), 1))) * 150;
  const first = points[0].time,
    last = points.at(-1)!.time;
  const x = (time: number) => 12 + ((time - first) / (last - first || 1)) * 556;
  const line = points
    .map((point) => `${x(point.time)},${y(point.close)}`)
    .join(' ');
  return (
    <figure className="birdeye-chart">
      <figcaption>
        <strong>{label}</strong>
        <span>{money(points.at(-1)!.close)}</span>
      </figcaption>
      <svg
        viewBox="0 0 580 192"
        role="img"
        aria-label={`${label}, ${points.length} observations from ${new Date(first * 1000).toLocaleDateString()} to ${new Date(last * 1000).toLocaleDateString()}, latest ${money(points.at(-1)!.close)}`}
      >
        <line
          x1="12"
          x2="568"
          y1="174"
          y2="174"
          className="birdeye-chart-grid"
        />
        <line x1="12" x2="568" y1="99" y2="99" className="birdeye-chart-grid" />
        {candles && points.some((point) => point.open !== undefined) ? (
          points.map((point) => (
            <g
              key={point.time}
              className={
                point.close >= (point.open ?? point.close)
                  ? 'birdeye-candle-up'
                  : 'birdeye-candle-down'
              }
            >
              <line
                x1={x(point.time)}
                x2={x(point.time)}
                y1={y(point.high ?? point.close)}
                y2={y(point.low ?? point.close)}
              />
              <rect
                x={x(point.time) - Math.max(1, 200 / points.length)}
                y={Math.min(y(point.open ?? point.close), y(point.close))}
                width={Math.max(2, 400 / points.length)}
                height={Math.max(
                  1,
                  Math.abs(y(point.open ?? point.close) - y(point.close)),
                )}
              />
            </g>
          ))
        ) : (
          <polyline points={line} className="birdeye-chart-line" />
        )}
      </svg>
      <div className="birdeye-chart-scale">
        <span>{new Date(first * 1000).toLocaleDateString()}</span>
        <span>{points.length} actual observations · USD</span>
        <span>{new Date(last * 1000).toLocaleDateString()}</span>
      </div>
    </figure>
  );
}

function Section({
  title: label,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="birdeye-result-section">
      <h4>{label}</h4>
      {children}
    </section>
  );
}
function Details({ value }: { value: unknown }) {
  return (
    <details className="birdeye-details">
      <summary>Source details</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

/** Price history starts only when a holding's details are opened. Wallet data keeps its own budget. */
function HoldingHistory({
  threadId,
  address,
  symbol,
}: {
  threadId: string;
  address: string;
  symbol: string;
}) {
  const [items, setItems] = useState<unknown>();
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function load(open: boolean) {
    if (
      !open ||
      items !== undefined ||
      (controller.current && !controller.current.signal.aborted)
    )
      return;
    const current = new AbortController();
    controller.current = current;
    setError('');
    const timeTo = Math.floor(Date.now() / 1000);
    try {
      const result = await api<BirdeyeResult>(
        '/birdeye/query',
        'POST',
        {
          threadId,
          workflow: 'history',
          address,
          interval: '1H',
          timeFrom: timeTo - 86400,
          timeTo,
          limit: 100,
        },
        current.signal,
      );
      if (!current.signal.aborted) setItems(result.data.items);
    } catch (cause) {
      if (!current.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Holding price history unavailable.',
        );
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }
  return (
    <details
      className="birdeye-holding-history"
      onToggle={(event) => void load(event.currentTarget.open)}
    >
      <summary>{symbol || address} · price history</summary>
      {items !== undefined ? (
        <BirdeyeChart
          items={items}
          label={`${symbol || 'Holding'} · 24 hour USD price`}
        />
      ) : error ? (
        <p role="status">{error}</p>
      ) : (
        <p className="birdeye-note">Loading price history…</p>
      )}
    </details>
  );
}

export function BirdeyeResultView({
  result,
  onSelect,
  onWallet,
  threadId,
}: {
  result: BirdeyeResult;
  onSelect?: (address: string) => void;
  onWallet?: (wallet: string) => void;
  threadId?: string;
}) {
  const data = result.data;
  const panels = birdeyeObject(data.panels);
  const summary = birdeyeObject(data.pnlSummary ?? data.summary);
  const pnl = birdeyeObject(summary.pnl);
  const counts = birdeyeObject(summary.counts);
  const portfolio = result.workflow === 'portfolio';
  return (
    <div className="birdeye-result">
      <div className="birdeye-result-stamp">
        <span>{result.source} · Solana</span>
        <time dateTime={new Date(result.observedAt).toISOString()}>
          {new Date(result.observedAt).toLocaleTimeString()}
        </time>
        {result.partial && <span>Partial coverage</span>}
      </div>
      {!!result.warnings.length && (
        <div className="birdeye-warnings" role="status">
          {result.warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </div>
      )}
      {portfolio && (
        <>
          <BirdeyeMetrics
            value={{
              totalValue: data.totalValue,
              realized_profit_usd: pnl.realized_profit_usd,
              unrealized_usd: pnl.unrealized_usd,
              total_usd: pnl.total_usd,
              win_rate: counts.win_rate,
              unique_tokens: summary.unique_tokens,
            }}
          />
          <BirdeyeChart items={data.equityCurve} label="Wallet equity" />
          <Section title="Holdings · scaled token amounts">
            <BirdeyeTable
              items={birdeyeRows(data.holdings).map((item) => ({
                symbol: item.symbol ?? item.name,
                address: item.address,
                amount: item.amount,
                valueUsd: item.value,
                priceUsd: item.price,
              }))}
              onSelect={onSelect}
            />
            {threadId && (
              <div className="birdeye-holding-histories">
                {birdeyeRows(data.holdings)
                  .filter((item) => typeof item.address === 'string')
                  .slice(0, 10)
                  .map((item, index) => (
                    <HoldingHistory
                      key={`${String(item.address)}-${index}`}
                      threadId={threadId}
                      address={String(item.address)}
                      symbol={String(item.symbol ?? item.name ?? '')}
                    />
                  ))}
                <p className="birdeye-note">
                  Price history loads on demand for up to ten visible holdings
                  and uses a separate price-data budget.
                </p>
              </div>
            )}
          </Section>
          <Section title="Profit & loss per token">
            <BirdeyeTable
              items={birdeyeRows(data.tokenPnl).map((item) => ({
                symbol: item.symbol ?? birdeyeObject(item.token).symbol,
                address:
                  item.address ??
                  item.token_address ??
                  birdeyeObject(item.token).address,
                ...birdeyeObject(item.pnl),
              }))}
              onSelect={onSelect}
            />
          </Section>
        </>
      )}
      {['chart', 'history'].includes(result.workflow) && (
        <BirdeyeChart
          items={data.items}
          label="Token price in USD"
          candles={result.workflow === 'chart'}
        />
      )}
      {result.workflow === 'liquidity' && (
        <>
          <BirdeyeMetrics
            value={{
              pool: birdeyeObject(data.pool).address ?? data.pool,
              venue: birdeyeObject(data.pool).source,
              flagged_candles: birdeyeRows(data.flagged).length,
            }}
          />
          <BirdeyeChart
            items={data.series}
            label="Pool liquidity in USD"
            candles
          />
          <BirdeyeChart
            items={birdeyeRows(data.series).map((item) => ({
              unix_time: item.unix_time,
              c: item.priceClose,
            }))}
            label="Aligned token price in USD"
          />
          <BirdeyeTable
            items={birdeyeRows(data.series).map((item) => ({
              unix_time: item.unix_time,
              close_liquidity_usd: item.close_liquidity_usd,
              liquidityChangePercent: item.liquidityChangePercent,
              priceChangePercent: item.priceChangePercent,
              baseBalanceChangePercent: item.baseBalanceChangePercent,
              quoteBalanceChangePercent: item.quoteBalanceChangePercent,
              cause: item.cause,
              flagged: item.flagged,
            }))}
          />
          {data.explanation !== undefined && (
            <Details value={data.explanation} />
          )}
        </>
      )}
      {result.workflow === 'cross-dex' && (
        <>
          <BirdeyeMetrics
            value={{
              consolidated_price_usd:
                birdeyeObject(data.anchor).value ?? data.anchor,
              weightedPriceUsd: data.weightedPriceUsd,
            }}
          />
          <p className="birdeye-note">
            USD-normalized pool prices. Confirmed means the spread persisted
            across traded candles; missing evidence stays unconfirmed.
          </p>
          <BirdeyeTable items={data.pools} />
        </>
      )}
      {result.workflow === 'rug-check' && (
        <>
          <div className={`birdeye-gate ${String(data.gate)}`} role="status">
            Risk gate: {String(data.gate ?? 'unknown')}
          </div>
          <BirdeyeTable items={data.checks} />
          <p className="birdeye-note">
            Liquidity is an approximation of sellable depth on Solana. A passed
            check does not guarantee an exit.
          </p>
        </>
      )}
      {result.workflow === 'wash-trading' && (
        <>
          <BirdeyeMetrics
            value={{ score: data.score, maxScore: data.maxScore }}
          />
          <BirdeyeTable items={data.signals} />
          <p className="birdeye-note">
            These signals measure suspicion. Market makers, arbitrage and fresh
            listings can show similar patterns.
          </p>
        </>
      )}
      {Object.entries(panels)
        .filter(
          ([, value]) =>
            !['portfolio', 'chart', 'wallet-history'].includes(
              result.workflow,
            ) || birdeyeObject(value).status === 'error',
        )
        .map(([key, value]) => {
          const panel = birdeyeObject(value),
            raw = panel.data;
          return (
            <Section title={title(key)} key={key}>
              {panel.status === 'error' ? (
                <p className="birdeye-warnings" role="status">
                  {String(
                    panel.error ??
                      'This data is unavailable on the current plan.',
                  )}
                </p>
              ) : key === 'chart' ? (
                <BirdeyeChart items={raw} label="Price in USD" candles />
              ) : (
                <>
                  <BirdeyeMetrics
                    value={raw}
                    context={key === 'security' ? 'security' : undefined}
                  />
                  {!!birdeyeRows(raw).length && (
                    <BirdeyeTable
                      items={raw}
                      onWallet={key === 'traders' ? onWallet : undefined}
                    />
                  )}
                </>
              )}
              <Details value={value} />
            </Section>
          );
        })}
      {[
        'search',
        'trending',
        'screener',
        'new-listings',
        'watchlist',
        'pnl-comparison',
        'whales',
        'wallet-history',
        'smart-money',
        'price-stats',
      ].includes(result.workflow) && (
        <>
          <BirdeyeMetrics
            value={data.summary ?? Object.fromEntries(metrics(data))}
          />
          <BirdeyeTable
            items={data.items}
            onSelect={
              [
                'search',
                'trending',
                'screener',
                'new-listings',
                'smart-money',
              ].includes(result.workflow)
                ? onSelect
                : undefined
            }
            onWallet={result.workflow === 'whales' ? onWallet : undefined}
          />
        </>
      )}
      {result.workflow === 'smart-money' && (
        <>
          <p className="birdeye-note">
            Select a wallet to inspect its full track record before following
            its activity.
          </p>
          {data.topTraders !== undefined && (
            <Section title="Top traders">
              <BirdeyeTable items={data.topTraders} onWallet={onWallet} />
            </Section>
          )}
          {data.trackRecord !== undefined && (
            <Section title="Full wallet track record">
              <BirdeyeMetrics value={data.trackRecord} />
              <Details value={data.trackRecord} />
            </Section>
          )}
          {Object.entries(birdeyeObject(data.trackRecords)).map(
            ([wallet, raw]) => {
              const track = birdeyeObject(raw),
                details = birdeyeObject(track.data),
                summary = birdeyeObject(details.summary);
              return (
                <Section key={wallet} title={`Full track record · ${wallet}`}>
                  <p className="birdeye-note">All-time cumulative history</p>
                  {track.status === 'error' ? (
                    <p role="status">
                      {String(track.error ?? 'Track record unavailable.')}
                    </p>
                  ) : (
                    <>
                      <BirdeyeMetrics
                        value={{
                          ...birdeyeObject(summary.pnl),
                          win_rate: birdeyeObject(summary.counts).win_rate,
                          unique_tokens: summary.unique_tokens,
                        }}
                      />
                      <BirdeyeTable items={details.tokens} />
                    </>
                  )}
                  <Details value={raw} />
                </Section>
              );
            },
          )}
          {data.pnl !== undefined && (
            <Section title="Cumulative profit & loss">
              <BirdeyeMetrics
                value={birdeyeObject(data.pnl).summary ?? data.pnl}
              />
              <BirdeyeTable items={birdeyeObject(data.pnl).tokens} />
            </Section>
          )}
        </>
      )}
      {result.workflow === 'wallet-history' && (
        <Section title="All-time cumulative profit & loss">
          <BirdeyeMetrics
            value={{
              ...pnl,
              win_rate: counts.win_rate,
              unique_tokens: summary.unique_tokens,
            }}
          />
          <BirdeyeTable items={data.tokenPnl} onSelect={onSelect} />
        </Section>
      )}
      {result.workflow === 'credits' && (
        <>
          <BirdeyeMetrics value={{ remaining: data.remaining }} />
          <p className="birdeye-note">
            {Array.isArray(data.degradationOrder)
              ? data.degradationOrder.join(' → ')
              : 'Reduce discovery refreshes first, then profiling. Keep active monitoring visible.'}
          </p>
          <BirdeyeMetrics value={data.raw} />
        </>
      )}
      <Details value={data} />
    </div>
  );
}

export function BirdeyeToolCard({
  name,
  status,
  result,
}: ComputerToolRenderProps) {
  const value = birdeyeObject(result);
  const error =
    typeof value.error === 'string'
      ? value.error
      : value.status === 'error'
        ? String(value.message ?? 'Research unavailable.')
        : '';
  const workflow =
    typeof value.workflow === 'string'
      ? (value.workflow as BirdeyeWorkflow)
      : (name.replace(/^birdeye_/, '').replace(/_/g, '-') as BirdeyeWorkflow);
  const valid =
    value.source === 'Birdeye' &&
    typeof value.observedAt === 'number' &&
    Number.isFinite(value.observedAt) &&
    typeof value.data === 'object' &&
    value.data !== null;
  return (
    <section
      className="birdeye-tool-card"
      aria-label={`Birdeye ${birdeyeLabels[workflow] ?? 'research'}`}
    >
      <header>
        <Bird size={17} />
        <strong>{birdeyeLabels[workflow] ?? 'Birdeye research'}</strong>
        <span>
          {error
            ? 'Unavailable'
            : status === 'complete'
              ? 'Observed'
              : 'Researching…'}
        </span>
      </header>
      {error && <p role="alert">{error}</p>}
      {name === 'birdeye_status' && typeof value.message === 'string' && (
        <>
          <p role="status">{value.message}</p>
          <BirdeyeMetrics
            value={{ configured: value.configured, state: value.state }}
          />
          <BirdeyeMetrics value={value.credits} />
        </>
      )}
      {name === 'birdeye_alerts' && Array.isArray(value.alerts) && (
        <>
          <BirdeyeTable
            items={value.alerts}
            empty="No alerts saved in this conversation."
          />
          {!!birdeyeRows(value.events).length && (
            <Section title="Confirmed alert events">
              <BirdeyeTable items={value.events} />
            </Section>
          )}
        </>
      )}
      {name === 'birdeye_create_alert' && value.alert !== undefined && (
        <>
          <p role="status">
            Alert saved. Confirmation requires a closed candle.
          </p>
          <BirdeyeMetrics value={value.alert} />
        </>
      )}
      {name === 'birdeye_remove_alert' &&
        typeof value.removed === 'boolean' && (
          <p role="status">
            {value.removed
              ? 'Alert removed.'
              : 'Alert was not found in this conversation.'}
          </p>
        )}
      {valid && (
        <BirdeyeResultView
          result={{
            source: 'Birdeye',
            workflow,
            observedAt: value.observedAt as number,
            data: birdeyeObject(value.data),
            warnings: Array.isArray(value.warnings)
              ? value.warnings.filter(
                  (item): item is string => typeof item === 'string',
                )
              : [],
            partial: value.partial === true,
          }}
        />
      )}
      {status === 'complete' && !valid && !error && <Details value={value} />}
    </section>
  );
}
