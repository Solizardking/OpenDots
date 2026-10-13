import { PublicKey } from '@solana/web3.js';
import {
  birdeyeQuerySchema,
  type BirdeyeQuery,
  type BirdeyeResult,
  type BirdeyeStatus,
} from '../shared/birdeye-types.js';

type Row = Record<string, unknown>;
type Parameters = Record<string, string | number | boolean | undefined>;
type Panel =
  | { status: 'ready'; data: unknown }
  | { status: 'error'; error: string; code: string };
const ORIGIN = 'https://public-api.birdeye.so';
const PATHS = new Set([
  '/wallet/v2/current-net-worth',
  '/wallet/v2/net-worth',
  '/wallet/v2/pnl/details',
  '/wallet/v2/pnl/multiple',
  '/defi/v3/search',
  '/defi/token_overview',
  '/defi/token_security',
  '/defi/token_creation_info',
  '/defi/v3/ohlcv',
  '/defi/v3/ohlcv/pair',
  '/defi/history_price',
  '/defi/v3/price/stats/single',
  '/holder/v1/distribution',
  '/token/v1/holder-profile',
  '/defi/v3/token/holder',
  '/defi/v2/tokens/top_traders',
  '/defi/v3/token/fee/single',
  '/defi/v3/token/mint-burn-txs',
  '/defi/v3/token/txs-by-volume',
  '/defi/v3/token/trade-data/single',
  '/defi/v2/markets',
  '/defi/v3/pair/overview/single',
  '/defi/price',
  '/defi/v3/liquidity/ohlc/pair',
  '/defi/token_trending',
  '/defi/v3/token/list',
  '/defi/v2/tokens/new_listing',
  '/defi/multi_price',
  '/smart-money/v1/token/list',
  '/trader/txs/seek_by_time',
  '/utils/v1/credits',
]);

export class BirdeyeError extends Error {
  constructor(
    message: string,
    readonly status = 502,
    readonly code = 'upstream-unavailable',
  ) {
    super(message);
    this.name = 'BirdeyeError';
  }
}
export function birdeyeNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function row(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
}
function rows(
  value: unknown,
  keys = ['items', 'tokens', 'history', 'data'],
): Row[] {
  if (Array.isArray(value))
    return value.filter(
      (item) => item && typeof item === 'object' && !Array.isArray(item),
    ) as Row[];
  const object = row(value);
  for (const key of keys)
    if (Array.isArray(object[key])) return rows(object[key]);
  return [];
}
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function at(value: unknown, key: string) {
  return row(value)[key];
}
function panelData(panel: Panel | undefined) {
  return panel?.status === 'ready' ? panel.data : null;
}
function timestamp(value: unknown): number | null {
  const numeric = birdeyeNumber(value);
  if (numeric !== null)
    return numeric > 1e12 ? Math.floor(numeric / 1000) : numeric;
  if (typeof value !== 'string') return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.floor(date / 1000) : null;
}
export function birdeyeIntervalSeconds(interval: string): number {
  const match = /^(\d+)([mHDWM])$/.exec(interval);
  const unit: Record<string, number> = {
    m: 60,
    H: 3600,
    D: 86400,
    W: 604800,
    M: 2592000,
  };
  if (!match)
    throw new BirdeyeError(
      'Choose a supported candle interval.',
      400,
      'invalid-input',
    );
  return Number(match[1]) * unit[match[2]];
}
export function birdeyeClosedCandles(
  value: unknown,
  interval: string,
  nowSeconds: number,
): Row[] {
  const seconds = birdeyeIntervalSeconds(interval);
  return rows(value)
    .filter((item) => {
      const time = timestamp(item.unix_time);
      if (time === null) return false;
      let end = time + seconds;
      if (interval.endsWith('M')) {
        const date = new Date(time * 1000);
        date.setUTCMonth(date.getUTCMonth() + Number.parseInt(interval));
        end = date.getTime() / 1000;
      }
      return end <= nowSeconds && birdeyeNumber(item.c) !== null;
    })
    .sort((a, b) => Number(a.unix_time) - Number(b.unix_time));
}
/** Do not collapse trades with missing identifiers, or two different swap instructions. */
export function birdeyeDeduplicateTrades(items: Row[]): Row[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const hash = item.tx_hash ?? item.txHash;
    const instruction = item.ins_index ?? item.instructionIndex;
    const inner = item.inner_ins_index ?? item.innerInstructionIndex;
    if (!hash || instruction === undefined || inner === undefined) return true;
    const key = JSON.stringify([hash, instruction, inner]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function percentageChange(
  current: number | null,
  prior: number | null,
): number | null {
  return current === null || prior === null || prior <= 0
    ? null
    : (current / prior - 1) * 100;
}
function normalizePnl(value: unknown): Row {
  const item = row(value),
    pnl = row(item.pnl),
    pricing = row(item.pricing),
    counts = row(item.counts);
  const currentPrice = birdeyeNumber(pricing.current_price);
  return {
    ...item,
    pnl: {
      ...pnl,
      realized_profit_usd: birdeyeNumber(pnl.realized_profit_usd),
      unrealized_usd:
        Object.hasOwn(pricing, 'current_price') && currentPrice === null
          ? null
          : birdeyeNumber(pnl.unrealized_usd),
      total_usd: birdeyeNumber(pnl.total_usd),
      avg_profit_per_trade_usd: birdeyeNumber(pnl.avg_profit_per_trade_usd),
      realized_profit_percent: birdeyeNumber(pnl.realized_profit_percent),
    },
    pricing: { ...pricing, current_price: currentPrice },
    counts: {
      ...counts,
      ...(Object.hasOwn(counts, 'win_rate')
        ? {
            win_rate: birdeyeNumber(counts.win_rate),
            winRatePercent:
              birdeyeNumber(counts.win_rate) === null
                ? null
                : Number(counts.win_rate) * 100,
          }
        : {}),
    },
  };
}
function normalizeOverview(value: unknown): Row {
  const item = row(value);
  return {
    ...item,
    price: birdeyeNumber(item.price),
    marketCap: birdeyeNumber(item.marketCap),
    liquidity: birdeyeNumber(item.liquidity),
    v24hUSD: birdeyeNumber(item.v24hUSD),
    holder: birdeyeNumber(item.holder),
    global_fees_paid: birdeyeNumber(item.global_fees_paid),
  };
}
function normalizeTraders(value: unknown): Row[] {
  return rows(value).map((item) => ({
    ...item,
    volumeUsd: birdeyeNumber(item.volumeUsd),
    volumeBuyUSD: birdeyeNumber(item.volumeBuyUSD),
    volumeSellUSD: birdeyeNumber(item.volumeSellUSD),
  }));
}
function warningForPanels(panels: Record<string, Panel>): string[] {
  return Object.entries(panels).flatMap(([name, panel]) =>
    panel.status === 'error' ? [`${name}: ${panel.error}`] : [],
  );
}
function scrub(value: unknown, secret: string, depth = 0): unknown {
  if (depth > 30) return null;
  if (typeof value === 'string')
    return secret ? value.split(secret).join('[redacted]') : value;
  if (Array.isArray(value))
    return value.map((item) => scrub(item, secret, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(api[_-]?key|x-api-key|authorization|secret|access[_-]?token)$/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, scrub(item, secret, depth + 1)]),
    );
  return value;
}
function abortError(): BirdeyeError {
  return new BirdeyeError('Birdeye request was cancelled.', 499, 'cancelled');
}
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener('abort', cancel, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** Read-only account-wide provider. API credentials never enter result or status objects. */
export class BirdeyeService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<
    string,
    { expires: number; fetchedAt: number; data: unknown }
  >();
  private accountCooldown?: { until: number; error: BirdeyeError };
  private readonly endpointCooldowns = new Map<
    string,
    { until: number; error: BirdeyeError }
  >();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly walletRequests: number[] = [];
  private readonly marketRequests: number[] = [];
  private lastState: BirdeyeStatus['state'] = 'ready';
  private lastErrorAt = 0;
  private creditState?: BirdeyeStatus['credits'];
  private providerObserved = false;
  private lastEndpointFailure?: BirdeyeStatus['lastEndpointFailure'];
  constructor(
    options: {
      env?: NodeJS.ProcessEnv;
      fetchImpl?: typeof fetch;
      now?: () => number;
    } = {},
  ) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }
  get configured(): boolean {
    return !!this.env.BIRDEYE_API_KEY?.trim();
  }
  status(): BirdeyeStatus {
    const state = !this.configured
      ? 'missing-configuration'
      : this.accountCooldown && this.accountCooldown.until > this.now()
        ? this.accountCooldown.error.code === 'authentication-error'
          ? 'authentication-error'
          : 'quota-limited'
        : this.now() - this.lastErrorAt > 60_000
          ? 'ready'
          : this.lastState;
    const messages: Record<BirdeyeStatus['state'], string> = {
      ready: this.providerObserved
        ? 'Birdeye responded successfully. Endpoint access depends on API key permissions and package.'
        : 'Birdeye API key is configured. Provider access has not been verified.',
      'missing-configuration':
        'Set BIRDEYE_API_KEY on the server to enable Birdeye.',
      'quota-limited':
        'Birdeye quota or rate limit reached. Requests will resume after the cooldown.',
      'tier-unavailable':
        'This Birdeye endpoint is unavailable to the current API key or package.',
      'authentication-error': 'Birdeye rejected the server API key.',
      unavailable: 'Birdeye is temporarily unavailable.',
    };
    return {
      configured: this.configured,
      chain: 'solana',
      source: 'Birdeye',
      state,
      message: messages[state],
      walletLimits: { perSecond: 5, perMinute: 75 },
      ...(this.creditState ? { credits: this.creditState } : {}),
      ...(this.lastEndpointFailure
        ? { lastEndpointFailure: this.lastEndpointFailure }
        : {}),
    };
  }
  private limit(path: string) {
    const now = this.now(),
      wallet = path.startsWith('/wallet/v2/');
    const events = wallet ? this.walletRequests : this.marketRequests;
    const window = wallet ? 60_000 : 1000;
    while (events.length && events[0] <= now - window) events.shift();
    const second = events.filter((time) => time > now - 1000).length;
    const marketLimit = Math.min(
      100,
      Math.max(1, Number(this.env.BIRDEYE_MARKET_REQUESTS_PER_SECOND) || 30),
    );
    if (
      (wallet && (events.length >= 75 || second >= 5)) ||
      (!wallet && second >= marketLimit)
    ) {
      this.lastState = 'quota-limited';
      this.lastErrorAt = now;
      throw new BirdeyeError(
        wallet
          ? 'Birdeye wallet requests are limited to 5 per second and 75 per minute. Retry shortly.'
          : 'Birdeye market request budget reached. Retry shortly.',
        429,
        'rate-limited',
      );
    }
    if (this.inFlight.size >= 32)
      throw new BirdeyeError(
        'Birdeye is processing too many requests. Retry shortly.',
        429,
        'rate-limited',
      );
    events.push(now);
  }
  private cacheSeconds(path: string): number {
    if (path === '/utils/v1/credits') return 3600;
    if (path.startsWith('/wallet/')) return 60;
    if (path === '/defi/token_security' || path.includes('creation_info'))
      return 300;
    return 15;
  }
  private requestKey(
    path: string,
    params: Parameters | URLSearchParams,
    body?: unknown,
  ): string {
    const query = (
      params instanceof URLSearchParams
        ? [...params.entries()]
        : Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)])
    ).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([path, query, body ?? null]);
  }
  /** Trusted allowlisted reads. Cancellation stops this waiter; a coalesced account fetch may finish for another waiter. */
  async request(
    path: string,
    params: Parameters | URLSearchParams = {},
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    if (!PATHS.has(path))
      throw new BirdeyeError(
        'Unsupported Birdeye endpoint.',
        400,
        'invalid-input',
      );
    if (!this.configured)
      throw new BirdeyeError(
        'Birdeye is not configured. Set BIRDEYE_API_KEY on the server.',
        503,
        'missing-configuration',
      );
    const query = (
      params instanceof URLSearchParams
        ? [...params.entries()]
        : Object.entries(params)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)])
    ).sort(([a], [b]) => a.localeCompare(b));
    const key = JSON.stringify([path, query, body ?? null]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > this.now())
      return structuredClone(cached.data);
    if (cached) this.cache.delete(key);
    const previous = this.inFlight.get(key);
    if (previous)
      return withSignal(
        previous.then((data) => structuredClone(data)),
        signal,
      );
    const cooldown =
      this.accountCooldown?.until && this.accountCooldown.until > this.now()
        ? this.accountCooldown
        : this.endpointCooldowns.get(path);
    if (cooldown && cooldown.until > this.now())
      throw new BirdeyeError(
        cooldown.error.message,
        cooldown.error.status,
        cooldown.error.code,
      );
    this.limit(path);
    const promise = this.fetchData(path, query, body)
      .then((data) => {
        this.cache.set(key, {
          data,
          fetchedAt: this.now(),
          expires: this.now() + this.cacheSeconds(path) * 1000,
        });
        while (this.cache.size > 512)
          this.cache.delete(this.cache.keys().next().value!);
        return data;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return withSignal(
      promise.then((data) => structuredClone(data)),
      signal,
    );
  }
  private providerFailure(
    path: string,
    response: Response,
    bodyText: string,
  ): BirdeyeError {
    // Match bounded provider error categories locally. Never relay the upstream body.
    const quota =
      response.status === 402 ||
      response.status === 429 ||
      /compute_unit_allowance_exhausted|(?:credits?|quota|allowance|rate.limit).{0,70}(?:exhaust|exceed|limit|insufficient)|too many requests/i.test(
        bodyText,
      );
    const code = quota
      ? 'quota-limited'
      : response.status === 401
        ? 'authentication-error'
        : response.status === 403 ||
            /access.denied|not.permitted|package.access|tier.unavailable/i.test(
              bodyText,
            )
          ? 'tier-unavailable'
          : 'upstream-unavailable';
    this.lastState = code === 'upstream-unavailable' ? 'unavailable' : code;
    this.lastErrorAt = this.now();
    this.lastEndpointFailure = { path, code, checkedAt: this.now() };
    const error = new BirdeyeError(
      code === 'quota-limited'
        ? 'Birdeye quota or rate limit reached. Retry after the cooldown.'
        : code === 'tier-unavailable'
          ? 'Birdeye denied this endpoint. Check API key permissions and package access.'
          : code === 'authentication-error'
            ? 'Birdeye rejected the server API key.'
            : `Birdeye endpoint could not complete the request (HTTP ${response.status}).`,
      code === 'quota-limited'
        ? 429
        : code === 'tier-unavailable'
          ? 403
          : code === 'authentication-error'
            ? 503
            : 502,
      code,
    );
    const retryAfter = Math.min(
      300,
      Math.max(10, Number(response.headers.get('retry-after')) || 60),
    );
    if (code === 'quota-limited' || code === 'authentication-error')
      this.accountCooldown = { until: this.now() + retryAfter * 1000, error };
    if (code === 'tier-unavailable')
      this.endpointCooldowns.set(path, { until: this.now() + 300_000, error });
    return error;
  }
  private async errorBody(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        const remainder = 32_768 - length;
        chunks.push(part.value.subarray(0, remainder));
        length += Math.min(remainder, part.value.byteLength);
        if (length >= 32_768) break;
      }
      return Buffer.concat(chunks).toString();
    } catch {
      return '';
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  private async fetchData(
    path: string,
    query: string[][],
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${ORIGIN}${path}${query.length ? `?${new URLSearchParams(query)}` : ''}`,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            'X-API-KEY': this.env.BIRDEYE_API_KEY!,
            'x-chain': 'solana',
            accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(12_000),
        },
      );
    } catch {
      this.lastState = 'unavailable';
      this.lastErrorAt = this.now();
      throw new BirdeyeError('Birdeye could not be reached. Retry shortly.');
    }
    if (!response.ok) {
      throw this.providerFailure(
        path,
        response,
        await this.errorBody(response),
      );
    }
    let payload: unknown;
    const reader = response.body?.getReader();
    if (!reader)
      throw new BirdeyeError(
        'Birdeye returned an empty response.',
        502,
        'invalid-response',
      );
    try {
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 3_000_000)
          throw new BirdeyeError(
            'Birdeye response exceeds the supported size.',
            502,
            'invalid-response',
          );
        chunks.push(part.value);
      }
      payload = JSON.parse(Buffer.concat(chunks).toString());
    } catch (error) {
      if (error instanceof BirdeyeError) throw error;
      throw new BirdeyeError(
        'Birdeye returned an unreadable response.',
        502,
        'invalid-response',
      );
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (row(payload).success === false)
      throw this.providerFailure(
        path,
        response,
        JSON.stringify(payload).slice(0, 32768),
      );
    const envelope = row(payload);
    const unwrapped = Object.hasOwn(envelope, 'data') ? envelope.data : payload;
    const data = scrub(
      envelope.pagination &&
        unwrapped &&
        typeof unwrapped === 'object' &&
        !Array.isArray(unwrapped)
        ? { ...row(unwrapped), pagination: envelope.pagination }
        : unwrapped,
      this.env.BIRDEYE_API_KEY!,
    );
    this.providerObserved = true;
    if (!this.accountCooldown || this.accountCooldown.until <= this.now())
      this.lastState = 'ready';
    if (path === '/utils/v1/credits') {
      const remaining = birdeyeNumber(
        at(at(data, 'remaining'), 'total') ?? at(data, 'remaining'),
      );
      this.creditState = {
        remaining,
        checkedAt: this.now(),
        low: remaining !== null && remaining < 10_000,
      };
    }
    return data;
  }
  private async panels(
    tasks: Record<string, () => Promise<unknown>>,
  ): Promise<Record<string, Panel>> {
    const entries = Object.entries(tasks);
    const outcomes = await Promise.allSettled(
      entries.map(([, task]) => task()),
    );
    return Object.fromEntries(
      outcomes.map((outcome, index) => [
        entries[index][0],
        outcome.status === 'fulfilled'
          ? { status: 'ready', data: outcome.value }
          : {
              status: 'error',
              error:
                outcome.reason instanceof BirdeyeError
                  ? outcome.reason.message
                  : 'Birdeye panel could not be loaded.',
              code:
                outcome.reason instanceof BirdeyeError
                  ? outcome.reason.code
                  : 'upstream-unavailable',
            },
      ]),
    );
  }
  private range(input: BirdeyeQuery, fallback = '15m') {
    const interval = input.interval ?? fallback;
    const timeTo = Math.min(
      input.before ?? input.timeTo ?? Math.floor(this.now() / 1000),
      Math.floor(this.now() / 1000),
    );
    const timeFrom =
      input.timeFrom ??
      Math.max(0, timeTo - birdeyeIntervalSeconds(interval) * 100);
    if (
      timeFrom >= timeTo ||
      (timeTo - timeFrom) / birdeyeIntervalSeconds(interval) > 5000
    )
      throw new BirdeyeError(
        'Choose a valid time range with at most 5000 candles.',
        400,
        'invalid-input',
      );
    return { type: interval, time_from: timeFrom, time_to: timeTo };
  }
  async read(raw: BirdeyeQuery, signal?: AbortSignal): Promise<BirdeyeResult> {
    const parsed = birdeyeQuerySchema.safeParse(raw);
    if (!parsed.success)
      throw new BirdeyeError(
        parsed.error.issues[0]?.message ?? 'Invalid Birdeye query.',
        400,
        'invalid-input',
      );
    const input = parsed.data;
    if (!this.configured)
      throw new BirdeyeError(
        'Birdeye is not configured. Set BIRDEYE_API_KEY on the server.',
        503,
        'missing-configuration',
      );
    for (const address of [
      input.address,
      ...(input.addresses ?? []),
      ...(input.wallets ?? []),
    ].filter((value): value is string => !!value)) {
      try {
        new PublicKey(address);
      } catch {
        throw new BirdeyeError(
          'Enter a valid Solana address.',
          400,
          'invalid-input',
        );
      }
    }
    if (signal?.aborted) throw abortError();
    const observations: number[] = [];
    const get = async (path: string, params: Parameters = {}, body?: Row) => {
      const value = await this.request(path, params, body, signal);
      observations.push(
        this.cache.get(this.requestKey(path, params, body))?.fetchedAt ??
          this.now(),
      );
      return value;
    };
    const address = input.address!,
      limit = input.limit ?? 50,
      offset = input.offset ?? 0;
    const warnings: string[] = [];
    let data: Row;
    switch (input.workflow) {
      case 'portfolio': {
        const portfolioLimit = input.limit ?? 100;
        const panels = await this.panels({
          holdings: () =>
            get('/wallet/v2/current-net-worth', {
              wallet: address,
              sort_by: 'value',
              sort_type: 'desc',
              limit: portfolioLimit,
              offset,
            }),
          equity: () =>
            get('/wallet/v2/net-worth', {
              wallet: address,
              count: Math.min(input.limit ?? 30, 90),
              type: '1d',
              ...(input.before
                ? { time: input.before, direction: 'back' }
                : {}),
            }),
          pnl: () =>
            get(
              '/wallet/v2/pnl/details',
              {},
              {
                wallet: address,
                duration:
                  input.duration === '1d' ? '24h' : (input.duration ?? '30d'),
                limit: portfolioLimit,
                offset,
              },
            ),
        });
        const snapshot = row(panelData(panels.holdings)),
          pnl = row(panelData(panels.pnl));
        const holdings = rows(snapshot).map((item) => ({
          ...item,
          amount: birdeyeNumber(item.amount),
          value: birdeyeNumber(item.value),
          price: birdeyeNumber(item.price),
          rawBalance: text(item.balance),
          balance: birdeyeNumber(item.balance),
        }));
        const equityCurve = rows(panelData(panels.equity), ['history', 'items'])
          .map((item) => ({
            ...item,
            unix_time: timestamp(item.timestamp ?? item.unix_time),
            net_worth: birdeyeNumber(item.net_worth),
            net_worth_change: birdeyeNumber(item.net_worth_change),
            net_worth_change_percent: birdeyeNumber(
              item.net_worth_change_percent,
            ),
          }))
          .sort((a, b) => Number(a.unix_time) - Number(b.unix_time));
        const tokenPnl = rows(pnl, ['tokens', 'items']).map(normalizePnl);
        const lastTime = equityCurve[0]?.unix_time;
        const totalHoldings = birdeyeNumber(at(snapshot.pagination, 'total'));
        const hasMore =
          totalHoldings !== null
            ? offset + holdings.length < totalHoldings
            : holdings.length >= portfolioLimit;
        data = {
          address,
          totalValue: birdeyeNumber(snapshot.total_value),
          holdings,
          equityCurve,
          pnlSummary: normalizePnl(pnl.summary),
          tokenPnl,
          panels,
          pagination: {
            offset,
            limit: portfolioLimit,
            total: totalHoldings,
            hasMore,
            nextOffset: hasMore ? offset + portfolioLimit : null,
          },
          nextBefore: lastTime ?? null,
        };
        if (hasMore)
          warnings.push(
            'This wallet has more holdings. Load the next page to inspect the full portfolio.',
          );
        warnings.push(...warningForPanels(panels));
        if (tokenPnl.some((item) => at(item.pricing, 'current_price') === null))
          warnings.push(
            'Unpriced tokens have no reliable unrealized valuation.',
          );
        break;
      }
      case 'pnl-comparison': {
        const result = row(
          await get('/wallet/v2/pnl/multiple', {
            token_address: address,
            wallets: [...new Set(input.wallets)].join(','),
          }),
        );
        const byWallet = row(result.data ?? result);
        const items: Row[] = Object.entries(byWallet).map(
          ([wallet, value]) => ({ wallet, ...normalizePnl(value) }),
        );
        items.sort(
          (a, b) =>
            (birdeyeNumber(at(b.pnl, 'total_usd')) ?? -Infinity) -
            (birdeyeNumber(at(a.pnl, 'total_usd')) ?? -Infinity),
        );
        data = { address, items };
        break;
      }
      case 'search': {
        const keyword = input.keyword!;
        let exactMint = false;
        try {
          exactMint = new PublicKey(keyword).toBase58() === keyword;
        } catch {
          /* Symbol or name requires explicit mint selection. */
        }
        const result = await get('/defi/v3/search', {
          keyword,
          target: 'token',
          search_mode: exactMint ? 'exact' : 'fuzzy',
          search_by: exactMint ? 'address' : 'combination',
          sort_by: 'liquidity',
          sort_type: 'desc',
          limit: Math.min(limit, 20),
          offset,
        });
        const items = rows(result)
          .flatMap((item) =>
            Array.isArray(item.result)
              ? item.type === 'token'
                ? rows(item.result)
                : []
              : [item],
          )
          .filter(
            (item) =>
              typeof item.address === 'string' &&
              (!item.network || item.network === 'solana'),
          );
        data = {
          keyword,
          items,
          selectedAddress:
            exactMint && items.some((item) => item.address === keyword)
              ? keyword
              : null,
          requiresSelection: !exactMint && items.length > 0,
          nextOffset:
            items.length >= Math.min(limit, 20)
              ? offset + Math.min(limit, 20)
              : null,
        };
        if (!exactMint && items.length > 0)
          warnings.push(
            'Select a canonical mint. Token names and symbols can belong to multiple tokens.',
          );
        break;
      }
      case 'investigation': {
        const range = this.range(input);
        const panels = await this.panels({
          market: () =>
            get('/defi/token_overview', { address, frames: '1h,4h,24h' }).then(
              normalizeOverview,
            ),
          chart: () =>
            get('/defi/v3/ohlcv', {
              address,
              currency: 'usd',
              padding: false,
              ...range,
            }),
          ownership: () =>
            get('/holder/v1/distribution', {
              token_address: address,
              mode: 'top',
              top_n: 20,
              include_list: true,
            }),
          behavior: () =>
            get('/token/v1/holder-profile', { token_address: address }),
          traders: () =>
            get('/defi/v2/tokens/top_traders', {
              address,
              time_frame: '24h',
              sort_by: 'volume',
              sort_type: 'desc',
              limit: 10,
            }).then(normalizeTraders),
          fees: () =>
            get('/defi/v3/token/fee/single', {
              address,
              interval: '24h,alltime',
            }),
          security: () => get('/defi/token_security', { address }),
          mintBurn: () =>
            get('/defi/v3/token/mint-burn-txs', {
              address,
              sort_by: 'block_time',
              sort_type: 'desc',
              type: 'all',
              limit: 100,
            }),
        });
        data = { address, panels };
        warnings.push(
          ...warningForPanels(panels),
          'Bundler labels are reliable only for tokens created from March 2026 onward. Fee detail preserves trading_platform_fee_amout_stablecoins exactly.',
        );
        break;
      }
      case 'rug-check': {
        const panels = await this.rugPanels(address, get);
        data = {
          address,
          ...this.riskGate(panels, input.minLiquidity ?? 5000),
          panels,
        };
        warnings.push(
          ...warningForPanels(panels),
          'Liquidity is a sellability approximation on Solana. A passed gate does not guarantee a token can be sold.',
          'Holder behavior tags enrich the assessment and are not a safety verdict.',
        );
        break;
      }
      case 'wash-trading': {
        const panels = await this.panels({
          market: () => get('/defi/token_overview', { address, frames: '24h' }),
          trades: () =>
            get('/defi/v3/token/txs-by-volume', {
              token_address: address,
              volume_type: 'usd',
              sort_type: 'desc',
              limit: 100,
            }),
          cadence: () =>
            get('/defi/v3/token/trade-data/single', {
              address,
              frames: '5s,1m,5m',
            }),
          traders: () =>
            get('/defi/v2/tokens/top_traders', {
              address,
              time_frame: '24h',
              sort_by: 'volume',
              sort_type: 'desc',
              limit: 10,
            }),
          behavior: () =>
            get('/token/v1/holder-profile', { token_address: address }),
        });
        data = { address, ...this.washSignals(panels), panels };
        warnings.push(
          ...warningForPanels(panels),
          'A suspicion score is not proof. Market makers, arbitrage, young tokens, and low float can produce these patterns. Trade concentration covers the returned sample, not all trades.',
        );
        break;
      }
      case 'cross-dex': {
        data = await this.crossDex(input, get, warnings);
        break;
      }
      case 'liquidity': {
        data = await this.liquidity(input, get, warnings);
        break;
      }
      case 'chart': {
        const range = this.range(input, '1H');
        const panels = await this.panels({
          chart: () =>
            get('/defi/v3/ohlcv', {
              address,
              currency: 'usd',
              padding: false,
              ...range,
            }),
          stats: () =>
            get('/defi/v3/price/stats/single', {
              address,
              list_timeframe: '1h,24h',
            }),
        });
        const items = rows(panelData(panels.chart)).sort(
          (a, b) => Number(a.unix_time) - Number(b.unix_time),
        );
        data = {
          address,
          interval: range.type,
          items,
          stats: panelData(panels.stats),
          panels,
          nextBefore: items[0]?.unix_time ?? null,
          hasMore: items.length > 0,
          closedItems: birdeyeClosedCandles(
            { items },
            range.type,
            this.now() / 1000,
          ),
        };
        warnings.push(...warningForPanels(panels));
        break;
      }
      case 'history': {
        const range = this.range(input, '1H');
        const interval =
          range.type === '1H'
            ? '1H'
            : range.type === '1D'
              ? '1D'
              : ['1m', '3m', '5m', '15m', '30m'].includes(range.type)
                ? range.type
                : '1H';
        const result = await get('/defi/history_price', {
          address,
          address_type: 'token',
          ...range,
          type: interval,
        });
        const items = rows(result).sort(
          (a, b) =>
            Number(a.unixTime ?? a.unix_time) -
            Number(b.unixTime ?? b.unix_time),
        );
        data = {
          address,
          interval,
          items,
          nextBefore: items[0]?.unixTime ?? items[0]?.unix_time ?? null,
          hasMore: items.length > 0,
        };
        break;
      }
      case 'price-stats': {
        const result = await get('/defi/v3/price/stats/single', {
          address,
          list_timeframe: '1h,24h',
        });
        data = {
          address,
          items: rows(result).flatMap((item) =>
            Array.isArray(item.data)
              ? rows(item.data).map((frame) => ({
                  address: item.address ?? address,
                  ...frame,
                  price_change_percent: birdeyeNumber(
                    frame.price_change_percent,
                  ),
                }))
              : [item],
          ),
        };
        break;
      }
      case 'trending': {
        const pageSize = Math.min(limit, 50);
        const result = await get('/defi/token_trending', {
          sort_by: 'rank',
          sort_type: 'asc',
          interval: '1h',
          offset,
          limit: pageSize,
        });
        const items = rows(result);
        data = {
          items,
          interval: '1h',
          offset,
          limit: pageSize,
          nextOffset: items.length === pageSize ? offset + pageSize : null,
        };
        break;
      }
      case 'screener': {
        const filters = {
          sort_by: 'volume_24h_change_percent',
          sort_type: 'desc',
          min_liquidity: input.minLiquidity ?? 50_000,
          min_holder: input.minHolders ?? 500,
          min_volume_24h_usd: input.minVolume ?? 100_000,
          min_trade_24h_count: 1000,
          offset,
          limit,
        };
        const result = await get('/defi/v3/token/list', filters);
        const items = rows(result);
        data = {
          items,
          filters,
          nextOffset: items.length === limit ? offset + limit : null,
          pagination: 'offset',
        };
        warnings.push(
          'Filtering runs on Birdeye. Business scroll scanning uses account-wide sessions and is not opened per chat.',
        );
        break;
      }
      case 'new-listings': {
        data = await this.newListings(input, get, warnings);
        break;
      }
      case 'watchlist': {
        const addresses = [...new Set(input.addresses!)];
        const result = row(
          await get(
            '/defi/multi_price',
            { include_liquidity: true },
            { list_address: addresses.join(',') },
          ),
        );
        const items = addresses.map((mint) => {
          const item = result[mint];
          const observed = timestamp(at(item, 'updateUnixTime'));
          return {
            address: mint,
            ...(item === null || item === undefined
              ? { priceUsd: null, unavailable: true }
              : {
                  ...row(item),
                  priceUsd: birdeyeNumber(at(item, 'value')),
                  updateUnixTime: observed,
                  stale:
                    observed === null || this.now() / 1000 - observed > 300,
                }),
          };
        });
        data = { items };
        if (items.some((item) => item.priceUsd === null))
          warnings.push('Unknown or unsupported tokens have no price.');
        break;
      }
      case 'whales': {
        const result = await get('/defi/v3/token/txs-by-volume', {
          token_address: address,
          volume_type: 'usd',
          sort_type: 'desc',
          min_volume: input.minVolume ?? 10_000,
          limit,
          offset,
        });
        const items = this.tradeRows(result, address);
        data = {
          address,
          items,
          buyVolumeUsd: items
            .filter((item) => item.side === 'buy')
            .reduce(
              (sum, item) => sum + (birdeyeNumber(item.volumeUsd) ?? 0),
              0,
            ),
          sellVolumeUsd: items
            .filter((item) => item.side === 'sell')
            .reduce(
              (sum, item) => sum + (birdeyeNumber(item.volumeUsd) ?? 0),
              0,
            ),
          nextOffset: rows(result).length >= limit ? offset + limit : null,
          scope: 'returned volume-ranked sample',
        };
        break;
      }
      case 'smart-money': {
        const flow = await get('/smart-money/v1/token/list', {
          sort_by: 'net_flow',
          sort_type: 'desc',
          interval: '1d',
          trader_style: 'all',
          limit,
          offset,
        });
        data = {
          items: rows(flow).map((item) => ({
            ...item,
            address:
              text(item.address) ??
              text(item.token) ??
              text(at(item.token, 'address')),
          })),
          interval: '1d',
          nextOffset: rows(flow).length >= limit ? offset + limit : null,
        };
        if (input.address) {
          const traders = normalizeTraders(
            await get('/defi/v2/tokens/top_traders', {
              address,
              time_frame: '24h',
              sort_by: 'realized_pnl',
              sort_type: 'desc',
              limit: 10,
            }),
          );
          data.address = address;
          data.topTraders = traders;
        }
        if (input.wallets?.length) {
          const selected = [...new Set(input.wallets)].slice(0, 3);
          const trackRecords = await this.panels(
            Object.fromEntries(
              selected.map((wallet) => [
                wallet,
                () =>
                  get(
                    '/wallet/v2/pnl/details',
                    {},
                    {
                      wallet,
                      duration: 'all',
                      position_scope: 'cumulative',
                      limit: 100,
                    },
                  ).then((value) => ({
                    summary: normalizePnl(at(value, 'summary')),
                    tokens: rows(value, ['tokens']).map(normalizePnl),
                    scope: 'all-time cumulative',
                  })),
              ]),
            ),
          );
          data.trackRecords = trackRecords;
          warnings.push(...warningForPanels(trackRecords));
          if (input.wallets.length > 3)
            warnings.push(
              'Full-history scoring is limited to three wallets per request to protect the separate wallet budget.',
            );
        }
        warnings.push(
          'Smart money activity is research context. A token-specific winning trade is not a wallet trust gate.',
        );
        break;
      }
      case 'wallet-history': {
        const panels = await this.panels({
          trades: () =>
            get('/trader/txs/seek_by_time', {
              address,
              tx_type: 'swap',
              after_time:
                input.timeFrom ??
                Math.max(0, Math.floor(this.now() / 1000) - 86400),
              before_time: input.before ?? input.timeTo,
              limit,
              offset,
            }),
          pnl: () =>
            get(
              '/wallet/v2/pnl/details',
              {},
              {
                wallet: address,
                duration: 'all',
                position_scope: 'cumulative',
                limit: 100,
              },
            ),
        });
        const result = panelData(panels.trades),
          items = this.tradeRows(result);
        const tradeTimes = items
          .map((item) =>
            timestamp(
              item.block_unix_time ?? item.block_time ?? item.blockUnixTime,
            ),
          )
          .filter((time): time is number => time !== null);
        data = {
          address,
          items,
          summary: normalizePnl(at(panelData(panels.pnl), 'summary')),
          tokenPnl: rows(panelData(panels.pnl), ['tokens']).map(normalizePnl),
          panels,
          nextOffset: rows(result).length >= limit ? offset + limit : null,
          nextBefore: tradeTimes.length ? Math.min(...tradeTimes) : null,
          pnlScope: 'all-time cumulative',
        };
        warnings.push(...warningForPanels(panels));
        break;
      }
      case 'credits': {
        const raw = await get('/utils/v1/credits');
        data = {
          raw,
          remaining: this.creditState?.remaining ?? null,
          checkedAt: this.creditState?.checkedAt ?? this.now(),
          low: this.creditState?.low ?? false,
          degradationOrder: [
            'Slow discovery and screening',
            'Stretch holder profiling',
            'Protect position monitoring until last',
          ],
        };
        break;
      }
    }
    if (signal?.aborted) throw abortError();
    const partial = warnings.some((warning) => /: Birdeye/.test(warning));
    return {
      source: 'Birdeye',
      workflow: input.workflow,
      observedAt: observations.length ? Math.min(...observations) : this.now(),
      fetchedAt: observations.length ? Math.min(...observations) : this.now(),
      requestedAt: this.now(),
      cacheAgeMs: observations.length
        ? Math.max(0, this.now() - Math.min(...observations))
        : 0,
      data,
      warnings,
      ...(partial ? { partial: true } : {}),
    };
  }
  private rugPanels(
    address: string,
    get: (path: string, params?: Parameters, body?: Row) => Promise<unknown>,
  ) {
    return this.panels({
      security: () => get('/defi/token_security', { address }),
      creation: () => get('/defi/token_creation_info', { address }),
      market: () => get('/defi/token_overview', { address, frames: '1h,24h' }),
      ownership: () =>
        get('/holder/v1/distribution', {
          token_address: address,
          mode: 'top',
          top_n: 20,
          include_list: true,
        }),
      holders: () =>
        get('/defi/v3/token/holder', { address, offset: 0, limit: 20 }),
      behavior: () =>
        get('/token/v1/holder-profile', { token_address: address }),
      mintBurn: () =>
        get('/defi/v3/token/mint-burn-txs', {
          address,
          type: 'all',
          sort_by: 'block_time',
          sort_type: 'desc',
          limit: 100,
        }),
    });
  }
  private riskGate(panels: Record<string, Panel>, floor: number): Row {
    const security = row(panelData(panels.security)),
      market = row(panelData(panels.market));
    type Check = {
      name: string;
      state: 'pass' | 'fail' | 'unknown' | 'not-applicable';
      value: unknown;
      reason: string;
    };
    const checks: Check[] = [];
    const booleanCheck = (field: string, name: string) => {
      const value = security[field];
      checks.push({
        name,
        state: !Object.hasOwn(security, field)
          ? 'unknown'
          : value === null
            ? 'not-applicable'
            : value === true
              ? 'fail'
              : value === false
                ? 'pass'
                : 'unknown',
        value: value ?? null,
        reason: !Object.hasOwn(security, field)
          ? 'Field was not supplied.'
          : value === null
            ? 'Provider reports this control does not apply.'
            : value === true
              ? 'Control remains enabled.'
              : value === false
                ? 'Control is disabled.'
                : 'Unexpected provider value.',
      });
    };
    for (const [field, name] of [
      ['ownerAddress', 'mintAuthority'],
      ['freezeAuthority', 'freezeAuthority'],
    ]) {
      const present = Object.hasOwn(security, field),
        value = security[field];
      checks.push({
        name,
        state: !present
          ? 'unknown'
          : value === null
            ? 'pass'
            : typeof value === 'string' && value.length > 0
              ? 'fail'
              : 'unknown',
        value: value ?? null,
        reason: !present
          ? 'Authority field was not supplied.'
          : value === null
            ? 'Authority is renounced.'
            : 'Authority remains live.',
      });
    }
    booleanCheck('freezeable', 'freezeable');
    booleanCheck('mutableMetadata', 'mutableMetadata');
    booleanCheck('transferFeeEnable', 'transferFeeEnable');
    const concentration = birdeyeNumber(security.top10HolderPercent);
    checks.push({
      name: 'top10HolderPercent',
      state: !Object.hasOwn(security, 'top10HolderPercent')
        ? 'unknown'
        : concentration === null
          ? 'not-applicable'
          : concentration > 0.3
            ? 'fail'
            : 'pass',
      value: concentration,
      reason:
        concentration === null
          ? 'No comparable holder concentration was provided.'
          : concentration > 0.3
            ? 'Top ten holders exceed the 30 percent threshold.'
            : 'Within the 30 percent threshold.',
    });
    const liquidity = birdeyeNumber(market.liquidity);
    checks.push({
      name: 'liquidity',
      state:
        liquidity === null ? 'unknown' : liquidity < floor ? 'fail' : 'pass',
      value: liquidity,
      reason:
        liquidity === null
          ? 'Liquidity is unavailable.'
          : `Minimum liquidity is $${floor}.`,
    });
    const creation = row(panelData(panels.creation));
    const createdAt = timestamp(
      creation.blockUnixTime ??
        creation.block_time ??
        creation.creation_time ??
        creation.blockTime,
    );
    const mints = rows(panelData(panels.mintBurn)).filter((item) => {
      const time = timestamp(item.block_time ?? item.blockUnixTime);
      return (
        String(item.type ?? item.tx_type).toLowerCase() === 'mint' &&
        createdAt !== null &&
        time !== null &&
        time > createdAt + 3600 &&
        time > this.now() / 1000 - 86400
      );
    });
    checks.push({
      name: 'mintHistory',
      state:
        panels.mintBurn?.status !== 'ready' || createdAt === null
          ? 'unknown'
          : mints.length >= 2
            ? 'fail'
            : 'pass',
      value: mints.length,
      reason:
        mints.length >= 2
          ? 'Multiple recent mints occurred more than an hour after creation; review supply inflation.'
          : createdAt === null
            ? 'Creation time is unavailable; initial mint events cannot be separated from later mints.'
            : 'No recent post-launch mint burst in the returned sample.',
    });
    return {
      gate: checks.some((item) => item.state === 'fail')
        ? 'rejected'
        : checks.some((item) => item.state === 'unknown')
          ? 'unknown'
          : 'passed',
      checks,
      minLiquidity: floor,
      security,
      creation: panelData(panels.creation),
      behavior: panelData(panels.behavior),
    };
  }
  private tradeRows(value: unknown, token?: string): Row[] {
    return birdeyeDeduplicateTrades(rows(value)).map((item) => {
      const base = row(item.base),
        quote = row(item.quote),
        from = row(item.from),
        to = row(item.to);
      const tracked = token
        ? base.address === token
          ? base
          : quote.address === token
            ? quote
            : null
        : null;
      const direction = tracked?.type_swap;
      const side =
        direction === 'to'
          ? 'buy'
          : direction === 'from'
            ? 'sell'
            : token && to.address === token
              ? 'buy'
              : token && from.address === token
                ? 'sell'
                : item.side === 'buy' || item.side === 'sell'
                  ? item.side
                  : item.tx_type === 'buy' || item.tx_type === 'sell'
                    ? item.tx_type
                    : null;
      return {
        ...item,
        wallet: item.owner ?? null,
        pool: item.pool_id ?? item.address ?? null,
        side,
        tokenAddress: token ?? null,
        volumeUsd: birdeyeNumber(
          item.volume_usd ?? item.volumeUSD ?? item.volumeUsd,
        ),
        base: {
          ...base,
          direction:
            base.type_swap === 'to'
              ? 'entry'
              : base.type_swap === 'from'
                ? 'exit'
                : null,
        },
        quote: {
          ...quote,
          direction:
            quote.type_swap === 'to'
              ? 'entry'
              : quote.type_swap === 'from'
                ? 'exit'
                : null,
        },
      };
    });
  }
  private washSignals(panels: Record<string, Panel>): Row {
    const market = row(panelData(panels.market)),
      trades = birdeyeDeduplicateTrades(rows(panelData(panels.trades))),
      traders = normalizeTraders(panelData(panels.traders));
    const liquidity = birdeyeNumber(market.liquidity),
      volume = birdeyeNumber(market.v24hUSD),
      count = birdeyeNumber(market.trade24h),
      wallets = birdeyeNumber(market.uniqueWallet24h);
    const volumeRatio =
      liquidity !== null && liquidity > 0 && volume !== null
        ? volume / liquidity
        : null;
    const walletRatio =
      count !== null && count > 0 && wallets !== null ? wallets / count : null;
    const owners = new Map<string, number>();
    for (const item of trades) {
      const owner = text(item.owner),
        usd = birdeyeNumber(
          item.volume_usd ?? item.volumeUSD ?? item.volumeUsd,
        );
      if (owner && usd !== null && usd >= 0)
        owners.set(owner, (owners.get(owner) ?? 0) + usd);
    }
    const total = [...owners.values()].reduce((a, b) => a + b, 0);
    const concentrations = [...owners.entries()]
      .map(([owner, volumeUsd]) => ({
        owner,
        volumeUsd,
        fraction: total > 0 ? volumeUsd / total : null,
      }))
      .sort((a, b) => b.volumeUsd - a.volumeUsd);
    const churn = traders.flatMap((trader) => {
      const buy = birdeyeNumber(trader.volumeBuyUSD),
        sell = birdeyeNumber(trader.volumeSellUSD);
      return buy !== null && sell !== null && Math.max(buy, sell) > 0
        ? [
            {
              wallet: trader.owner ?? trader.address,
              imbalance: Math.abs(buy - sell) / Math.max(buy, sell),
              volumeBuyUSD: buy,
              volumeSellUSD: sell,
              tags: trader.tags ?? [],
            },
          ]
        : [];
    });
    const times = [
      ...new Set(
        trades
          .map((item) =>
            timestamp(
              item.block_unix_time ?? item.block_time ?? item.blockUnixTime,
            ),
          )
          .filter((value): value is number => value !== null),
      ),
    ].sort((a, b) => a - b);
    const gaps = times
      .slice(1)
      .map((time, index) => time - times[index])
      .filter((value) => value > 0);
    const mean = gaps.length
      ? gaps.reduce((a, b) => a + b, 0) / gaps.length
      : null;
    const cv =
      gaps.length >= 4 && mean !== null && mean > 0
        ? Math.sqrt(
            gaps.reduce((sum, gap) => sum + (gap - mean) ** 2, 0) / gaps.length,
          ) / mean
        : null;
    const profile = row(panelData(panels.behavior)),
      creationTime = timestamp(at(profile.token, 'creation_time'));
    const reliableBundler =
      creationTime !== null && creationTime >= Date.UTC(2026, 2, 1) / 1000;
    const tags = rows(profile, ['tags']);
    const sniper = birdeyeNumber(
      tags.find((tag) => tag.tag === 'sniper')?.percent_of_supply,
    );
    const bundler = reliableBundler
      ? birdeyeNumber(
          tags.find((tag) => tag.tag === 'bundler')?.percent_of_supply,
        )
      : null;
    const knownShares = [sniper, bundler].filter(
      (value): value is number => value !== null,
    );
    // Tags can overlap. Use the largest observed tagged share, never sum overlapping supply.
    const taggedShare = knownShares.length ? Math.max(...knownShares) : null;
    const fresh =
      creationTime !== null && this.now() / 1000 - creationTime < 86400;
    const weight = fresh ? 0.5 : 1;
    const signals = [
      {
        name: 'baseline',
        flagged:
          volumeRatio === null && walletRatio === null
            ? null
            : (volumeRatio ?? 0) > 50 ||
              (walletRatio !== null && walletRatio < 0.05),
        evidence: {
          volumeLiquidityRatio: volumeRatio,
          uniqueWalletTradeRatio: walletRatio,
          volumeLiquidityThreshold: 50,
          walletTradeThreshold: 0.05,
        },
      },
      {
        name: 'ownerConcentration',
        flagged:
          concentrations.length && total > 0
            ? (concentrations[0].fraction ?? 0) > 0.2
            : null,
        evidence: {
          sampleVolumeUsd: total,
          owners: concentrations,
          deduplicatedTrades: trades.length,
          threshold: 0.2,
        },
      },
      {
        name: 'cadence',
        flagged: cv === null || gaps.length < 9 ? null : cv < 0.1,
        evidence: {
          meanGapSeconds: mean,
          coefficientOfVariation: cv,
          intervalsObserved: gaps.length,
          frames: panelData(panels.cadence),
          limitation:
            'Volume-ranked sample is not an exhaustive chronological trade stream.',
        },
      },
      {
        name: 'churn',
        flagged: churn.length
          ? churn.some((item) => item.imbalance <= 0.03)
          : null,
        evidence: { traders: churn, maxImbalance: 0.03 },
      },
      {
        name: 'behavior',
        flagged: taggedShare === null ? null : taggedShare >= 20,
        evidence: {
          taggedSharePercent: taggedShare,
          sniperSharePercent: sniper,
          bundlerSharePercent: bundler,
          bundlerReliable: reliableBundler,
          thresholdPercent: 20,
        },
      },
    ].map((signal) => ({
      ...signal,
      weight,
      contribution: signal.flagged === true ? weight : 0,
    }));
    return {
      score: signals.reduce((sum, signal) => sum + signal.contribution, 0),
      maxScore: 5 * weight,
      signals,
      coverage: signals.filter((signal) => signal.flagged !== null).length,
      freshTokenWeight: weight,
      verdict: 'suspicion-only',
    };
  }
  private async crossDex(
    input: BirdeyeQuery,
    get: (path: string, params?: Parameters, body?: Row) => Promise<unknown>,
    warnings: string[],
  ): Promise<Row> {
    const address = input.address!,
      floor = input.minLiquidity ?? 5000,
      threshold = input.thresholdPercent ?? 2;
    const initial = await this.panels({
      markets: () =>
        get('/defi/v2/markets', {
          address,
          sort_by: 'liquidity',
          sort_type: 'desc',
          limit: 20,
        }),
      anchor: () =>
        get('/defi/price', {
          address,
          include_liquidity: true,
          check_liquidity: floor,
        }),
    });
    warnings.push(...warningForPanels(initial));
    const anchor = panelData(initial.anchor),
      anchorUsd = birdeyeNumber(at(anchor, 'value'));
    const markets = rows(panelData(initial.markets))
      .filter((market) => (birdeyeNumber(market.liquidity) ?? 0) >= floor)
      .sort(
        (a, b) =>
          (birdeyeNumber(b.liquidity) ?? 0) - (birdeyeNumber(a.liquidity) ?? 0),
      )
      .slice(0, 3);
    const overviewPanels = await this.panels(
      Object.fromEntries(
        markets.map((market) => [
          String(market.address),
          () =>
            get('/defi/v3/pair/overview/single', {
              address: String(market.address),
            }),
        ]),
      ),
    );
    warnings.push(...warningForPanels(overviewPanels));
    const referenceMints = [
      ...new Set(
        Object.values(overviewPanels).flatMap((panel) => {
          const overview = row(panelData(panel));
          const base = text(at(overview.base, 'address')),
            quote = text(at(overview.quote, 'address'));
          return base === address && quote
            ? [quote]
            : quote === address && base
              ? [base]
              : [];
        }),
      ),
    ];
    let prices: Row = {};
    if (referenceMints.length) {
      const pricePanels = await this.panels({
        quotes: () =>
          get(
            '/defi/multi_price',
            { include_liquidity: true },
            { list_address: referenceMints.join(',') },
          ),
      });
      prices = row(panelData(pricePanels.quotes));
      warnings.push(...warningForPanels(pricePanels));
    }
    const pools: Row[] = markets.map((market) => {
      const overview = row(panelData(overviewPanels[String(market.address)]));
      const ratio = birdeyeNumber(overview.price),
        base = text(at(overview.base, 'address')),
        quote = text(at(overview.quote, 'address'));
      const targetInBase = base === address,
        reference = targetInBase ? quote : quote === address ? base : null;
      const referenceUsd = reference
        ? birdeyeNumber(at(prices[reference], 'value'))
        : null;
      const priceUsd =
        ratio !== null && ratio > 0 && referenceUsd !== null
          ? targetInBase
            ? ratio * referenceUsd
            : referenceUsd / ratio
          : null;
      const deviationPercent =
        priceUsd !== null && anchorUsd !== null && anchorUsd > 0
          ? (priceUsd / anchorUsd - 1) * 100
          : null;
      return {
        address: market.address,
        source: overview.source ?? market.source,
        liquidityUsd: birdeyeNumber(overview.liquidity ?? market.liquidity),
        volume24hUsd: birdeyeNumber(overview.volume_24h),
        base,
        quote,
        ratio,
        targetInBase,
        priceUsd,
        deviationPercent,
        flagged:
          deviationPercent !== null && Math.abs(deviationPercent) >= threshold,
        confirmed: false,
        confirmation: [],
        overview,
      };
    });
    const flagged = pools.filter((pool) => pool.flagged);
    if (flagged.length) {
      const range = this.range(
        {
          ...input,
          interval: '15m',
          timeFrom: input.timeFrom ?? Math.floor(this.now() / 1000) - 3600,
        },
        '15m',
      );
      const candles = await this.panels({
        anchor: () =>
          get('/defi/v3/ohlcv', {
            address,
            currency: 'usd',
            padding: false,
            ...range,
          }),
        ...Object.fromEntries(
          flagged.map((pool) => [
            String(pool.address),
            () =>
              get('/defi/v3/ohlcv/pair', {
                address: String(pool.address),
                padding: false,
                ...(pool.targetInBase ? {} : { inversion: true }),
                ...range,
              }),
          ]),
        ),
      });
      warnings.push(...warningForPanels(candles));
      const historicalAnchor = new Map(
        birdeyeClosedCandles(
          panelData(candles.anchor),
          '15m',
          this.now() / 1000,
        ).map((candle) => [Number(candle.unix_time), candle]),
      );
      for (const pool of flagged) {
        const confirmation = birdeyeClosedCandles(
          panelData(candles[String(pool.address)]),
          '15m',
          this.now() / 1000,
        )
          .flatMap((candle) => {
            const mark = historicalAnchor.get(Number(candle.unix_time)),
              close = birdeyeNumber(candle.c),
              reference = mark ? birdeyeNumber(mark.c) : null;
            // Pair V3 candles are indexed USD prices. Live pair overview ratios require conversion above.
            const volumeUsd = birdeyeNumber(candle.v_usd),
              baseVolume = birdeyeNumber(candle.v);
            if (
              !mark ||
              close === null ||
              reference === null ||
              reference <= 0 ||
              (volumeUsd ?? 0) < 100 ||
              ((baseVolume ?? 0) <= 0 && (volumeUsd ?? 0) <= 0)
            )
              return [];
            const deviation = (close / reference - 1) * 100;
            return [
              {
                unix_time: candle.unix_time,
                priceUsd: close,
                anchorUsd: reference,
                volumeUsd,
                deviationPercent: deviation,
                consistent:
                  Math.abs(deviation) >= threshold &&
                  Math.sign(deviation) ===
                    Math.sign(Number(pool.deviationPercent)),
              },
            ];
          })
          .slice(-4);
        pool.confirmation = confirmation;
        const latest = confirmation.slice(-3);
        pool.confirmed =
          latest.length >= 3 &&
          latest.every((candle) => candle.consistent) &&
          Number(latest.at(-1)!.unix_time) + 900 >= this.now() / 1000 - 900 &&
          latest.every(
            (candle, index) =>
              index === 0 ||
              Number(candle.unix_time) - Number(latest[index - 1].unix_time) ===
                900,
          );
      }
    }
    const weighted = pools.filter(
      (pool) =>
        birdeyeNumber(pool.priceUsd) !== null &&
        (birdeyeNumber(pool.liquidityUsd) ?? 0) > 0,
    );
    const total = weighted.reduce(
      (sum, pool) => sum + Number(pool.liquidityUsd),
      0,
    );
    if (anchorUsd === null)
      warnings.push(
        'The consolidated USD mark is unavailable. Deviations cannot be evaluated.',
      );
    if (markets.length === 1)
      warnings.push(
        'Only one pool meets the liquidity floor. There is no cross-pool spread.',
      );
    warnings.push(
      'Spread confirmation requires three consecutive closed 15 minute USD candles with at least $100 traded volume, matched to consolidated USD candles.',
    );
    return {
      address,
      anchor,
      pools,
      weightedPriceUsd:
        total > 0
          ? weighted.reduce(
              (sum, pool) =>
                sum + Number(pool.priceUsd) * Number(pool.liquidityUsd),
              0,
            ) / total
          : null,
      liquidityFloor: floor,
      thresholdPercent: threshold,
    };
  }
  private async liquidity(
    input: BirdeyeQuery,
    get: (path: string, params?: Parameters, body?: Row) => Promise<unknown>,
    warnings: string[],
  ): Promise<Row> {
    const address = input.address!,
      range = this.range({ ...input, interval: '1m' }, '1m');
    const markets = rows(
      await get('/defi/v2/markets', {
        address,
        sort_by: 'liquidity',
        sort_type: 'desc',
        limit: 20,
      }),
    ).sort(
      (a, b) =>
        (birdeyeNumber(b.liquidity) ?? 0) - (birdeyeNumber(a.liquidity) ?? 0),
    );
    const pool = markets[0];
    if (!pool?.address)
      return {
        address,
        pool: null,
        series: [],
        flagged: [],
        unavailable: 'No indexed liquidity pool.',
      };
    const panels = await this.panels({
      liquidity: () =>
        get('/defi/v3/liquidity/ohlc/pair', {
          address: String(pool.address),
          count: Math.min(input.limit ?? 100, 100),
          time: input.before ?? input.timeTo ?? Math.floor(this.now() / 1000),
          direction: 'back',
        }),
      price: () =>
        get('/defi/v3/ohlcv', {
          address,
          currency: 'usd',
          padding: false,
          ...range,
        }),
    });
    warnings.push(...warningForPanels(panels));
    const price = new Map(
      rows(panelData(panels.price)).map((candle) => [
        Number(candle.unix_time),
        candle,
      ]),
    );
    const threshold = input.thresholdPercent ?? 20;
    const series = rows(panelData(panels.liquidity))
      .sort((a, b) => Number(a.unix_time) - Number(b.unix_time))
      .map((candle) => {
        const matching = price.get(Number(candle.unix_time)),
          open = birdeyeNumber(candle.open_liquidity_usd),
          close = birdeyeNumber(candle.close_liquidity_usd);
        const liquidityChangePercent = percentageChange(close, open),
          priceChangePercent = matching
            ? percentageChange(
                birdeyeNumber(matching.c),
                birdeyeNumber(matching.o),
              )
            : null;
        const baseChange = percentageChange(
          birdeyeNumber(candle.close_base_balance),
          birdeyeNumber(candle.open_base_balance),
        );
        const quoteChange = percentageChange(
          birdeyeNumber(candle.close_quote_balance),
          birdeyeNumber(candle.open_quote_balance),
        );
        const balancesKnown = baseChange !== null && quoteChange !== null;
        const balancesSteady =
          balancesKnown &&
          Math.abs(baseChange) <= 0.1 &&
          Math.abs(quoteChange) <= 0.1;
        const tokensLeft =
          balancesKnown && baseChange < -0.1 && quoteChange < -0.1;
        const cause = !balancesKnown
          ? 'unknown'
          : balancesSteady
            ? 'reprice'
            : tokensLeft
              ? 'withdrawal'
              : 'balance-change';
        const closed = Number(candle.unix_time) + 60 <= this.now() / 1000;
        const flagged =
          closed &&
          liquidityChangePercent !== null &&
          liquidityChangePercent <= -threshold &&
          priceChangePercent !== null &&
          Math.abs(priceChangePercent) < threshold / 4 &&
          !balancesSteady;
        return {
          ...candle,
          priceClose: matching ? birdeyeNumber(matching.c) : null,
          liquidityChangePercent,
          priceChangePercent,
          baseBalanceChangePercent: baseChange,
          quoteBalanceChangePercent: quoteChange,
          cause,
          closed,
          flagged,
        };
      });
    const flagged = series.filter((item) => item.flagged);
    let explanation: Record<string, Panel> | undefined;
    if (flagged.length) {
      explanation = await this.panels({
        security: () => get('/defi/token_security', { address }),
        mintBurn: () =>
          get('/defi/v3/token/mint-burn-txs', {
            address,
            type: 'all',
            sort_by: 'block_time',
            sort_type: 'desc',
            limit: 100,
          }),
      });
      warnings.push(...warningForPanels(explanation));
    }
    const raw = row(panelData(panels.liquidity));
    return {
      address,
      pool,
      series,
      flagged,
      ...(explanation ? { explanation } : {}),
      hasMore: raw.has_more === true,
      nextBefore: raw.prev_cursor ?? null,
      nextAfter: raw.next_cursor ?? null,
      interval: '1m',
      thresholdPercent: threshold,
    };
  }
  private async newListings(
    input: BirdeyeQuery,
    get: (path: string, params?: Parameters, body?: Row) => Promise<unknown>,
    warnings: string[],
  ): Promise<Row> {
    // Bound enrichment to five candidates. Unknown and rejected candidates never enter survivors.
    const limit = Math.min(input.limit ?? 5, 5);
    const feed = await get('/defi/v2/tokens/new_listing', {
      limit,
      meme_platform_enabled: true,
    });
    const candidates = rows(feed)
      .filter(
        (item) =>
          !input.timeFrom ||
          (timestamp(
            item.block_unix_time ??
              item.liquidityAddedAt ??
              item.liquidity_added_at,
          ) ?? 0) > input.timeFrom,
      )
      .slice(0, limit);
    const items: Row[] = [];
    for (const candidate of candidates) {
      const address = text(candidate.address);
      if (!address) continue;
      const panels = await this.panels({
        security: () => get('/defi/token_security', { address }),
        creation: () => get('/defi/token_creation_info', { address }),
        market: () =>
          get('/defi/token_overview', { address, frames: '1m,5m,1h' }),
        ownership: () =>
          get('/holder/v1/distribution', {
            token_address: address,
            mode: 'top',
            top_n: 20,
            include_list: true,
          }),
      });
      const gate = this.riskGate(panels, input.minLiquidity ?? 5000);
      // Historical mint enrichment is optional for discovery; remove its synthetic absent check here.
      const checks = (gate.checks as Row[]).filter(
        (check) => check.name !== 'mintHistory',
      );
      const verdict = checks.some((check) => check.state === 'fail')
        ? 'rejected'
        : checks.some((check) => check.state === 'unknown') ||
            panels.creation.status !== 'ready' ||
            panels.ownership.status !== 'ready'
          ? 'unknown'
          : 'passed';
      const market = row(panelData(panels.market));
      items.push({
        ...candidate,
        discoveredAt: timestamp(
          candidate.block_unix_time ??
            candidate.liquidityAddedAt ??
            candidate.liquidity_added_at,
        ),
        gate: verdict,
        checks,
        creation: panelData(panels.creation),
        ownership: panelData(panels.ownership),
        market: verdict === 'passed' ? normalizeOverview(market) : null,
        momentumPercent:
          verdict === 'passed'
            ? birdeyeNumber(market.priceChange1hPercent)
            : null,
      });
      warnings.push(...warningForPanels(panels));
    }
    const survivors = items
      .filter((item) => item.gate === 'passed')
      .sort(
        (a, b) =>
          (birdeyeNumber(b.momentumPercent) ?? -Infinity) -
          (birdeyeNumber(a.momentumPercent) ?? -Infinity),
      );
    if ((input.limit ?? 5) > 5)
      warnings.push(
        'Discovery is bounded to five security-gated candidates per request.',
      );
    warnings.push(
      'Only candidates that clear the security and liquidity gate appear as survivors. Discovery does not execute trades.',
    );
    return {
      items,
      survivors,
      latestBlockTime: candidates.length
        ? Math.max(
            ...candidates.map(
              (item) =>
                timestamp(
                  item.block_unix_time ??
                    item.liquidityAddedAt ??
                    item.liquidity_added_at,
                ) ?? 0,
            ),
          )
        : null,
      minLiquidity: input.minLiquidity ?? 5000,
    };
  }
}
