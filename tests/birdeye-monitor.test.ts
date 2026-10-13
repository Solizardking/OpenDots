import { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BirdeyeMonitor,
  type BirdeyeAlertInput,
} from '../src/server/birdeye-monitor.js';

const MINT = 'So11111111111111111111111111111111111111112';
const SECOND = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const databases: DatabaseSync[] = [];
const monitors: BirdeyeMonitor[] = [];
afterEach(async () => {
  for (const monitor of monitors.splice(0)) await monitor.stop();
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

function fixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  let unix = 1_800_000_000;
  let price = 9;
  let timestamp: number | undefined;
  let volume = 5;
  let candles: Record<string, unknown>[] | undefined;
  let enabled = true;
  const requests: { path: string; params: URLSearchParams }[] = [];
  const request = vi.fn(
    async (
      path: string,
      params: URLSearchParams = new URLSearchParams(),
    ): Promise<unknown> => {
      requests.push({ path, params });
      if (path === '/defi/multi_price')
        return Object.fromEntries(
          params
            .get('list_address')!
            .split(',')
            .map((address) => [
              address,
              {
                value: price,
                updateUnixTime: timestamp ?? unix,
                priceChange24h: 30,
              },
            ]),
        );
      if (path === '/defi/v3/price/stats/single')
        return {
          data: [
            {
              address: MINT,
              data: [
                {
                  timeframe: params.get('list_timeframe'),
                  price_change_percent: 30,
                },
              ],
            },
          ],
        };
      if (path === '/defi/v3/ohlcv')
        return {
          items: candles ?? [
            { unix_time: unix - 900, c: price, v: volume },
            { unix_time: unix, c: 100, v: 100 },
          ],
        };
      throw new Error('Unexpected provider request');
    },
  );
  const monitor = new BirdeyeMonitor({
    database,
    service: { request },
    now: () => unix * 1000,
    enabled: () => enabled,
  });
  monitors.push(monitor);
  const input: BirdeyeAlertInput = {
    threadId: 'thread-1',
    address: MINT,
    kind: 'absolute',
    direction: 'above',
    threshold: 10,
  };
  return {
    database,
    monitor,
    input,
    request,
    requests,
    now: () => unix * 1000,
    change: (options: {
      price?: number;
      timestamp?: number;
      volume?: number;
      candles?: Record<string, unknown>[];
      enabled?: boolean;
      advance?: number;
    }) => {
      unix += options.advance ?? 900;
      if (options.price != null) price = options.price;
      if (options.timestamp != null) timestamp = options.timestamp;
      if (options.volume != null) volume = options.volume;
      if (options.candles != null) candles = options.candles;
      if (options.enabled != null) enabled = options.enabled;
    },
  };
}

describe('Birdeye persisted price alerts', () => {
  it('quietly rebuilds state, fires once per confirmed crossing, and rearms only after a closed reverse crossing', async () => {
    const f = fixture();
    const alert = f.monitor.create(f.input);
    expect((await f.monitor.poll('thread-1')).events).toEqual([]);
    f.change({ price: 12 });
    const first = await f.monitor.poll('thread-1');
    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toMatchObject({
      alertId: alert.id,
      price: 12,
      kind: 'absolute',
      direction: 'above',
      source: 'Birdeye',
    });
    f.change({ price: 13 });
    expect((await f.monitor.poll('thread-1')).events).toHaveLength(1);
    f.change({ price: 8 });
    expect((await f.monitor.poll('thread-1')).alerts[0].triggered).toBe(false);
    f.change({ price: 11 });
    expect((await f.monitor.poll('thread-1')).events).toHaveLength(2);
  });

  it('preserves debounce across restart and does not turn an already crossed threshold into a new alert', async () => {
    const f = fixture();
    f.change({ price: 12 });
    f.monitor.create(f.input);
    expect((await f.monitor.poll()).alerts[0].triggered).toBe(true);
    await f.monitor.stop();
    const restarted = new BirdeyeMonitor({
      database: f.database,
      service: { request: f.request },
      now: f.now,
    });
    monitors.push(restarted);
    f.change({ price: 13 });
    expect((await restarted.poll()).events).toEqual([]);
    expect(restarted.list()[0].triggered).toBe(true);
  });

  it('rejects stale prices, null tokens, zero-volume candles and still-forming wicks without phantom events', async () => {
    const f = fixture();
    f.monitor.create(f.input);
    await f.monitor.poll();
    f.change({ price: 15, timestamp: f.now() / 1000 - 9000 });
    expect((await f.monitor.poll()).alerts[0].lastError).toContain('stale');
    f.change({ timestamp: f.now() / 1000 + 900, volume: 0 });
    expect((await f.monitor.poll()).alerts[0].lastError).toContain(
      'closed candle',
    );
    f.change({ candles: [{ unix_time: f.now() / 1000 + 900, c: 15, v: 8 }] });
    expect((await f.monitor.poll()).events).toEqual([]);
    const service = { request: vi.fn(async () => ({ [SECOND]: null })) };
    const absent = new BirdeyeMonitor({
      database: f.database,
      service,
      now: f.now,
    });
    monitors.push(absent);
    absent.create({ ...f.input, address: SECOND, threadId: 'null-token' });
    const result = await absent.poll('null-token');
    expect(result.alerts[0].lastError).toContain('No tracked price');
    expect(result.events).toEqual([]);
  });

  it('uses nested snake-case percent stats for screening and the exact closed baseline for confirmation', async () => {
    const f = fixture();
    const base = f.now() / 1000 - 4500;
    f.change({
      advance: 0,
      candles: [
        { unix_time: base, c: 10, v: 20 },
        { unix_time: base + 3600, c: 10, v: 15 },
      ],
    });
    f.monitor.create({
      ...f.input,
      kind: 'percent',
      threshold: 20,
      timeframe: '1h',
    });
    await f.monitor.poll();
    f.change({
      candles: [
        { unix_time: base + 900, c: 10, v: 20 },
        { unix_time: base + 4500, c: 13, v: 15 },
      ],
    });
    const result = await f.monitor.poll();
    expect(result.events).toHaveLength(1);
    expect(result.events[0].value).toBeCloseTo(30);
    expect(
      f.requests.some(
        ({ path, params }) =>
          path.endsWith('stats/single') &&
          params.get('list_timeframe') === '1h',
      ),
    ).toBe(true);
  });

  it('does not substitute an arbitrary older candle when a custom baseline is missing', async () => {
    const f = fixture();
    const base = f.now() / 1000 - 3600;
    f.monitor.create({
      ...f.input,
      kind: 'percent',
      threshold: 20,
      baselineUnixTime: base,
    });
    f.change({
      advance: 0,
      candles: [
        { unix_time: base + 1800, c: 10, v: 20 },
        { unix_time: base + 2700, c: 13, v: 20 },
      ],
    });
    const result = await f.monitor.poll();
    expect(result.alerts[0].lastError).toContain('exact baseline');
    expect(result.events).toEqual([]);
  });

  it('batches at 100 unique addresses and keeps CRUD and history scoped to each thread', async () => {
    const f = fixture();
    for (let i = 0; i < 101; i++) {
      const bytes = Buffer.alloc(32, 7);
      bytes.writeUInt32BE(i, 0);
      f.monitor.create({ ...f.input, address: bs58.encode(bytes) });
    }
    await f.monitor.poll('thread-1');
    const batches = f.requests.filter(
      ({ path }) => path === '/defi/multi_price',
    );
    expect(
      batches.map(
        ({ params }) => params.get('list_address')!.split(',').length,
      ),
    ).toEqual([100, 1]);
    const privateAlert = f.monitor.create({ ...f.input, threadId: 'thread-2' });
    expect(f.monitor.list('thread-1')).toHaveLength(101);
    expect(f.monitor.remove(privateAlert.id, 'thread-1')).toBe(false);
    expect(f.monitor.list('thread-2')).toHaveLength(1);
  });

  it('serializes concurrent manual checks and enforces pause before background work', async () => {
    const f = fixture();
    f.monitor.create(f.input);
    await f.monitor.poll();
    f.change({ price: 12 });
    await Promise.all([f.monitor.poll(), f.monitor.poll(), f.monitor.poll()]);
    expect(f.monitor.events()).toHaveLength(1);
    f.change({ enabled: false });
    f.request.mockClear();
    expect((await f.monitor.poll()).state).toBe('paused');
    expect(f.request).not.toHaveBeenCalled();
    await f.monitor.stop();
    expect((await f.monitor.poll()).state).toBe('paused');
  });

  it('backs off denied provider requests and never persists a provider credential in errors', async () => {
    const f = fixture();
    f.monitor.create(f.input);
    f.request.mockRejectedValue(
      Object.assign(new Error('https://example?x-api-key=SECRET'), {
        code: 'tier-unavailable',
      }),
    );
    const result = await f.monitor.poll();
    expect(result.state).toBe('error');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    await f.monitor.poll();
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('does not call a missing-key provider and waits for an in-flight pass during shutdown', async () => {
    const f = fixture();
    const missing = new BirdeyeMonitor({
      database: f.database,
      service: { request: f.request, status: () => ({ configured: false }) },
      now: f.now,
    });
    monitors.push(missing);
    missing.create(f.input);
    expect((await missing.poll()).error).toContain('not configured');
    expect(f.request).not.toHaveBeenCalled();
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.monitor.poll();
    await Promise.resolve();
    let stopped = false;
    const stop = f.monitor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish({ [MINT]: { value: 9, updateUnixTime: f.now() / 1000 } });
    await pending;
    await stop;
    expect(stopped).toBe(true);
  });
});
