export class OpenMarketError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
type Validator = (value: string) => boolean;
type Point = Record<string, unknown> & {
  timestamp?: { s?: number; seconds?: number };
  TpoAggregation?: Point;
};
type ProviderData = Record<string, unknown> & {
  series?: { id: Record<string, string>; points: { Point: Point }[] }[];
};
type Snapshot = { data: ProviderData; observedAt: number };
const TYPES = [
  'TRADE_SIDE_AGNOSTIC_AGG',
  'TRADE_AGG',
  'OPEN_INTEREST_AGG',
  'FUNDING_RATE_AGG',
  'TOKEN_SUPPLY_AGG',
  'IMPLIED_VOLATILITY_OPTION_SUMMARY_AGG',
  'SKEW_OPTION_SUMMARY_AGG',
  'LIQUIDATION_AGG',
  'VOLUME_PROFILE_AGG',
  'TPO_AGG',
  'BLOCK_BOOK_SNAPSHOT_AGG',
  'HYPERLIQUID_LIQUIDATION_AGG',
  'HYPERLIQUID_TRIGGER_LIQUIDITY_AGG',
];
const INTERVALS: Record<string, number> = {
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
};
const fail = (status: number, message: string) =>
  new OpenMarketError(status, message);
const identifier = (value: string) => /^[A-Za-z0-9_.:/-]{1,80}$/.test(value);
const number =
  (min: number, max: number, integer = true): Validator =>
  (value) =>
    /^\d+(?:\.\d+)?$/.test(value) &&
    Number.isFinite(Number(value)) &&
    (!integer || Number.isSafeInteger(Number(value))) &&
    Number(value) >= min &&
    Number(value) <= max;
const fields: Record<string, Validator> = {
  type: (v) => TYPES.includes(v),
  exchange: identifier,
  rawSymbol: identifier,
  coin: identifier,
  interval: (v) => Object.hasOwn(INTERVALS, v),
  from: number(0, 9999999999),
  period: number(1, 17280000),
  tenor: identifier,
  tokenName: (v) => /^[A-Za-z0-9 ._-]{1,80}$/.test(v),
  blockSize: number(0.000000001, 1000000, false),
  maxDepth: number(1, 1000),
  tpoSession: (v) => v === 'TPO_SESSION_DAILY',
  tpoBlockSizeMinutes: number(1, 60),
  'transform.normalize.quote': (v) => v === 'USD',
  'transform.groupBy.type': (v) => v === 'GROUP_BY_TYPE_SUM',
};
const analytics = new Set([
  'leaderboard',
  'trader-profile',
  'positions',
  'market-summary',
  'user-categories',
  'platform-summary',
  'platform-distribution',
]);
const weights: Record<string, number> = {
  VOLUME_PROFILE_AGG: 2,
  TPO_AGG: 5,
  BLOCK_BOOK_SNAPSHOT_AGG: 10,
  HYPERLIQUID_LIQUIDATION_AGG: 5,
  HYPERLIQUID_TRIGGER_LIQUIDITY_AGG: 5,
};
const analyticsFields: Record<string, Validator> = {
  limit: number(1, 100),
  offset: number(0, 9900),
  userWallet: (v) => /^0x[0-9a-fA-F]{40}$/.test(v),
  conditionId: (v) => /^0x[0-9a-fA-F]{64}$/.test(v),
  distributionRankBy: (v) =>
    /^POLYMARKET_DISTRIBUTION_RANK_BY_(TRADING_PNL|TRADE_COUNT|POSITION_COUNT|AVG_OPEN_INVESTMENT|AVG_HOLDING_DURATION|WIN_RATE|TOTAL_SIZE|TOTAL_COST_BASIS)$/.test(
      v,
    ),
  distributionBandPreset: (v) =>
    /^POLYMARKET_DISTRIBUTION_BAND_PRESET_(DECILES|SYMMETRIC_PERCENTILE)$/.test(
      v,
    ),
  distributionCumulative: (v) => ['true', 'false'].includes(v),
  distributionMinPositions: number(0, 100000),
};
const sortDirection: Validator = (v) =>
  ['SORT_DIRECTION_ASC', 'SORT_DIRECTION_DESC'].includes(v);
const leaderboardFields: Record<string, Validator> = {
  winRate: number(0, 100, false),
  minTotalTradeCount: number(0, 100000000),
  maxTotalTradeCount: number(0, 100000000),
  openPositionCount: number(0, 100000000),
  primaryCategory: (v) => /^[A-Za-z0-9 &/_-]{1,80}$/.test(v),
  sortBy: (v) =>
    [
      'REALIZED_PNL',
      'ROI',
      'WIN_COUNT',
      'WIN_RATE',
      'TOTAL_SIZE',
      'TOTAL_POSITION_COUNT',
      'LAST_OPEN_TS',
    ].includes(v),
  sortDirection,
};
export function createOpenMarketService({
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
}: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}) {
  const cache = new Map<string, { value: Snapshot; until: number }>(),
    pending = new Map<string, Promise<Snapshot>>();
  let budget = { until: 0, count: 0 };
  async function get(path: string, params: URLSearchParams): Promise<Snapshot> {
    const key = path + '?' + params,
      prior = cache.get(key);
    if (prior && prior.until > now()) return prior.value;
    if (pending.has(key)) return pending.get(key)!;
    if (pending.size >= 8)
      throw fail(429, 'OpenMarket analytics are busy. Retry shortly.');
    const task = (async () => {
      const response = await fetchImpl('https://api.openmarket.xyz/v1/' + key, {
        headers: {
          'X-OpenMarket-Key': env.OPENMARKET_API_KEY!.trim(),
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
      });
      if (!response.ok)
        throw fail(
          response.status === 429 ? 429 : response.status === 403 ? 403 : 502,
          response.status === 401
            ? 'OpenMarket could not authorize the connection. Check the server Data API key.'
            : response.status === 403
              ? 'This OpenMarket dataset is unavailable with the current API plan or permissions.'
              : response.status === 429
                ? 'OpenMarket quota reached. Retry shortly.'
                : 'OpenMarket data is temporarily unavailable.',
        );
      const reader = response.body?.getReader();
      if (!reader) throw fail(502, 'OpenMarket returned no data.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > 4000000)
            throw fail(502, 'Choose a smaller OpenMarket data range.');
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      let value: ProviderData;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw fail(502, 'OpenMarket returned an invalid response.');
      }
      const snapshot = { data: value, observedAt: now() };
      cache.set(key, { value: snapshot, until: now() + 30000 });
      if (cache.size > 100) cache.delete(cache.keys().next().value!);
      return snapshot;
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  }
  return {
    async read(route: string, input = new URLSearchParams()) {
      const url = { searchParams: input };
      try {
        if (route === 'status')
          return {
            configured: !!env.OPENMARKET_API_KEY?.trim(),
            types: TYPES,
            source: 'OpenMarket',
            indicatorAccessConfigured: false,
          };
        if (
          !['points', 'markets', 'block-sizes'].includes(route) &&
          !analytics.has(route)
        )
          throw fail(404, 'Unknown OpenMarket data endpoint.');
        if (!env.OPENMARKET_API_KEY?.trim())
          throw fail(503, 'OpenMarket data is not configured yet.');
        const schema: Record<string, Validator> = analytics.has(route)
          ? {
              ...analyticsFields,
              ...(route === 'leaderboard' ? leaderboardFields : {}),
            }
          : route === 'markets'
            ? { type: fields.type, coin: fields.coin }
            : route === 'block-sizes'
              ? {
                  exchange: fields.exchange,
                  rawSymbol: fields.rawSymbol,
                  type: (v) => v === 'BLOCK_BOOK_SNAPSHOT_AGG',
                }
              : fields;
        const params = new URLSearchParams();
        // The examples use comma-separated venues; the provider requires repeated
        // exchange parameters. Only an explicit volume aggregation may repeat them.
        const aggregate =
          route === 'points' &&
          url.searchParams.get('transform.groupBy.type') ===
            'GROUP_BY_TYPE_SUM';
        const exchanges = aggregate
          ? url.searchParams
              .getAll('exchange')
              .flatMap((value) => value.split(',').map((v) => v.trim()))
              .sort()
          : url.searchParams.getAll('exchange');
        for (const [key, value] of url.searchParams) {
          if (key === 'exchange' && aggregate) continue;
          if (
            params.has(key) ||
            !Object.hasOwn(schema, key) ||
            !schema[key](value)
          )
            throw fail(400, 'Invalid OpenMarket data parameters.');
          params.set(key, value);
        }
        if (aggregate) {
          if (
            exchanges.length < 2 ||
            exchanges.length > 5 ||
            new Set(exchanges).size !== exchanges.length ||
            !exchanges.every(identifier)
          )
            throw fail(
              400,
              'Choose two to five different OpenMarket exchanges.',
            );
          for (const exchange of exchanges) params.append('exchange', exchange);
        }
        if (route === 'points') {
          const type = params.get('type'),
            interval = params.get('interval'),
            seconds = INTERVALS[interval || ''];
          if (!type || !seconds || !params.has('from') || !params.has('period'))
            throw fail(
              400,
              'OpenMarket data needs a type, interval, and time range.',
            );
          const independent = [
            'TOKEN_SUPPLY_AGG',
            'HYPERLIQUID_LIQUIDATION_AGG',
            'HYPERLIQUID_TRIGGER_LIQUIDITY_AGG',
          ].includes(type);
          if (aggregate) {
            if (
              !['TRADE_SIDE_AGNOSTIC_AGG', 'TRADE_AGG'].includes(type) ||
              !params.has('coin') ||
              params.has('rawSymbol')
            )
              throw fail(
                400,
                'Cross-exchange volume needs a candle dataset and coin, without a venue-specific symbol.',
              );
            params.set('transform.normalize.quote', 'USD');
          } else if (
            independent
              ? !params.has('coin') ||
                params.has('exchange') ||
                params.has('rawSymbol')
              : !params.has('exchange') || !params.has('rawSymbol')
          )
            throw fail(
              400,
              'Select the exact OpenMarket venue and instrument, or coin for market-independent data.',
            );
          if (
            /OPTION_SUMMARY/.test(type) &&
            (!params.has('coin') || !params.has('tenor'))
          )
            throw fail(
              400,
              'Discover an option summary symbol and tenor first.',
            );
          const heatmap = /BOOK_SNAPSHOT|HYPERLIQUID/.test(type);
          if (
            Number(params.get('period')) > seconds * (heatmap ? 20 : 200) ||
            Number(params.get('from')) > now() / 1000 ||
            Number(params.get('from')) + Number(params.get('period')) >
              now() / 1000 + seconds
          )
            throw fail(
              400,
              'Choose a bounded past range: up to 200 candles or 20 heatmap snapshots.',
            );
          if (type === 'BLOCK_BOOK_SNAPSHOT_AGG' && !params.has('blockSize'))
            throw fail(400, 'Select an orderbook price block size.');
          if (heatmap && !params.has('maxDepth')) params.set('maxDepth', '100');
        }
        if (route === 'markets') {
          if (!params.has('type'))
            throw fail(400, 'Select a dataset to discover instruments.');
          params.set('pageSize', '20');
          params.set('pageOffset', '0');
        }
        if (
          route === 'block-sizes' &&
          (!params.has('exchange') || !params.has('rawSymbol'))
        )
          throw fail(400, 'Select an instrument first.');
        if (
          ['trader-profile', 'user-categories'].includes(route) &&
          !params.has('userWallet')
        )
          throw fail(400, 'Enter a Polymarket wallet address.');
        if (route === 'market-summary' && !params.has('conditionId'))
          throw fail(400, 'Enter the Polymarket condition ID.');
        if (
          route === 'positions' &&
          !params.has('userWallet') &&
          !params.has('conditionId')
        )
          throw fail(400, 'Enter a wallet or condition ID.');
        if (
          route === 'platform-distribution' &&
          (!params.has('distributionRankBy') ||
            !params.has('distributionBandPreset'))
        )
          throw fail(400, 'Choose a distribution rank and band preset.');
        if (route === 'leaderboard') {
          if (
            params.has('minTotalTradeCount') &&
            params.has('maxTotalTradeCount') &&
            Number(params.get('minTotalTradeCount')) >
              Number(params.get('maxTotalTradeCount'))
          )
            throw fail(400, 'Minimum trade count must not exceed the maximum.');
          if (
            params.has('conditionId') &&
            (params.has('primaryCategory') || params.get('sortBy') === 'ROI')
          )
            throw fail(
              400,
              'A market-scoped leaderboard cannot filter by category or sort by ROI.',
            );
        }
        if (
          analytics.has(route) &&
          Number(params.get('offset') || 0) +
            Number(params.get('limit') || 20) >
            10000
        )
          throw fail(400, 'Polymarket pagination exceeds 10,000 rows.');
        const weight =
          (weights[params.get('type') || ''] || 1) *
          (aggregate ? exchanges.length : 1);
        if (budget.until <= now()) budget = { until: now() + 60000, count: 0 };
        if (budget.count + weight > 100)
          throw fail(
            429,
            'OpenMarket data request limit reached. Retry shortly.',
          );
        budget.count += weight;
        params.sort();
        const { data, observedAt } = await get(
          analytics.has(route) ? 'polymarket/analytics/' + route : route,
          params,
        );
        if (route === 'points') {
          if (!Array.isArray(data.series))
            throw fail(502, 'OpenMarket returned an invalid series.');
          for (const series of data.series) {
            if (
              !series?.id ||
              !Array.isArray(series.points) ||
              series.points.some(
                (point) => !point?.Point || typeof point.Point !== 'object',
              )
            )
              throw fail(502, 'OpenMarket returned an invalid series.');
            if (
              series.id.type !== params.get('type') ||
              (params.get('type') !== 'TPO_AGG' &&
                series.id.interval &&
                series.id.interval !== params.get('interval')) ||
              (aggregate
                ? ['coin']
                : ['exchange', 'rawSymbol', 'coin', 'tenor', 'tokenName']
              ).some(
                (field) =>
                  series.id[field] &&
                  params.has(field) &&
                  series.id[field] !== params.get(field),
              )
            )
              throw fail(
                502,
                'OpenMarket returned a different instrument or dataset.',
              );
          }
        }
        // The provider can include the candle at the inclusive upper boundary.
        // Keep the displayed data inside the requested half-open time range.
        const displayed =
          route === 'points'
            ? {
                ...data,
                series: (data.series || []).map((series) => ({
                  ...series,
                  points: series.points.filter((point) => {
                    const stamp = (point.Point.TpoAggregation || point.Point)
                      .timestamp;
                    const seconds = stamp?.s ?? stamp?.seconds;
                    return (
                      typeof seconds === 'number' &&
                      Number.isFinite(seconds) &&
                      seconds >= Number(params.get('from')) &&
                      seconds <
                        Number(params.get('from')) +
                          Number(params.get('period'))
                    );
                  }),
                })),
              }
            : data;
        return {
          data: displayed,
          source: 'OpenMarket',
          observedAt,
          query: {
            ...Object.fromEntries(params),
            ...(aggregate ? { exchange: exchanges.join(',') } : {}),
          },
        };
      } catch (error) {
        if (error instanceof OpenMarketError) throw error;
        throw fail(502, 'OpenMarket data is unavailable or timed out.');
      }
    },
  };
}

export type OpenMarketService = ReturnType<typeof createOpenMarketService>;
// Shared cache and provider budget span all authenticated user workspaces.
export const openMarketService = createOpenMarketService();
