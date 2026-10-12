import { useMemo, useState } from 'react';
type Candle = {
  time: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume?: number | null;
};
type Instrument = {
  exchange: string;
  rawSymbol: string;
  normalizedSymbol: string;
  category?: string;
  coin?: string;
};
type ChartData = {
  source: string;
  sourceUrl?: string;
  kind: string;
  instrument: Instrument;
  candles: Candle[];
  interval: string;
  intervalSeconds: number;
  valueUnit: string;
  volumeUnit: string;
  observedAt: number;
  observedAtIso?: string;
  message?: string;
};
const value = (number: number | null | undefined) =>
  number == null || !Number.isFinite(number)
    ? 'Unavailable'
    : number.toLocaleString(undefined, { maximumSignificantDigits: 7 });
const utc = (time: number) =>
  new Date(time * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('.000Z', ' UTC');
export function OpenMarketCandleChart({ data }: { data: ChartData }) {
  const points = useMemo(
    () =>
      data.candles
        .filter(
          (p) =>
            Number.isFinite(p.time) &&
            [p.open, p.high, p.low, p.close].some(
              (n) => n !== null && Number.isFinite(n),
            ),
        )
        .slice(-200),
    [data.candles],
  );
  const [hover, setHover] = useState<number>();
  if (!points.length)
    return (
      <p className="sg-chart-empty" role="status">
        {data.message ||
          `No ${data.source} candles are available for this instrument and range.`}
      </p>
    );
  const index = Math.min(hover ?? points.length - 1, points.length - 1),
    focused = points[index];
  const finite = points.flatMap((p) =>
    [p.open, p.high, p.low, p.close].filter(
      (n): n is number => n !== null && Number.isFinite(n),
    ),
  );
  const min = Math.min(...finite),
    max = Math.max(...finite),
    padding = (max - min || Math.abs(max) * 0.01 || 1) * 0.07,
    range = max - min + padding * 2;
  const y = (n: number) => 180 - ((n - min + padding) / range) * 155,
    x = (i: number) => 18 + ((i + 0.5) / points.length) * 572;
  const maxVolume = Math.max(1, ...points.map((p) => p.volume ?? 0));
  const unit = data.valueUnit;
  return (
    <section
      className="sg-chart sg-om-chart"
      aria-label={
        data.kind === 'open_interest'
          ? 'Interactive open-interest chart'
          : data.kind === 'liquidity'
            ? 'Interactive liquidity chart'
            : 'Interactive price chart'
      }
    >
      <div className="sg-om-heading">
        <strong>
          {data.instrument.normalizedSymbol} ·{' '}
          {data.kind === 'open_interest'
            ? 'Open interest'
            : data.kind === 'liquidity'
              ? 'Liquidity'
              : 'Candles'}
        </strong>
        <small>
          {data.interval === 'MINUTE'
            ? '1m'
            : data.interval === 'DAY'
              ? '1d'
              : data.interval === 'HOUR'
                ? '1h'
                : data.interval}{' '}
          · {data.instrument.exchange} · {data.instrument.category}
        </small>
      </div>
      <div className="sg-om-ohlc">
        <span>O {value(focused.open)}</span>
        <span>H {value(focused.high)}</span>
        <span>L {value(focused.low)}</span>
        <span>C {value(focused.close)}</span>
        <small>{unit}</small>
      </div>
      <small>
        {utc(focused.time)}
        {data.intervalSeconds > 0 &&
          ` · ${focused.time + data.intervalSeconds > data.observedAt / 1000 ? 'Forming candle' : 'Closed candle'}`}
        {data.kind === 'price' &&
          ` · Volume ${value(focused.volume)} ${data.volumeUnit}`}
      </small>
      <svg
        viewBox="0 0 680 260"
        role="img"
        tabIndex={0}
        aria-label={`${data.instrument.normalizedSymbol} ${data.source} ${data.kind === 'open_interest' ? 'open interest' : data.kind === 'liquidity' ? 'liquidity OHLC' : 'OHLCV candlestick'} chart. Use arrow keys to inspect candles.`}
        onKeyDown={(e) => {
          if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            setHover(
              Math.max(
                0,
                Math.min(
                  points.length - 1,
                  index + (e.key === 'ArrowLeft' ? -1 : 1),
                ),
              ),
            );
          }
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.floor(
                  ((((e.clientX - rect.left) / rect.width) * 680) / 572) *
                    points.length,
                ),
              ),
            ),
          );
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        {[0, 0.33, 0.66, 1].map((f) => {
          const n = min - padding + range * f;
          return (
            <g key={f}>
              <line x1={18} x2={595} y1={y(n)} y2={y(n)} stroke="#ffffff10" />
              <text x={603} y={y(n) + 3} fill="#9ca6ad" fontSize={9}>
                {value(n)}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const color =
            p.open !== null && p.close !== null && p.close < p.open
              ? '#ed9298'
              : '#14f195';
          const full = [p.open, p.high, p.low, p.close].every(
            (n) => n !== null && Number.isFinite(n),
          );
          return (
            <g key={p.time} data-candle-time={p.time} stroke={color}>
              {full ? (
                <>
                  <line x1={x(i)} x2={x(i)} y1={y(p.high!)} y2={y(p.low!)} />
                  <rect
                    x={x(i) - Math.max(1, Math.min(8, 450 / points.length)) / 2}
                    y={Math.min(y(p.open!), y(p.close!))}
                    width={Math.max(1, Math.min(8, 450 / points.length))}
                    height={Math.max(1, Math.abs(y(p.open!) - y(p.close!)))}
                    fill={color}
                  />
                </>
              ) : p.close !== null ? (
                <circle cx={x(i)} cy={y(p.close)} r={2} fill={color} />
              ) : null}
              {data.kind === 'price' &&
                p.volume !== null &&
                p.volume !== undefined && (
                  <rect
                    x={x(i) - 2}
                    y={233 - (p.volume / maxVolume) * 35}
                    width={Math.max(1, Math.min(6, 450 / points.length))}
                    height={(p.volume / maxVolume) * 35}
                    fill={color}
                    opacity={0.45}
                    stroke="none"
                  />
                )}
            </g>
          );
        })}
        {hover !== undefined && (
          <line
            x1={x(index)}
            x2={x(index)}
            y1={20}
            y2={235}
            stroke="#ffffff75"
            strokeDasharray="3 3"
          />
        )}
        <text x={18} y={252} fill="#8d99a1" fontSize={9}>
          {utc(points[0].time).slice(0, 16)}
        </text>
        <text x={590} y={252} textAnchor="end" fill="#8d99a1" fontSize={9}>
          {utc(points.at(-1)!.time).slice(0, 16)} UTC
        </text>
      </svg>
      <p className="sg-om-source">
        <a
          href={data.sourceUrl || 'https://openmarket.xyz'}
          target="_blank"
          rel="noreferrer"
        >
          {data.source} ↗
        </a>
        <span>
          Observed{' '}
          {data.observedAtIso || new Date(data.observedAt).toISOString()}
        </span>
      </p>
    </section>
  );
}

const display = (value: unknown) =>
  value == null
    ? '—'
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
export function AccountTable({ data }: { data: unknown }) {
  if (!data || typeof data !== 'object') return <p>No rows returned.</p>;
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? data
    : Object.entries(data).map(([asset, value]) =>
        typeof value === 'object' && value && !Array.isArray(value)
          ? { asset, ...value }
          : { field: asset, value },
      );
  if (!rows.length) return <p>No rows returned.</p>;
  const keys = [
    ...new Set(rows.slice(0, 100).flatMap((row) => Object.keys(row || {}))),
  ].slice(0, 14);
  return (
    <div className="om-table-scroll">
      <table>
        <thead>
          <tr>
            {keys.map((key) => (
              <th key={key}>
                {key.replace(/([A-Z])/g, ' $1').replaceAll('_', ' ')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((row, i) => (
            <tr key={i}>
              {keys.map((key) => (
                <td key={key}>{display(row[key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 100 && <small>Showing the first 100 returned rows.</small>}
    </div>
  );
}
