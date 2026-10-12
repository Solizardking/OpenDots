import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { OpenMarketCandleChart, AccountTable } from './OpenMarketCharts';
import { api } from './api';

const types = [
  ['TRADE_SIDE_AGNOSTIC_AGG', 'Candles'],
  ['CROSS_EXCHANGE_VOLUME', 'Cross-exchange volume · Advanced'],
  ['TRADE_AGG', 'Buy / sell candles'],
  ['OPEN_INTEREST_AGG', 'Open interest'],
  ['FUNDING_RATE_AGG', 'Funding rates'],
  ['LIQUIDATION_AGG', 'Liquidations'],
  ['VOLUME_PROFILE_AGG', 'Volume profile'],
  ['TPO_AGG', 'Market profile / TPO'],
  ['BLOCK_BOOK_SNAPSHOT_AGG', 'Orderbook heatmap'],
  ['HYPERLIQUID_LIQUIDATION_AGG', 'Liquidation heatmap · Advanced'],
  ['HYPERLIQUID_TRIGGER_LIQUIDITY_AGG', 'TP / SL heatmap · Advanced'],
  ['TOKEN_SUPPLY_AGG', 'Bitcoin dominance / supply · Advanced'],
  ['IMPLIED_VOLATILITY_OPTION_SUMMARY_AGG', 'Implied volatility · Advanced'],
  ['SKEW_OPTION_SUMMARY_AGG', 'Options skew · Advanced'],
];
type Point = Record<string, unknown> & {
  timestamp?: { s?: number; ns?: number };
  TpoAggregation?: Record<string, unknown>;
};
type Series = {
  id: {
    type: string;
    exchange?: string;
    rawSymbol?: string;
    normalizedSymbol?: string;
    coin?: string;
    side?: string;
    tenor?: string;
    interval?: string;
    category?: string;
  };
  points: { Point: Point }[];
};
type Instrument = {
  exchange: string;
  rawSymbol: string;
  normalizedSymbol?: string;
  coin?: string;
  tenor?: string;
  coinName?: string;
  category?: string;
};
type Result = {
  data: { series: Series[] };
  query: Record<string, string>;
  observedAt: number;
};
type Reply = Result & {
  configured?: boolean;
  data: Result['data'] & {
    symbols?: Instrument[];
    blockSizes?: number[];
    traderProfiles?: unknown;
    traderProfile?: unknown;
    userPositions?: unknown;
    marketSummary?: unknown;
    userCategories?: unknown;
    platformSummary?: unknown;
    platformDistribution?: {
      distribution_bands?: unknown;
      distribution_cumulative?: unknown;
    };
  };
};
async function read(route: string, signal?: AbortSignal): Promise<Reply> {
  return api<Reply>(
    '/markets/openmarket/' + route,
    'GET',
    undefined,
    signal || AbortSignal.timeout(15000),
  );
}
const numeric = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const format = (value: number) =>
  value.toLocaleString(undefined, { maximumSignificantDigits: 7 });
function ScalarChart({
  points,
  field,
  title,
}: {
  points: Point[];
  field: string;
  title: string;
}) {
  const rows = points
    .filter((p) => numeric(p[field]) && Number.isFinite(p.timestamp?.s))
    .sort((a, b) => a.timestamp!.s! - b.timestamp!.s!);
  const [hover, setHover] = useState<number>();
  if (!rows.length) return <p>No values returned for this field.</p>;
  const values = rows.map((p) => p[field] as number),
    min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || Math.abs(max) * 0.01 || 1,
    x = (i: number) => 20 + (i / Math.max(1, rows.length - 1)) * 530,
    y = (v: number) => 175 - ((v - min) / range) * 140;
  const index = Math.min(hover ?? rows.length - 1, rows.length - 1),
    point = rows[index];
  return (
    <section className="om-scalar-chart">
      <h3>
        {title} · {field}
      </h3>
      <p>
        {format(point[field] as number)} ·{' '}
        {new Date(point.timestamp!.s! * 1000).toISOString()}
      </p>
      <svg
        viewBox="0 0 640 210"
        role="img"
        aria-label={title + ' ' + field + ' chart'}
        tabIndex={0}
        onKeyDown={(e) => {
          if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            setHover(
              Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  index + (e.key === 'ArrowLeft' ? -1 : 1),
                ),
              ),
            );
          }
        }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(
                rows.length - 1,
                Math.round(
                  ((e.clientX - r.left) / r.width) * (rows.length - 1),
                ),
              ),
            ),
          );
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={20}
              x2={550}
              y1={y(min + range * f)}
              y2={y(min + range * f)}
              stroke="#ffffff20"
            />
            <text
              x={560}
              y={y(min + range * f) + 4}
              fontSize={9}
              fill="#97a3b4"
            >
              {format(min + range * f)}
            </text>
          </g>
        ))}
        <path
          d={rows
            .map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[field] as number)}`)
            .join(' ')}
          fill="none"
          stroke="#f87171"
          strokeWidth={2}
        />
        <circle
          cx={x(index)}
          cy={y(point[field] as number)}
          r={4}
          fill="#f9a8a8"
        />
      </svg>
    </section>
  );
}
function Heatmap({
  points,
  title,
  unit,
}: {
  points: Point[];
  title: string;
  unit: string;
}) {
  const [focus, setFocus] = useState('');
  const cells = useMemo(
    () =>
      points.slice(-20).flatMap((point, col) =>
        ['bids', 'asks', 'levels'].flatMap((side) => {
          const values = point[side];
          if (!Array.isArray(values)) return [];
          const rows: {
            price: number;
            volume: number;
            col: number;
            side: string;
            time: number;
          }[] = [];
          for (let i = 0; i + 1 < values.length && i < 2000; i += 2)
            if (
              numeric(values[i]) &&
              numeric(values[i + 1]) &&
              values[i] > 0 &&
              values[i + 1] > 0
            )
              rows.push({
                price: values[i],
                volume: values[i + 1],
                col,
                side,
                time: point.timestamp?.s || 0,
              });
          return rows;
        }),
      ),
    [points],
  );
  if (!cells.length) return <p>No heatmap levels returned for this range.</p>;
  const prices = cells.map((c) => c.price),
    lo = Math.min(...prices),
    hi = Math.max(...prices),
    max = Math.max(...cells.map((c) => c.volume)),
    width = 530 / Math.max(1, Math.min(20, points.length)),
    step = Math.max(1, 160 / Math.max(1, new Set(prices).size));
  return (
    <section className="om-scalar-chart">
      <h3>{title}</h3>
      <small>
        {focus || 'Hover or focus a level to inspect its price and size.'}
      </small>
      <svg viewBox="0 0 640 220" role="img" aria-label={title + ' heatmap'}>
        {cells.map((c, i) => (
          <rect
            key={i}
            x={20 + c.col * width}
            y={180 - ((c.price - lo) / (hi - lo || 1)) * 155}
            width={Math.max(1, width)}
            height={step}
            fill={
              c.side === 'bids'
                ? '#40dcaf'
                : c.side === 'asks'
                  ? '#f87171'
                  : '#ffc14d'
            }
            opacity={0.12 + (0.88 * Math.log1p(c.volume)) / Math.log1p(max)}
            tabIndex={0}
            onFocus={() =>
              setFocus(
                `${format(c.price)} · ${format(c.volume)} ${unit} · ${new Date(c.time * 1000).toISOString()}`,
              )
            }
            onPointerEnter={() =>
              setFocus(
                `${format(c.price)} · ${format(c.volume)} ${unit} · ${new Date(c.time * 1000).toISOString()}`,
              )
            }
          >
            <title>
              {format(c.price)}: {format(c.volume)} {unit}
            </title>
          </rect>
        ))}
        <text x={560} y={26} fontSize={10} fill="#a9b7c8">
          {format(hi)}
        </text>
        <text x={560} y={180} fontSize={10} fill="#a9b7c8">
          {format(lo)}
        </text>
      </svg>
    </section>
  );
}
function ProfileChart({
  points,
  title,
  tpo,
}: {
  points: Point[];
  title: string;
  tpo: boolean;
}) {
  const [index, setIndex] = useState(0),
    [focus, setFocus] = useState('');
  const point = points[Math.min(index, points.length - 1)];
  const rows: { price: number; value: number }[] = [];
  if (tpo && Array.isArray(point?.levels))
    for (const level of point.levels.slice(0, 2000)) {
      if (
        level &&
        typeof level === 'object' &&
        numeric(level.price) &&
        Array.isArray(level.block_ids)
      )
        rows.push({ price: level.price, value: level.block_ids.length });
    }
  if (!tpo && Array.isArray(point?.profile))
    for (let i = 0; i + 2 < point.profile.length && i < 6000; i += 3) {
      const values = point.profile;
      if (
        numeric(values[i]) &&
        numeric(values[i + 1]) &&
        numeric(values[i + 2])
      )
        rows.push({ price: values[i], value: values[i + 1] + values[i + 2] });
    }
  if (!rows.length) return <p>No profile levels returned for this range.</p>;
  const prices = rows.map((r) => r.price),
    lo = Math.min(...prices),
    hi = Math.max(...prices),
    max = Math.max(1, ...rows.map((r) => r.value)),
    unit = tpo ? 'time blocks' : 'total volume',
    y = (price: number) => 350 - ((price - lo) / (hi - lo || 1)) * 320;
  return (
    <section className="om-scalar-chart">
      <h3>
        {title} · {tpo ? 'TPO' : 'Volume profile'}
      </h3>
      {points.length > 1 && (
        <label>
          Profile interval
          <select
            aria-label="Profile interval"
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
          >
            {points.map((p, i) => (
              <option key={i} value={i}>
                {new Date((p.timestamp?.s || 0) * 1000).toISOString()}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>
        {focus ||
          `${rows.length} price levels · ${unit} · ${new Date((point.timestamp?.s || 0) * 1000).toISOString()}`}
      </p>
      <svg
        viewBox="0 0 640 390"
        role="img"
        aria-label={tpo ? 'TPO price profile' : 'Volume at price profile'}
      >
        {rows.map((row, i) => (
          <rect
            key={i}
            x={20}
            y={y(row.price)}
            width={(row.value / max) * 500}
            height={Math.max(1, 320 / rows.length)}
            fill={tpo ? '#ffc14d' : '#40dcaf'}
            opacity={0.8}
            onPointerEnter={() =>
              setFocus(`${format(row.price)} · ${format(row.value)} ${unit}`)
            }
          >
            <title>
              {format(row.price)}: {format(row.value)} {unit}
            </title>
          </rect>
        ))}
        <text x={540} y={35} fill="#a9b7c8" fontSize={10}>
          {format(hi)}
        </text>
        <text x={540} y={350} fill="#a9b7c8" fontSize={10}>
          {format(lo)}
        </text>
      </svg>
      <small>
        Up to 2,000 returned price levels per interval.{' '}
        {tpo && 'Counts use the returned block IDs.'}
      </small>
    </section>
  );
}
function SeriesView({ result }: { result: Result }) {
  const [index, setIndex] = useState(0),
    [field, setField] = useState('');
  const series = result.data.series[index] || result.data.series[0];
  const points: Point[] = (
    series?.points?.map((p) => (p.Point.TpoAggregation || p.Point) as Point) ||
    []
  ).sort((a, b) => (a.timestamp?.s || 0) - (b.timestamp?.s || 0));
  const fields = [
    ...new Set(
      points.flatMap((point) =>
        Object.keys(point).filter((key) => numeric(point[key])),
      ),
    ),
  ];
  const selectedField = fields.includes(field) ? field : fields[0];
  if (!series || !points.length)
    return (
      <p role="status">
        No OpenMarket points are available for this instrument and range.
      </p>
    );
  if (result.query['transform.groupBy.type'] === 'GROUP_BY_TYPE_SUM')
    return (
      <>
        <ScalarChart
          points={points}
          field="volume"
          title={`${result.query.coin} · Cross-exchange volume (USD)`}
        />
        <p className="om-muted">
          Volume summed across {result.query.exchange}. Aggregated volume does
          not contain price candles.
        </p>
        <details>
          <summary>Inspect returned data</summary>
          <AccountTable data={points} />
        </details>
        <small>
          OpenMarket · observed {new Date(result.observedAt).toISOString()}
        </small>
      </>
    );
  const title = [
      series.id.normalizedSymbol || result.query.rawSymbol || result.query.coin,
      series.id.exchange || result.query.exchange || 'Market-independent',
      series.id.side,
      series.id.tenor,
    ]
      .filter(Boolean)
      .join(' · '),
    seconds =
      result.query.interval === 'MINUTE'
        ? 60
        : result.query.interval === 'DAY'
          ? 86400
          : 3600;
  const candleType = [
    'TRADE_SIDE_AGNOSTIC_AGG',
    'TRADE_AGG',
    'OPEN_INTEREST_AGG',
  ].includes(result.query.type);
  const chart: ComponentProps<typeof OpenMarketCandleChart>['data'] = {
    source: 'OpenMarket',
    kind: result.query.type === 'OPEN_INTEREST_AGG' ? 'open_interest' : 'price',
    instrument: {
      exchange: series.id.exchange || result.query.exchange,
      rawSymbol: series.id.rawSymbol || result.query.rawSymbol,
      normalizedSymbol: title,
      category: series.id.category,
      coin: series.id.coin,
    },
    candles: points.map((point) => ({
      time: point.timestamp?.s || 0,
      open: numeric(point.open) ? point.open : null,
      high: numeric(point.high) ? point.high : null,
      low: numeric(point.low) ? point.low : null,
      close: numeric(point.close) ? point.close : null,
      volume: numeric(point.volume) ? point.volume : null,
    })),
    interval: result.query.interval,
    intervalSeconds: seconds,
    valueUnit:
      result.query.type === 'OPEN_INTEREST_AGG'
        ? series.id.coin || result.query.coin || 'base asset'
        : (series.id.normalizedSymbol || '').split('-')[1] || 'quote asset',
    volumeUnit:
      result.query['transform.normalize.quote'] ||
      series.id.coin ||
      result.query.coin ||
      'base asset',
    observedAt: result.observedAt,
  };
  const heatmap =
    result.query.type !== 'TPO_AGG' &&
    points.some(
      (p) =>
        Array.isArray(p.bids) ||
        Array.isArray(p.asks) ||
        Array.isArray(p.levels),
    );
  return (
    <>
      {result.data.series.length > 1 && (
        <label>
          Data series
          <select
            aria-label="OpenMarket data series"
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
          >
            {result.data.series.map((s, i) => (
              <option key={i} value={i}>
                {s.id.exchange} {s.id.rawSymbol || s.id.coin} {s.id.side}{' '}
                {s.id.tenor}
              </option>
            ))}
          </select>
        </label>
      )}
      {candleType ? (
        <OpenMarketCandleChart data={chart} />
      ) : ['TPO_AGG', 'VOLUME_PROFILE_AGG'].includes(result.query.type) ? (
        <ProfileChart
          points={points}
          title={title}
          tpo={result.query.type === 'TPO_AGG'}
        />
      ) : heatmap ? (
        <Heatmap
          points={points}
          title={title}
          unit={
            result.query['transform.normalize.quote'] ||
            series.id.coin ||
            result.query.coin ||
            'base asset'
          }
        />
      ) : selectedField ? (
        <>
          <label>
            Metric
            <select
              aria-label="OpenMarket metric"
              value={selectedField}
              onChange={(e) => setField(e.target.value)}
            >
              {fields.map((field) => (
                <option key={field}>{field}</option>
              ))}
            </select>
          </label>
          <ScalarChart points={points} field={selectedField} title={title} />
        </>
      ) : null}
      {result.query.type === 'TOKEN_SUPPLY_AGG' &&
        numeric(points.at(-1)?.marketcapDominancePercent) &&
        result.query.coin === 'BTC' && (
          <p>
            Altcoin dominance:{' '}
            {(
              100 - (points.at(-1)!.marketcapDominancePercent as number)
            ).toFixed(3)}
            % (derived from Bitcoin dominance).
          </p>
        )}
      <details>
        <summary>Inspect returned data</summary>
        <AccountTable data={points} />
      </details>
      <small>
        Returned resolution {series.id.interval || result.query.interval} ·
        OpenMarket · observed {new Date(result.observedAt).toISOString()}
      </small>
    </>
  );
}
export function OpenMarketAnalytics({
  coin: defaultCoin = 'BTC',
  defaultOpened = false,
}: {
  coin?: string;
  defaultOpened?: boolean;
}) {
  const [opened, setOpened] = useState(defaultOpened),
    [type, setType] = useState('TRADE_SIDE_AGNOSTIC_AGG'),
    [coin, setCoin] = useState(defaultCoin),
    [markets, setMarkets] = useState<Instrument[]>([]),
    [marketId, setMarketId] = useState(0),
    [interval, setInterval] = useState('HOUR'),
    [blockSize, setBlockSize] = useState(''),
    [tokenName, setTokenName] = useState('Bitcoin'),
    [tenor, setTenor] = useState('ONE_W');
  const [exchanges, setExchanges] = useState('BINANCE_FUTURES,BYBIT,OKEX_SWAP'),
    [depth, setDepth] = useState('100'),
    [resolution, setResolution] = useState('4K'),
    [usd, setUsd] = useState(true);
  const [result, setResult] = useState<Result>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [configured, setConfigured] = useState<boolean>(),
    [revision, setRevision] = useState(0);
  const aggregate = type === 'CROSS_EXCHANGE_VOLUME',
    heatmap = /BOOK_SNAPSHOT|HYPERLIQUID/.test(type);
  const independent =
      aggregate ||
      [
        'TOKEN_SUPPLY_AGG',
        'HYPERLIQUID_LIQUIDATION_AGG',
        'HYPERLIQUID_TRIGGER_LIQUIDITY_AGG',
      ].includes(type),
    options = /OPTION_SUMMARY/.test(type),
    selected = markets[marketId];
  const selection = JSON.stringify([
      opened,
      type,
      coin,
      marketId,
      interval,
      blockSize,
      tokenName,
      tenor,
      revision,
      exchanges,
      depth,
      resolution,
      usd,
    ]),
    current = useRef(selection);
  current.current = selection;
  useEffect(() => {
    if (!opened) return;
    const abort = new AbortController();
    void read('status', abort.signal)
      .then((value) => setConfigured(value.configured))
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause.message);
      });
    return () => abort.abort();
  }, [opened, revision]);
  useEffect(() => {
    setResult(undefined);
    setMarkets([]);
    setMarketId(0);
    setError('');
    setBusy(false);
    if (!opened || !configured || independent) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      void read('markets?' + new URLSearchParams({ type, coin }), abort.signal)
        .then((value) => {
          if (!abort.signal.aborted) {
            setMarkets(value.data.symbols || []);
            const first = value.data.symbols?.[0];
            if (first?.tenor) setTenor(first.tenor);
          }
        })
        .catch((cause) => {
          if (!abort.signal.aborted) setError(cause.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setBusy(false);
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [opened, configured, independent, type, coin, revision]);
  useEffect(() => {
    setResult(undefined);
    setError('');
    setBusy(false);
  }, [
    type,
    coin,
    marketId,
    interval,
    blockSize,
    tokenName,
    tenor,
    exchanges,
    depth,
    resolution,
    usd,
  ]);
  useEffect(() => {
    setBlockSize('');
  }, [type, coin, marketId]);
  const example = (id: string) => {
    setCoin('BTC');
    setUsd(true);
    setBlockSize('');
    setResolution('4K');
    setInterval(id === 'orderbook' || id === 'triggers' ? 'MINUTE' : 'HOUR');
    setDepth(id === 'orderbook' ? '1000' : '100');
    setType(
      id === 'cross-exchange'
        ? 'CROSS_EXCHANGE_VOLUME'
        : id === 'orderbook'
          ? 'BLOCK_BOOK_SNAPSHOT_AGG'
          : id === 'liquidations'
            ? 'HYPERLIQUID_LIQUIDATION_AGG'
            : 'HYPERLIQUID_TRIGGER_LIQUIDITY_AGG',
    );
    if (id === 'cross-exchange')
      setExchanges('BINANCE_FUTURES,BYBIT,OKEX_SWAP');
  };
  const load = async () => {
    const snapshot = current.current;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const seconds =
          interval === 'MINUTE' ? 60 : interval === 'DAY' ? 86400 : 3600,
        period = seconds * (heatmap ? 20 : 96),
        from =
          Math.floor(Date.now() / 1000 / seconds) * seconds - period + seconds;
      const params = new URLSearchParams({
        type: aggregate ? 'TRADE_SIDE_AGNOSTIC_AGG' : type,
        interval,
        from: String(from),
        period: String(period),
      });
      if (independent) params.set('coin', coin);
      else {
        if (!selected?.exchange || !selected?.rawSymbol)
          throw Error('Select a discovered OpenMarket instrument.');
        params.set('exchange', selected.exchange);
        params.set('rawSymbol', selected.rawSymbol);
      }
      if (aggregate) {
        params.set('exchange', exchanges);
        params.set('transform.groupBy.type', 'GROUP_BY_TYPE_SUM');
      }
      if (aggregate || (heatmap && usd))
        params.set('transform.normalize.quote', 'USD');
      if (options) {
        params.set('coin', coin);
        params.set('tenor', tenor);
      }
      if (type === 'TOKEN_SUPPLY_AGG') params.set('tokenName', tokenName);
      if (heatmap) params.set('maxDepth', depth);
      if (type === 'BLOCK_BOOK_SNAPSHOT_AGG') {
        let bucket = blockSize;
        if (!bucket) {
          const value = await read(
            'block-sizes?' +
              new URLSearchParams({
                exchange: selected.exchange,
                rawSymbol: selected.rawSymbol,
                type,
              }),
          );
          if (current.current !== snapshot) return;
          const recommended = value.data.blockSizes?.[0];
          if (!numeric(recommended) || recommended <= 0)
            throw Error(
              'OpenMarket returned no recommended bucket size. Enter a price bucket size.',
            );
          bucket = String(recommended * (resolution === 'HD' ? 5 : 1));
        }
        params.set('blockSize', bucket);
      }
      if (type === 'TPO_AGG') {
        params.set('tpoSession', 'TPO_SESSION_DAILY');
        params.set('tpoBlockSizeMinutes', '30');
        params.set('interval', 'DAY');
        params.set(
          'from',
          String(Math.floor(Date.now() / 1000 / 86400) * 86400 - 86400),
        );
        params.set('period', '86400');
      }
      const value = await read('points?' + params);
      if (current.current === snapshot) setResult(value);
    } catch (cause) {
      if (current.current === snapshot)
        setError(
          cause instanceof Error
            ? cause.message
            : 'OpenMarket data is unavailable.',
        );
    } finally {
      if (current.current === snapshot) setBusy(false);
    }
  };
  return (
    <details
      className="om-analytics om-box"
      open={opened}
      onToggle={(e) => setOpened(e.currentTarget.open)}
    >
      <summary>
        <b>OpenMarket data</b> · Heatmaps, funding, profiles &amp; options
      </summary>
      {opened && (
        <>
          <div className="om-order-grid">
            <label>
              Quick examples
              <select
                aria-label="OpenMarket quick example"
                defaultValue=""
                onChange={(e) => {
                  example(e.target.value);
                  e.currentTarget.value = '';
                }}
              >
                <option value="" disabled>
                  Choose an example
                </option>
                <option value="cross-exchange">
                  Cross-exchange BTC volume
                </option>
                <option value="orderbook">4K orderbook · 1,000 levels</option>
                <option value="liquidations">
                  Liquidations by price level
                </option>
                <option value="triggers">TP / SL trigger heatmap</option>
              </select>
            </label>
            <label>
              Dataset
              <select
                aria-label="OpenMarket dataset"
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  if (e.target.value === 'TOKEN_SUPPLY_AGG') setCoin('BTC');
                }}
              >
                {types.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Coin
              <input
                aria-label="OpenMarket data coin"
                value={coin}
                maxLength={80}
                onChange={(e) => setCoin(e.target.value.toUpperCase())}
              />
            </label>
            {aggregate && (
              <label>
                Exchanges
                <input
                  aria-label="OpenMarket volume exchanges"
                  value={exchanges}
                  maxLength={404}
                  onChange={(e) => setExchanges(e.target.value.toUpperCase())}
                />
                <small>
                  Two to five exchange IDs, separated by commas · volume in USD
                </small>
              </label>
            )}
            {!independent && (
              <label>
                Discovered instrument
                <select
                  aria-label="OpenMarket dataset instrument"
                  value={marketId}
                  onChange={(e) => setMarketId(Number(e.target.value))}
                >
                  <option value={-1} disabled>
                    {busy ? 'Discovering…' : 'Select an instrument'}
                  </option>
                  {markets.map((m, i) => (
                    <option key={i} value={i}>
                      {m.rawSymbol} · {m.exchange} · {m.tenor || m.category}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Interval
              <select
                aria-label="OpenMarket dataset interval"
                value={type === 'TPO_AGG' ? 'DAY' : interval}
                disabled={type === 'TPO_AGG'}
                onChange={(e) => setInterval(e.target.value)}
              >
                <option value="MINUTE">1 minute</option>
                <option value="HOUR">1 hour</option>
                <option value="DAY">1 day</option>
              </select>
            </label>
            {heatmap && (
              <>
                <label>
                  Price levels
                  <input
                    type="number"
                    min="1"
                    max="1000"
                    aria-label="Heatmap depth"
                    value={depth}
                    onChange={(e) => setDepth(e.target.value)}
                  />
                </label>
                <label>
                  Volume units
                  <select
                    aria-label="Heatmap volume units"
                    value={usd ? 'USD' : 'COIN'}
                    onChange={(e) => setUsd(e.target.value === 'USD')}
                  >
                    <option value="USD">USD</option>
                    <option value="COIN">Base coin</option>
                  </select>
                </label>
              </>
            )}
            {type === 'BLOCK_BOOK_SNAPSHOT_AGG' && (
              <>
                <label>
                  Resolution
                  <select
                    aria-label="Heatmap resolution"
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    <option value="4K">4K · finest buckets</option>
                    <option value="HD">HD · wider buckets</option>
                  </select>
                </label>
                <label>
                  Custom price bucket size
                  <input
                    aria-label="Heatmap block size"
                    placeholder="Recommended automatically"
                    value={blockSize}
                    inputMode="decimal"
                    onChange={(e) => setBlockSize(e.target.value)}
                  />
                </label>
              </>
            )}
            {options && (
              <label>
                Discovered tenor
                <input
                  aria-label="Option tenor"
                  value={tenor}
                  onChange={(e) => setTenor(e.target.value)}
                />
              </label>
            )}
            {type === 'TOKEN_SUPPLY_AGG' && (
              <label>
                Token name
                <input
                  aria-label="Dominance token name"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                />
              </label>
            )}
          </div>
          <button
            disabled={
              busy || configured !== true || (!independent && !selected)
            }
            onClick={() => void load()}
          >
            {busy ? 'Loading…' : 'Load dataset'}
          </button>
          <button disabled={busy} onClick={() => setRevision((r) => r + 1)}>
            Refresh instruments
          </button>
          {configured === false && (
            <p role="status">OpenMarket data is not configured yet.</p>
          )}
          {!independent && configured && !busy && !markets.length && !error && (
            <p>No instruments are available for this dataset and coin.</p>
          )}
          {error && (
            <p className="om-error" role="alert">
              {error}
            </p>
          )}
          {result && (
            <SeriesView key={JSON.stringify(result.query)} result={result} />
          )}
          <p className="om-muted">
            Each dataset uses the exact discovered instrument or coin. Advanced
            datasets depend on your OpenMarket plan. Heatmaps load on request.
          </p>
        </>
      )}
    </details>
  );
}
export function PolymarketAnalytics() {
  const [view, setView] = useState('leaderboard'),
    [wallet, setWallet] = useState(''),
    [condition, setCondition] = useState(''),
    [rank, setRank] = useState('TRADING_PNL'),
    [cumulative, setCumulative] = useState(false),
    [offset, setOffset] = useState(0),
    [result, setResult] = useState<unknown>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [observedAt, setObservedAt] = useState<number>();
  const [winRate, setWinRate] = useState(''),
    [minTrades, setMinTrades] = useState(''),
    [maxTrades, setMaxTrades] = useState(''),
    [category, setCategory] = useState(''),
    [openPositions, setOpenPositions] = useState(''),
    [sortBy, setSortBy] = useState('REALIZED_PNL'),
    [direction, setDirection] = useState('SORT_DIRECTION_DESC'),
    [limit, setLimit] = useState('20');
  const pageSize = Number(limit),
    paginated = ['leaderboard', 'positions'].includes(view);
  const selection = JSON.stringify([
      view,
      wallet,
      condition,
      rank,
      cumulative,
      winRate,
      minTrades,
      maxTrades,
      category,
      openPositions,
      sortBy,
      direction,
      limit,
    ]),
    current = useRef(selection);
  current.current = selection;
  useEffect(() => {
    setResult(undefined);
    setError('');
    setOffset(0);
    setBusy(false);
  }, [selection]);
  const example = (id: string) => {
    setView('leaderboard');
    setWinRate('');
    setMinTrades('');
    setMaxTrades('');
    setCategory('');
    setOpenPositions('');
    setSortBy('REALIZED_PNL');
    setDirection('SORT_DIRECTION_DESC');
    setLimit('20');
    if (id === 'politics') {
      setWinRate('90');
      setMaxTrades('20');
      setCategory('Politics');
    }
    if (id === 'roi') {
      setWinRate('70');
      setMinTrades('50');
      setSortBy('ROI');
      setLimit('10');
    }
    if (id === 'open') {
      setOpenPositions('5');
      setSortBy('TOTAL_SIZE');
    }
    if (id === 'active') {
      setMinTrades('5000');
      setWinRate('55');
      setSortBy('TOTAL_POSITION_COUNT');
    }
  };
  const run = async (page = offset) => {
    const snapshot = current.current;
    setBusy(true);
    setError('');
    setResult(undefined);
    try {
      const params = new URLSearchParams();
      if (paginated) {
        params.set('limit', limit);
        params.set('offset', String(page));
      }
      if (view === 'leaderboard') {
        for (const [key, value] of Object.entries({
          winRate,
          minTotalTradeCount: minTrades,
          maxTotalTradeCount: maxTrades,
          primaryCategory: category,
          openPositionCount: openPositions,
          sortBy,
          sortDirection: direction,
        }))
          if (value !== '') params.set(key, value);
      }
      if (
        ['trader-profile', 'user-categories', 'positions'].includes(view) &&
        wallet
      )
        params.set('userWallet', wallet);
      if (['market-summary', 'positions'].includes(view) && condition)
        params.set('conditionId', condition);
      if (view === 'platform-distribution') {
        params.set(
          'distributionRankBy',
          'POLYMARKET_DISTRIBUTION_RANK_BY_' + rank,
        );
        params.set(
          'distributionBandPreset',
          'POLYMARKET_DISTRIBUTION_BAND_PRESET_DECILES',
        );
        params.set('distributionCumulative', String(cumulative));
      }
      const value = await read(view + '?' + params),
        data = value.data;
      if (current.current !== snapshot) return;
      setResult(
        data.traderProfiles ||
          data.traderProfile ||
          data.userPositions ||
          data.marketSummary ||
          data.userCategories ||
          data.platformSummary ||
          data.platformDistribution?.distribution_bands ||
          data.platformDistribution?.distribution_cumulative ||
          data,
      );
      setObservedAt(value.observedAt);
      setOffset(page);
    } catch (cause) {
      if (current.current === snapshot)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Polymarket analytics are unavailable.',
        );
    } finally {
      if (current.current === snapshot) setBusy(false);
    }
  };
  return (
    <>
      <h2>Polymarket analytics</h2>
      <p className="om-muted">
        OpenMarket analytics · trading PnL by default · research only.
      </p>
      <div className="om-order-grid">
        <label>
          Quick examples
          <select
            aria-label="Polymarket quick example"
            defaultValue=""
            onChange={(e) => {
              example(e.target.value);
              e.currentTarget.value = '';
            }}
          >
            <option value="" disabled>
              Choose an example
            </option>
            <option value="politics">Politics · 90%+ win rate</option>
            <option value="roi">Top 10 by ROI</option>
            <option value="open">Open positions by size</option>
            <option value="active">High-activity wallets</option>
          </select>
        </label>
        <label>
          View
          <select
            aria-label="Polymarket analytics view"
            value={view}
            onChange={(e) => setView(e.target.value)}
          >
            {[
              'leaderboard',
              'trader-profile',
              'positions',
              'market-summary',
              'user-categories',
              'platform-summary',
              'platform-distribution',
            ].map((v) => (
              <option key={v} value={v}>
                {v.replaceAll('-', ' ')}
              </option>
            ))}
          </select>
        </label>
        {view === 'leaderboard' && (
          <>
            <label>
              Minimum win rate (%)
              <input
                type="number"
                min="0"
                max="100"
                step="any"
                aria-label="Polymarket minimum win rate"
                value={winRate}
                onChange={(e) => setWinRate(e.target.value)}
              />
            </label>
            <label>
              Minimum trade count
              <input
                type="number"
                min="0"
                aria-label="Polymarket minimum trades"
                value={minTrades}
                onChange={(e) => setMinTrades(e.target.value)}
              />
            </label>
            <label>
              Maximum trade count
              <input
                type="number"
                min="0"
                aria-label="Polymarket maximum trades"
                value={maxTrades}
                onChange={(e) => setMaxTrades(e.target.value)}
              />
            </label>
            <label>
              Category
              <input
                aria-label="Polymarket category"
                placeholder="All categories"
                maxLength={80}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              />
            </label>
            <label>
              Minimum open positions
              <input
                type="number"
                min="0"
                aria-label="Polymarket minimum open positions"
                value={openPositions}
                onChange={(e) => setOpenPositions(e.target.value)}
              />
            </label>
            <label>
              Sort by
              <select
                aria-label="Polymarket leaderboard sort"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
              >
                {[
                  'REALIZED_PNL',
                  'ROI',
                  'WIN_COUNT',
                  'WIN_RATE',
                  'TOTAL_SIZE',
                  'TOTAL_POSITION_COUNT',
                  'LAST_OPEN_TS',
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label>
              Sort direction
              <select
                aria-label="Polymarket sort direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value)}
              >
                <option value="SORT_DIRECTION_DESC">Highest first</option>
                <option value="SORT_DIRECTION_ASC">Lowest first</option>
              </select>
            </label>
          </>
        )}
        {paginated && (
          <label>
            Rows per page
            <input
              type="number"
              min="1"
              max="100"
              aria-label="Polymarket page size"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </label>
        )}
        {['trader-profile', 'user-categories', 'positions'].includes(view) && (
          <label>
            Wallet
            <input
              aria-label="Polymarket wallet"
              placeholder="0x…"
              maxLength={42}
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
            />
          </label>
        )}
        {['market-summary', 'positions'].includes(view) && (
          <label>
            Condition ID
            <input
              aria-label="Polymarket condition ID"
              placeholder="0x…"
              maxLength={66}
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            />
          </label>
        )}
        {view === 'platform-distribution' && (
          <>
            <label>
              Rank by
              <select
                aria-label="Polymarket distribution rank"
                value={rank}
                onChange={(e) => setRank(e.target.value)}
              >
                {[
                  'TRADING_PNL',
                  'TRADE_COUNT',
                  'POSITION_COUNT',
                  'TOTAL_SIZE',
                  'TOTAL_COST_BASIS',
                ].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="om-check">
              <input
                type="checkbox"
                checked={cumulative}
                onChange={(e) => setCumulative(e.target.checked)}
              />
              Cumulative concentration
            </label>
          </>
        )}
      </div>
      <button disabled={busy} onClick={() => void run()}>
        {busy ? 'Loading…' : 'Load analytics'}
      </button>
      {error && (
        <p role="alert" className="om-error">
          {error}
        </p>
      )}
      {result !== undefined && (
        <>
          <AccountTable data={result} />
          {observedAt && (
            <small>
              OpenMarket · observed {new Date(observedAt).toISOString()}
            </small>
          )}
        </>
      )}
      {paginated && result !== undefined && (
        <div className="om-row">
          <button
            disabled={busy || offset === 0}
            onClick={() => void run(Math.max(0, offset - pageSize))}
          >
            Previous
          </button>
          <span>Offset {offset}</span>
          <button
            disabled={
              busy ||
              offset + pageSize * 2 > 10000 ||
              (Array.isArray(result) && result.length < pageSize)
            }
            onClick={() => void run(offset + pageSize)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
