import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import {
  birdeyeSolanaAddress,
  type BirdeyeRequester,
} from './birdeye-monitor.js';

export const birdeyeStreamSchema = z
  .object({
    threadId: z.string().trim().min(1).max(128),
    prices: z
      .array(z.string().refine(birdeyeSolanaAddress))
      .max(100)
      .optional(),
    wallets: z.array(z.string().refine(birdeyeSolanaAddress)).max(8).optional(),
    newPairs: z.boolean().optional(),
    newListings: z.boolean().optional(),
    minVolume: z.number().finite().min(0).max(1e15).optional(),
  })
  .strict();
export type BirdeyeStreamInput = z.infer<typeof birdeyeStreamSchema>;
export type BirdeyeStreamState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'paused'
  | 'unavailable'
  | 'error';
export type BirdeyeStreamEvent = {
  id: string;
  source: 'Birdeye';
  kind:
    | 'status'
    | 'price'
    | 'new_pair'
    | 'new_listing'
    | 'large_trade'
    | 'wallet_transaction'
    | 'backfill';
  observedAt: number;
  state: BirdeyeStreamState;
  data: Record<string, unknown>;
  error?: string;
};
export interface BirdeyeSocket {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): unknown;
  ping(): unknown;
  close(): unknown;
  terminate(): unknown;
}
type SocketFactory = (
  url: string,
  protocols: string[],
  options: { origin?: string; handshakeTimeout: number; maxPayload: number },
) => BirdeyeSocket;
type Subscriber = {
  input: BirdeyeStreamInput;
  listener: (event: BirdeyeStreamEvent) => void;
  enabled: () => boolean;
  paused: boolean;
};
type Demand = {
  prices: string[];
  wallets: string[];
  newPairs: boolean;
  newListings: boolean;
  minVolume?: number;
};
type Connection = {
  id: string;
  socket?: BirdeyeSocket;
  state: BirdeyeStreamState;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  signature: string;
  lastPong: number;
  pingAt?: number;
  disconnectedAt?: number;
  connectedOnce: boolean;
  terminal: boolean;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const safeNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Allow-listed, bounded provider fields; never forwards API keys or arbitrary raw frames. */
export function sanitizeBirdeyeStreamData(
  value: unknown,
  depth = 0,
  apiKey?: string,
): Record<string, unknown> {
  const allowed = new Set([
    'address',
    'name',
    'symbol',
    'source',
    'base',
    'quote',
    'from',
    'to',
    'owner',
    'wallet',
    'poolAddress',
    'txHash',
    'network',
    'type',
    'eventType',
    'unixTime',
    'unix_time',
    'blockTime',
    'blockUnixTime',
    'blockHumanTime',
    'o',
    'h',
    'l',
    'c',
    'v',
    'vUsd',
    'v_usd',
    'volumeUSD',
    'liquidity',
    'decimals',
    'uiAmount',
    'uiChangeAmount',
    'price',
    'nearestPrice',
    'createdAt',
    'isScaled',
    'multiplier',
  ]);
  if (depth > 3) return {};
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record(value)).slice(0, 60)) {
    if (!allowed.has(key)) continue;
    if (
      item == null ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    )
      clean[key] = item;
    else if (
      typeof item === 'string' &&
      !/x-api-key|api[_-]?key\s*[=:]|bearer\s/i.test(item)
    )
      clean[key] = (
        apiKey
          ? item
              .split(apiKey)
              .join('[redacted]')
              .split(encodeURIComponent(apiKey))
              .join('[redacted]')
          : item
      ).slice(0, 200);
    else if (typeof item === 'object' && !Array.isArray(item))
      clean[key] = sanitizeBirdeyeStreamData(item, depth + 1, apiKey);
  }
  return clean;
}

/** One shared connection for market feeds; one coalesced connection per wallet.
 * The wallet feed accepts one address filter, so separate wallet connections avoid
 * replacing another user's subscription. No provider frame can execute a trade.
 */
export class BirdeyeStream {
  private readonly env: NodeJS.ProcessEnv;
  private readonly service?: BirdeyeRequester;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly factory: SocketFactory;
  private subscribers = new Map<string, Subscriber>();
  private connections = new Map<string, Connection>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private stopped = false;
  private inflight = new Set<Promise<void>>();
  private lastCandles = new Map<string, number>();

  constructor(
    options: {
      env?: NodeJS.ProcessEnv;
      service?: BirdeyeRequester;
      now?: () => number;
      random?: () => number;
      socketFactory?: SocketFactory;
    } = {},
  ) {
    this.env = options.env ?? process.env;
    this.service = options.service;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.factory =
      options.socketFactory ??
      ((url, protocols, opts) =>
        new WebSocket(url, protocols, opts) as unknown as BirdeyeSocket);
  }

  status() {
    const states = [...this.connections.values()].map(
      (connection) => connection.state,
    );
    const state: BirdeyeStreamState = !this.env.BIRDEYE_API_KEY?.trim()
      ? 'unavailable'
      : states.includes('live')
        ? 'live'
        : states.includes('unavailable')
          ? 'unavailable'
          : states.includes('reconnecting')
            ? 'reconnecting'
            : states.includes('connecting')
              ? 'connecting'
              : this.subscribers.size
                ? 'paused'
                : 'idle';
    return {
      source: 'Birdeye' as const,
      state,
      observedAt: this.now(),
      clients: this.subscribers.size,
      connections: this.connections.size,
    };
  }

  subscribe(
    input: BirdeyeStreamInput,
    listener: (event: BirdeyeStreamEvent) => void,
    enabled: () => boolean = () => true,
  ): () => void {
    if (this.stopped) throw new Error('Birdeye streaming has stopped.');
    const parsed = birdeyeStreamSchema.parse(input);
    if (!(
      parsed.prices?.length ||
      parsed.wallets?.length ||
      parsed.newPairs ||
      parsed.newListings ||
      parsed.minVolume != null
    ))
      throw new Error('Choose at least one Birdeye live feed.');
    const id = randomUUID();
    this.subscribers.set(id, {
      input: parsed,
      listener,
      enabled,
      paused: false,
    });
    const all = [...this.subscribers.values()];
    if (
      new Set(all.flatMap(({ input }) => input.prices ?? [])).size > 100 ||
      new Set(all.flatMap(({ input }) => input.wallets ?? [])).size > 8
    ) {
      this.subscribers.delete(id);
      throw new Error(
        'Live Birdeye feeds support up to 100 distinct prices and 8 distinct wallets per account.',
      );
    }
    this.deliver(
      this.subscribers.get(id)!,
      this.event(
        'status',
        this.env.BIRDEYE_API_KEY?.trim() ? 'connecting' : 'unavailable',
        {},
        this.env.BIRDEYE_API_KEY?.trim()
          ? undefined
          : 'BIRDEYE_API_KEY is not configured on the server.',
      ),
    );
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.refresh(), 5000);
      this.heartbeat.unref?.();
    }
    this.refresh();
    const main = this.connections.get('main');
    if (
      this.allowed(this.subscribers.get(id)!) &&
      main?.state === 'live' &&
      (parsed.prices?.length ||
        parsed.newPairs ||
        parsed.newListings ||
        parsed.minVolume != null)
    ) {
      this.deliver(
        this.subscribers.get(id)!,
        this.event('status', 'live', {
          channel: 'market',
          candlesAreFinal: false,
        }),
      );
    }
    return () => {
      this.subscribers.delete(id);
      this.refresh();
      if (!this.subscribers.size && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    };
  }

  private allowed(subscriber: Subscriber) {
    try {
      return !this.stopped && subscriber.enabled();
    } catch {
      return false;
    }
  }
  private demand(): Demand {
    const active = [...this.subscribers.values()].filter((subscriber) =>
      this.allowed(subscriber),
    );
    const volumes = active.flatMap(({ input }) =>
      input.minVolume == null ? [] : [input.minVolume],
    );
    return {
      prices: [
        ...new Set(active.flatMap(({ input }) => input.prices ?? [])),
      ].sort(),
      wallets: [
        ...new Set(active.flatMap(({ input }) => input.wallets ?? [])),
      ].sort(),
      newPairs: active.some(({ input }) => input.newPairs),
      newListings: active.some(({ input }) => input.newListings),
      ...(volumes.length ? { minVolume: Math.min(...volumes) } : {}),
    };
  }

  /** Re-check permission callbacks immediately when workspace settings change. */
  refresh() {
    if (this.stopped) return;
    for (const subscriber of this.subscribers.values()) {
      const paused = !this.allowed(subscriber);
      if (paused && !subscriber.paused)
        this.deliver(
          subscriber,
          this.event(
            'status',
            'paused',
            {},
            'The Dot is paused or research access is disabled.',
          ),
        );
      subscriber.paused = paused;
    }
    const demand = this.demand();
    const desired = new Set<string>(
      demand.wallets.map((wallet) => `wallet:${wallet}`),
    );
    if (
      demand.prices.length ||
      demand.newPairs ||
      demand.newListings ||
      demand.minVolume != null
    )
      desired.add('main');
    for (const [id, connection] of this.connections) {
      if (!desired.has(id)) {
        this.drop(connection);
        this.connections.delete(id);
      }
    }
    if (!this.env.BIRDEYE_API_KEY?.trim()) return;
    for (const id of desired) {
      let connection = this.connections.get(id);
      if (!connection) {
        connection = {
          id,
          state: 'connecting',
          attempt: 0,
          signature: '',
          lastPong: this.now(),
          connectedOnce: false,
          terminal: false,
        };
        this.connections.set(id, connection);
      }
      if (!connection.socket && !connection.timer && !connection.terminal)
        this.connect(connection);
      if (connection.socket?.readyState === WebSocket.OPEN) {
        this.subscribeUpstream(connection, demand);
        if (
          connection.pingAt != null &&
          this.now() - connection.pingAt > 10_000
        ) {
          this.lost(
            connection,
            'Birdeye did not answer a heartbeat; reconnecting.',
          );
        } else if (
          connection.pingAt == null &&
          this.now() - connection.lastPong >= 25_000
        ) {
          try {
            connection.socket.ping();
            connection.pingAt = this.now();
          } catch {
            this.lost(connection, 'Birdeye heartbeat failed; reconnecting.');
          }
        }
      }
    }
  }

  private connect(connection: Connection) {
    if (this.stopped || !this.connections.has(connection.id)) return;
    connection.state = connection.connectedOnce ? 'reconnecting' : 'connecting';
    this.broadcast(
      this.event('status', connection.state, {
        channel: connection.id === 'main' ? 'market' : 'wallet',
      }),
      connection.id,
    );
    // Fixed provider host; the API key never enters an SSE frame or log.
    const url = new URL('wss://public-api.birdeye.so/socket/solana');
    url.searchParams.set('x-api-key', this.env.BIRDEYE_API_KEY!.trim());
    try {
      const socket = this.factory(url.toString(), ['echo-protocol'], {
        ...(connection.id.startsWith('wallet:')
          ? { origin: 'ws://public-api.birdeye.so' }
          : {}),
        handshakeTimeout: 15_000,
        maxPayload: 256 * 1024,
      });
      connection.socket = socket;
      socket.on('open', () => {
        if (connection.socket !== socket || this.stopped) return;
        const reconnect = connection.connectedOnce;
        connection.connectedOnce = true;
        connection.state = 'live';
        connection.attempt = 0;
        connection.lastPong = this.now();
        connection.pingAt = undefined;
        connection.signature = '';
        this.subscribeUpstream(connection, this.demand());
        this.broadcast(
          this.event('status', 'live', {
            channel: connection.id === 'main' ? 'market' : 'wallet',
            candlesAreFinal: false,
          }),
          connection.id,
        );
        if (reconnect && connection.id === 'main') {
          const promise = this.backfill(connection, socket).finally(() =>
            this.inflight.delete(promise),
          );
          this.inflight.add(promise);
        }
      });
      socket.on('pong', () => {
        if (connection.socket === socket) {
          connection.lastPong = this.now();
          connection.pingAt = undefined;
        }
      });
      socket.on('message', (data) => {
        if (connection.socket === socket) this.receive(connection, data);
      });
      socket.on('close', (code) => {
        if (connection.socket !== socket) return;
        if (code === 1008 || code === 4001 || code === 4003)
          this.unavailable(connection);
        else
          this.lost(
            connection,
            'The Birdeye live connection closed; reconnecting with backoff.',
          );
      });
      socket.on('error', () => {
        if (connection.socket === socket)
          this.lost(
            connection,
            'Birdeye live connection failed; reconnecting with backoff.',
          );
      });
      socket.on('unexpected-response', (_request, response) => {
        if (connection.socket !== socket) return;
        const status = record(response).statusCode;
        if (status === 401 || status === 403) this.unavailable(connection);
        else
          this.lost(
            connection,
            'Birdeye rejected the live connection; reconnecting with backoff.',
          );
      });
    } catch {
      this.lost(
        connection,
        'Birdeye live connection could not start; reconnecting with backoff.',
      );
    }
  }

  private subscribeUpstream(connection: Connection, demand: Demand) {
    const socket = connection.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const selection =
      connection.id === 'main'
        ? {
            prices: demand.prices,
            newPairs: demand.newPairs,
            newListings: demand.newListings,
            minVolume: demand.minVolume,
          }
        : { wallet: connection.id.slice(7) };
    const signature = JSON.stringify(selection);
    if (signature === connection.signature) return;
    const previous = connection.signature
      ? record(JSON.parse(connection.signature))
      : {};
    try {
      if (connection.id !== 'main')
        socket.send(
          JSON.stringify({
            type: 'SUBSCRIBE_WALLET_TXS',
            data: { address: connection.id.slice(7) },
          }),
        );
      else {
        if (demand.prices.length)
          socket.send(
            JSON.stringify({
              type: 'SUBSCRIBE_PRICE',
              data:
                demand.prices.length === 1
                  ? {
                      queryType: 'simple',
                      chartType: '1m',
                      address: demand.prices[0],
                      currency: 'usd',
                      mode: 'raw',
                      chartBy: 'price',
                    }
                  : {
                      queryType: 'complex',
                      query: demand.prices
                        .map(
                          (address) =>
                            `(address = ${address} AND chartType = 1m AND currency = usd)`,
                        )
                        .join(' OR '),
                    },
            }),
          );
        else if (Array.isArray(previous.prices) && previous.prices.length)
          socket.send(JSON.stringify({ type: 'UNSUBSCRIBE_PRICE' }));
        if (demand.newPairs)
          socket.send(JSON.stringify({ type: 'SUBSCRIBE_NEW_PAIR' }));
        else if (previous.newPairs)
          socket.send(JSON.stringify({ type: 'UNSUBSCRIBE_NEW_PAIR' }));
        if (demand.newListings)
          socket.send(
            JSON.stringify({
              type: 'SUBSCRIBE_TOKEN_NEW_LISTING',
              meme_platform_enabled: true,
              min_liquidity: 1000,
            }),
          );
        else if (previous.newListings)
          socket.send(
            JSON.stringify({ type: 'UNSUBSCRIBE_TOKEN_NEW_LISTING' }),
          );
        if (demand.minVolume != null)
          socket.send(
            JSON.stringify({
              type: 'SUBSCRIBE_LARGE_TRADE_TXS',
              min_volume: demand.minVolume,
            }),
          );
        else if (previous.minVolume != null)
          socket.send(JSON.stringify({ type: 'UNSUBSCRIBE_LARGE_TRADE_TXS' }));
      }
      connection.signature = signature;
    } catch {
      this.lost(
        connection,
        'Birdeye subscription could not be updated; reconnecting.',
      );
    }
  }

  private receive(connection: Connection, raw: unknown) {
    let payload: Record<string, unknown>;
    try {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : '';
      if (!text || Buffer.byteLength(text) > 256 * 1024) return;
      payload = record(JSON.parse(text));
    } catch {
      return;
    }
    if (typeof payload.type !== 'string') return;
    const details = record(payload.data);
    if (
      /ERROR|FAIL/i.test(payload.type) ||
      payload.success === false ||
      details.success === false ||
      payload.error != null ||
      details.error != null
    ) {
      const reason = String(
        payload.message ??
          payload.error ??
          details.message ??
          details.error ??
          (typeof payload.data === 'string' ? payload.data : ''),
      );
      if (
        /invalid request.*origin.*api.?key|invalid api.?key|authentication failed|unauthorized|unauthorised/i.test(
          reason,
        ) ||
        payload.status === 401 ||
        details.status === 401
      ) {
        this.unavailable(
          connection,
          "Birdeye rejected this live subscription for its key or origin settings. Check the server key's WebSocket permissions and allowed origins.",
        );
        return;
      }
      const entitlement =
        /plan|premium|business|entitle|forbidden|unauthoriz|permission/i.test(
          reason,
        ) ||
        payload.status === 403 ||
        payload.status === 401 ||
        details.status === 403 ||
        details.status === 401;
      connection.state = entitlement ? 'unavailable' : 'error';
      this.broadcast(
        this.event(
          'status',
          entitlement ? 'unavailable' : 'error',
          { providerType: payload.type.slice(0, 100) },
          entitlement
            ? 'This Birdeye live subscription is not available on the configured account. Use REST research or upgrade its entitlement.'
            : 'Birdeye rejected a live subscription. No market event was generated.',
        ),
        connection.id,
      );
      return;
    }
    const kinds: Record<string, BirdeyeStreamEvent['kind']> = {
      PRICE_DATA: 'price',
      NEW_PAIR_DATA: 'new_pair',
      TOKEN_NEW_LISTING_DATA: 'new_listing',
      TXS_LARGE_TRADE_DATA: 'large_trade',
      WALLET_TXS_DATA: 'wallet_transaction',
    };
    const kind = kinds[payload.type];
    if (!kind) return;
    for (const rawData of Array.isArray(payload.data)
      ? payload.data.slice(0, 100)
      : [payload.data]) {
      const data = sanitizeBirdeyeStreamData(
        rawData,
        0,
        this.env.BIRDEYE_API_KEY?.trim(),
      );
      if (!Object.keys(data).length) continue;
      if (kind === 'price') {
        if (
          !birdeyeSolanaAddress(data.address) ||
          safeNumber(data.c) == null ||
          safeNumber(data.unixTime ?? data.unix_time) == null
        )
          continue;
        const unixTime = Number(data.unixTime ?? data.unix_time);
        if (
          unixTime > this.now() / 1000 + 60 ||
          unixTime < this.now() / 1000 - 3600
        )
          continue;
        this.lastCandles.set(
          data.address,
          Math.max(this.lastCandles.get(data.address) ?? 0, unixTime),
        );
      }
      if (kind === 'new_pair') {
        const tokenAddress = record(data.base).address;
        if (!birdeyeSolanaAddress(tokenAddress)) continue;
        data.tokenAddress = tokenAddress;
        data.poolAddress = data.address;
        data.researchCandidate = true;
      }
      if (kind === 'new_listing' && !birdeyeSolanaAddress(data.address))
        continue;
      if (
        kind === 'wallet_transaction' &&
        data.owner !== connection.id.slice(7)
      )
        continue;
      this.broadcast(this.event(kind, 'live', data), connection.id);
    }
  }

  private event(
    kind: BirdeyeStreamEvent['kind'],
    state: BirdeyeStreamState,
    data: Record<string, unknown>,
    error?: string,
  ): BirdeyeStreamEvent {
    return {
      id: randomUUID(),
      source: 'Birdeye',
      kind,
      observedAt: this.now(),
      state,
      data: this.redactKey(data),
      ...(error ? { error } : {}),
    };
  }
  private redactKey(data: Record<string, unknown>): Record<string, unknown> {
    const key = this.env.BIRDEYE_API_KEY?.trim();
    const encoded = key ? encodeURIComponent(key) : '';
    return Object.fromEntries(
      Object.entries(data).map(([field, value]) => [
        field,
        typeof value === 'string' && key
          ? value
              .split(key)
              .join('[redacted]')
              .split(encoded)
              .join('[redacted]')
          : value && typeof value === 'object' && !Array.isArray(value)
            ? this.redactKey(value as Record<string, unknown>)
            : value,
      ]),
    );
  }
  private deliver(subscriber: Subscriber, event: BirdeyeStreamEvent) {
    try {
      subscriber.listener(event);
    } catch {
      /* A disconnected browser cannot stop other subscribers. */
    }
  }
  private broadcast(event: BirdeyeStreamEvent, channel: string) {
    for (const subscriber of this.subscribers.values()) {
      if (!this.allowed(subscriber)) continue;
      const input = subscriber.input;
      if (
        channel.startsWith('wallet:') &&
        !(input.wallets ?? []).includes(channel.slice(7))
      )
        continue;
      if (
        channel === 'main' &&
        event.kind === 'status' &&
        !(
          input.prices?.length ||
          input.newPairs ||
          input.newListings ||
          input.minVolume != null
        )
      )
        continue;
      if (
        event.kind === 'status' &&
        event.data.address &&
        !(input.prices ?? []).includes(String(event.data.address))
      )
        continue;
      if (
        (event.kind === 'price' || event.kind === 'backfill') &&
        !(input.prices ?? []).includes(String(event.data.address))
      )
        continue;
      if (
        (event.kind === 'new_pair' && !input.newPairs) ||
        (event.kind === 'new_listing' && !input.newListings)
      )
        continue;
      if (
        event.kind === 'large_trade' &&
        (input.minVolume == null ||
          safeNumber(event.data.volumeUSD) == null ||
          Number(event.data.volumeUSD) < input.minVolume)
      )
        continue;
      this.deliver(subscriber, event);
    }
  }

  private drop(connection: Connection) {
    if (connection.timer) clearTimeout(connection.timer);
    connection.timer = undefined;
    const socket = connection.socket;
    connection.socket = undefined;
    if (socket) {
      try {
        socket.terminate();
      } catch {
        /* already closed */
      }
    }
  }
  private unavailable(
    connection: Connection,
    error = 'Birdeye denied this live feed. Check the configured API key and account streaming entitlement; REST remains available.',
  ) {
    this.drop(connection);
    connection.terminal = true;
    connection.state = 'unavailable';
    this.broadcast(
      this.event('status', 'unavailable', {}, error),
      connection.id,
    );
  }
  private lost(connection: Connection, error: string) {
    this.drop(connection);
    if (this.stopped || !this.connections.has(connection.id)) return;
    connection.disconnectedAt ??= this.now();
    connection.state = 'reconnecting';
    const delay =
      Math.min(30_000, 1000 * 2 ** Math.min(connection.attempt++, 5)) *
      (0.75 + this.random() * 0.5);
    this.broadcast(
      this.event(
        'status',
        'reconnecting',
        { retryAfterMs: Math.round(delay) },
        error,
      ),
      connection.id,
    );
    connection.timer = setTimeout(() => {
      connection.timer = undefined;
      this.connect(connection);
    }, delay);
    connection.timer.unref?.();
  }

  private async backfill(connection: Connection, socket: BirdeyeSocket) {
    if (!this.service) {
      this.broadcast(
        this.event(
          'status',
          'live',
          { backfillAvailable: false },
          'The live feed reconnected. REST candle backfill is not configured.',
        ),
        connection.id,
      );
      return;
    }
    const unixNow = Math.floor(this.now() / 1000);
    for (const address of this.demand().prices) {
      if (
        this.stopped ||
        connection.socket !== socket ||
        !this.demand().prices.includes(address)
      )
        break;
      const from = Math.max(
        unixNow - 3600,
        this.lastCandles.get(address) ??
          Math.floor((connection.disconnectedAt ?? this.now()) / 1000) - 60,
      );
      try {
        const raw = record(
          await this.service.request(
            '/defi/v3/ohlcv',
            new URLSearchParams({
              address,
              type: '1m',
              time_from: String(from),
              time_to: String(unixNow),
            }),
          ),
        );
        if (this.stopped || connection.socket !== socket) break;
        const items = (Array.isArray(raw.items) ? raw.items : [])
          .slice(0, 100)
          .map((item) =>
            sanitizeBirdeyeStreamData(
              item,
              0,
              this.env.BIRDEYE_API_KEY?.trim(),
            ),
          )
          .filter((item) => {
            const time = safeNumber(item.unix_time ?? item.unixTime);
            return (
              time != null &&
              time >= from &&
              time + 60 <= unixNow &&
              safeNumber(item.c) != null
            );
          });
        this.broadcast(
          this.event('backfill', 'live', {
            address,
            items,
            timeFrom: from,
            timeTo: unixNow,
            maxGapSeconds: 3600,
          }),
          connection.id,
        );
      } catch (error) {
        if (connection.socket === socket)
          this.broadcast(
            this.event(
              'status',
              'live',
              { address, backfillAvailable: false },
              'Birdeye REST backfill failed; candles in the reconnect gap remain unknown.',
            ),
            connection.id,
          );
        if (
          [
            'tier-unavailable',
            'quota-limited',
            'authentication-error',
            'missing-configuration',
          ].includes(String(record(error).code))
        )
          break;
      }
    }
    connection.disconnectedAt = undefined;
  }

  async stop() {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const connection of this.connections.values()) this.drop(connection);
    this.connections.clear();
    this.subscribers.clear();
    await Promise.allSettled(this.inflight);
  }
}
