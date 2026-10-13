import { EventEmitter } from 'node:events';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BirdeyeStream,
  type BirdeyeSocket,
  type BirdeyeStreamEvent,
} from '../src/server/birdeye-stream.js';

const MINT = 'So11111111111111111111111111111111111111112';
const SECOND = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KEY = 'test-server-key-never-forwarded';
class Socket extends EventEmitter implements BirdeyeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  pings = 0;
  terminated = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  ping() {
    this.pings++;
  }
  close() {
    this.readyState = 3;
    this.emit('close', 1000);
  }
  terminate() {
    this.terminated = true;
    this.close();
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  frame(frame: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(frame)));
  }
}
const instances: BirdeyeStream[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.stop();
  vi.useRealTimers();
});

function fixture(
  options: {
    configured?: boolean;
    request?: (path: string, params?: URLSearchParams) => Promise<unknown>;
  } = {},
) {
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const factory = vi.fn(
    (
      url: string,
      protocols: string[],
      _options: {
        origin?: string;
        handshakeTimeout: number;
        maxPayload: number;
      },
    ) => {
      urls.push(url);
      expect(protocols).toEqual(['echo-protocol']);
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  );
  const instance = new BirdeyeStream({
    env: options.configured === false ? {} : { BIRDEYE_API_KEY: KEY },
    socketFactory: factory,
    random: () => 0.5,
    service: options.request ? { request: options.request } : undefined,
  });
  instances.push(instance);
  return { instance, sockets, urls, factory };
}
const price = (address = MINT) => ({
  type: 'PRICE_DATA',
  data: { address, c: 12, v: 20, unixTime: Math.floor(Date.now() / 1000) - 60 },
});

describe('Birdeye authenticated server streaming', () => {
  it('coalesces market subscriptions, resends the full price list, and scopes each browser to its own mints', () => {
    const f = fixture();
    const a: BirdeyeStreamEvent[] = [];
    const b: BirdeyeStreamEvent[] = [];
    const closeA = f.instance.subscribe(
      { threadId: 'one', prices: [MINT] },
      (event) => a.push(event),
    );
    f.sockets[0].open();
    expect(f.sockets[0].sent[0]).toEqual({
      type: 'SUBSCRIBE_PRICE',
      data: {
        queryType: 'simple',
        chartType: '1m',
        address: MINT,
        currency: 'usd',
        mode: 'raw',
        chartBy: 'price',
      },
    });
    expect(f.factory.mock.calls[0][2].origin).toBeUndefined();
    const closeB = f.instance.subscribe(
      { threadId: 'two', prices: [SECOND] },
      (event) => b.push(event),
    );
    expect(f.sockets).toHaveLength(1);
    const subscription = f.sockets[0].sent
      .filter((message) => message.type === 'SUBSCRIBE_PRICE')
      .at(-1)!;
    expect(JSON.stringify(subscription)).toContain(MINT);
    expect(JSON.stringify(subscription)).toContain(SECOND);
    expect(subscription.data).toMatchObject({
      queryType: 'complex',
      query: expect.stringContaining(' OR '),
    });
    f.sockets[0].frame(price(MINT));
    expect(a.filter((event) => event.kind === 'price')).toHaveLength(1);
    expect(b.filter((event) => event.kind === 'price')).toHaveLength(0);
    closeA();
    const updated = f.sockets[0].sent
      .filter((message) => message.type === 'SUBSCRIBE_PRICE')
      .at(-1)!;
    expect(JSON.stringify(updated)).not.toContain(MINT);
    expect(JSON.stringify(updated)).toContain(SECOND);
    closeB();
    expect(f.sockets[0].terminated).toBe(true);
    expect(f.instance.status().connections).toBe(0);
    expect(new URL(f.urls[0]).origin).toBe('wss://public-api.birdeye.so');
    expect(new URL(f.urls[0]).searchParams.get('x-api-key')).toBe(KEY);
  });

  it('keeps wallet streams isolated and coalesces subscribers for the same wallet', () => {
    const f = fixture();
    const a: BirdeyeStreamEvent[] = [];
    const b: BirdeyeStreamEvent[] = [];
    f.instance.subscribe({ threadId: 'one', wallets: [MINT] }, (event) =>
      a.push(event),
    );
    f.instance.subscribe(
      { threadId: 'also-one', wallets: [MINT] },
      () => undefined,
    );
    f.instance.subscribe({ threadId: 'two', wallets: [SECOND] }, (event) =>
      b.push(event),
    );
    expect(f.sockets).toHaveLength(2);
    for (const socket of f.sockets) socket.open();
    const stream = f.sockets.find((socket) =>
      JSON.stringify(socket.sent).includes(MINT),
    )!;
    stream.frame({
      type: 'WALLET_TXS_DATA',
      data: { owner: MINT, txHash: 'signature', volumeUSD: 50 },
    });
    expect(
      a.filter((event) => event.kind === 'wallet_transaction'),
    ).toHaveLength(1);
    expect(
      b.filter((event) => event.kind === 'wallet_transaction'),
    ).toHaveLength(0);
    stream.frame({
      type: 'WALLET_TXS_DATA',
      data: { owner: SECOND, txHash: 'wrong-owner' },
    });
    expect(
      a.filter((event) => event.kind === 'wallet_transaction'),
    ).toHaveLength(1);
  });

  it('extracts discovery candidates from the base mint and filters large trades independently for each subscriber', () => {
    const f = fixture();
    const events: BirdeyeStreamEvent[] = [];
    f.instance.subscribe(
      {
        threadId: 'discovery',
        newPairs: true,
        newListings: true,
        minVolume: 10_000,
      },
      (event) => events.push(event),
    );
    f.sockets[0].open();
    f.sockets[0].frame({
      type: 'NEW_PAIR_DATA',
      data: {
        address: SECOND,
        base: { address: MINT },
        quote: { address: SECOND },
      },
    });
    expect(
      events.find((event) => event.kind === 'new_pair')?.data,
    ).toMatchObject({
      tokenAddress: MINT,
      poolAddress: SECOND,
      researchCandidate: true,
    });
    f.sockets[0].frame({
      type: 'TXS_LARGE_TRADE_DATA',
      data: { volumeUSD: 999, txHash: 'small' },
    });
    expect(events.filter((event) => event.kind === 'large_trade')).toHaveLength(
      0,
    );
    f.sockets[0].frame({
      type: 'TXS_LARGE_TRADE_DATA',
      data: { volumeUSD: 20_000, txHash: 'large' },
    });
    expect(events.filter((event) => event.kind === 'large_trade')).toHaveLength(
      1,
    );
    expect(JSON.stringify(f.sockets[0].sent)).toContain(
      'SUBSCRIBE_TOKEN_NEW_LISTING',
    );
  });

  it('redacts the exact credential in nested allowed fields, rejects malformed frames, and bounds exposed text', () => {
    const f = fixture();
    const events: BirdeyeStreamEvent[] = [];
    f.instance.subscribe(
      { threadId: 'one', prices: [MINT], newPairs: true },
      (event) => events.push(event),
    );
    f.sockets[0].open();
    f.sockets[0].frame({
      ...price(),
      data: {
        ...price().data,
        name: `normal ${KEY} text`,
        symbol: 'x'.repeat(3000),
        source: `wss://provider?x-api-key=${KEY}`,
        apiKey: KEY,
        secret: KEY,
      },
    });
    const event = events.find((event) => event.kind === 'price')!;
    expect(JSON.stringify(event)).not.toContain(KEY);
    expect(String(event.data.symbol)).toHaveLength(200);
    expect(event.data.name).toContain('[redacted]');
    expect(event.data.source).toBeUndefined();
    f.sockets[0].emit('message', '{invalid-json');
    f.sockets[0].emit('message', 'x'.repeat(256 * 1024 + 1));
    f.sockets[0].frame({
      type: 'PRICE_DATA',
      data: { address: 'bad-mint', c: 1 },
    });
    expect(events.filter((item) => item.kind === 'price')).toHaveLength(1);
  });

  it('surfaces missing configuration and plan denials honestly without leaking URLs or reconnecting rejected credentials', async () => {
    const missing = fixture({ configured: false });
    const disabled: BirdeyeStreamEvent[] = [];
    missing.instance.subscribe({ threadId: 'one', prices: [MINT] }, (event) =>
      disabled.push(event),
    );
    expect(disabled[0].state).toBe('unavailable');
    expect(missing.factory).not.toHaveBeenCalled();
    const f = fixture();
    const events: BirdeyeStreamEvent[] = [];
    f.instance.subscribe({ threadId: 'one', prices: [MINT] }, (event) =>
      events.push(event),
    );
    f.sockets[0].open();
    f.sockets[0].frame({
      type: 'ERROR',
      message: `Business plan required ${KEY}`,
      status: 403,
    });
    expect(events.at(-1)?.state).toBe('unavailable');
    expect(f.instance.status().state).toBe('unavailable');
    expect(JSON.stringify(events)).not.toContain(KEY);
    f.sockets[0].emit('unexpected-response', {}, { statusCode: 403 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.sockets).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'price')).toEqual([]);
  });

  it('treats the actual origin/API-key denial as unavailable and stops the account connection without retrying', async () => {
    const f = fixture();
    const events: BirdeyeStreamEvent[] = [];
    f.instance.subscribe({ threadId: 'one', prices: [MINT] }, (event) =>
      events.push(event),
    );
    f.sockets[0].open();
    f.sockets[0].frame({
      type: 'ERROR',
      data: { message: 'Invalid request with origin or api-key' },
    });
    expect(events.at(-1)).toMatchObject({
      kind: 'status',
      state: 'unavailable',
      error: expect.stringContaining('key or origin settings'),
    });
    expect(f.instance.status().state).toBe('unavailable');
    expect(f.sockets[0].terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.sockets).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'price')).toEqual([]);
  });

  it('checks Dot permissions before every dispatch, releases paused sockets, and resumes only when access returns', () => {
    const f = fixture();
    const events: BirdeyeStreamEvent[] = [];
    let enabled = true;
    f.instance.subscribe(
      { threadId: 'one', prices: [MINT] },
      (event) => events.push(event),
      () => enabled,
    );
    f.sockets[0].open();
    enabled = false;
    f.sockets[0].frame(price());
    expect(events.filter((event) => event.kind === 'price')).toEqual([]);
    f.instance.refresh();
    expect(f.sockets[0].terminated).toBe(true);
    expect(events.at(-1)?.state).toBe('paused');
    enabled = true;
    f.instance.refresh();
    expect(f.sockets).toHaveLength(2);
    f.sockets[1].open();
    f.sockets[1].frame(price());
    expect(events.filter((event) => event.kind === 'price')).toHaveLength(1);
  });

  it('reconnects with jittered backoff, backfills closed candles, and keeps the gap explicit when REST fails', async () => {
    const request = vi.fn(async () => ({
      items: [
        { unix_time: Math.floor(Date.now() / 1000) - 60, c: 12, v: 2 },
        { unix_time: Math.floor(Date.now() / 1000), c: 13, v: 3 },
      ],
    }));
    const f = fixture({ request });
    const events: BirdeyeStreamEvent[] = [];
    f.instance.subscribe({ threadId: 'one', prices: [MINT] }, (event) =>
      events.push(event),
    );
    f.sockets[0].open();
    f.sockets[0].frame(price());
    f.sockets[0].emit('close', 1006);
    expect(events.at(-1)?.data.retryAfterMs).toBe(1000);
    await vi.advanceTimersByTimeAsync(1000);
    f.sockets[1].open();
    await Promise.resolve();
    const backfill = events.find((event) => event.kind === 'backfill');
    expect(backfill?.data.items).toHaveLength(1);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(new Error(`wss://provider?x-api-key=${KEY}`));
    f.sockets[1].emit('close', 1006);
    await vi.advanceTimersByTimeAsync(1000);
    f.sockets[2].open();
    await Promise.resolve();
    expect(events.at(-1)?.error).toContain('gap remain unknown');
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('uses heartbeat pong checks and tears down all timers and provider sockets on shutdown', async () => {
    const f = fixture();
    f.instance.subscribe({ threadId: 'one', prices: [MINT] }, () => undefined);
    f.sockets[0].open();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.sockets[0].pings).toBe(1);
    f.sockets[0].emit('pong');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(f.sockets[0].pings).toBe(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.sockets[0].terminated).toBe(true);
    expect(f.instance.status().state).toBe('reconnecting');
    await f.instance.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.sockets).toHaveLength(1);
    expect(f.instance.status().clients).toBe(0);
  });

  it('rejects over-capacity subscriptions even when a paused client later resumes', () => {
    const f = fixture();
    const addresses = Array.from({ length: 101 }, (_, index) => {
      const bytes = Buffer.alloc(32, 9);
      bytes.writeUInt32BE(index, 0);
      return bs58.encode(bytes);
    });
    f.instance.subscribe(
      { threadId: 'one', prices: addresses.slice(0, 100) },
      () => undefined,
      () => false,
    );
    expect(() =>
      f.instance.subscribe(
        { threadId: 'two', prices: [addresses[100]] },
        () => undefined,
      ),
    ).toThrow('100 distinct prices');
    expect(f.instance.status().clients).toBe(1);
  });
});
