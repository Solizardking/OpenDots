import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import bs58 from 'bs58';
import { z } from 'zod';

export interface BirdeyeRequester {
  request(
    path: string,
    params?: URLSearchParams,
    body?: Record<string, unknown>,
  ): Promise<unknown>;
  status?(): {
    configured?: boolean;
    state?: string;
    credits?: { remaining: number | null; checkedAt: number; low: boolean };
  };
}
export type BirdeyeAlertInput = {
  threadId: string;
  address: string;
  label?: string;
  kind: 'absolute' | 'percent';
  direction: 'above' | 'below';
  threshold: number;
  timeframe?: '1h' | '4h' | '24h';
  baselineUnixTime?: number;
  enabled?: boolean;
};
export type BirdeyeAlert = BirdeyeAlertInput & {
  id: string;
  createdAt: number;
  triggered: boolean;
  lastPrice: number | null;
  lastObservedAt: number | null;
  lastError: string | null;
  confirmedUnixTime: number | null;
};
export type BirdeyeAlertEvent = {
  id: string;
  alertId: string;
  threadId: string;
  address: string;
  label?: string;
  source: 'Birdeye';
  observedAt: number;
  candleUnixTime: number;
  price: number;
  value: number;
  threshold: number;
  direction: 'above' | 'below';
  kind: 'absolute' | 'percent';
};
export type BirdeyeMonitorResult = {
  source: 'Birdeye';
  state: 'idle' | 'paused' | 'ready' | 'degraded' | 'error';
  checkedAt: number;
  alerts: BirdeyeAlert[];
  events: BirdeyeAlertEvent[];
  error?: string;
};

type Candle = { unixTime: number; close: number; volume: number };
const INTERVAL = 900;
const WINDOWS = { '1h': 3600, '4h': 14400, '24h': 86400 };
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown): number | null => {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
export function birdeyeSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
    return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
export const birdeyeAlertSchema = z
  .object({
    threadId: z.string().trim().min(1).max(128),
    address: z
      .string()
      .refine(birdeyeSolanaAddress, 'Enter a valid Solana token mint.'),
    label: z.string().max(100).optional(),
    kind: z.enum(['absolute', 'percent']),
    direction: z.enum(['above', 'below']),
    threshold: z.number().finite(),
    timeframe: z.enum(['1h', '4h', '24h']).optional(),
    baselineUnixTime: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const crossed = (value: number, alert: BirdeyeAlert) =>
  alert.direction === 'above'
    ? value >= alert.threshold
    : value <= alert.threshold;

/** The monitor stores observations only; it cannot sign or execute transactions. */
export class BirdeyeMonitor {
  private readonly service: BirdeyeRequester;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly enabled: (threadId: string) => boolean;
  private rebuilt = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private failures = 0;
  private nextProviderAttemptAt = 0;
  private providerError?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    service: BirdeyeRequester;
    database: DatabaseSync;
    enabled?: (threadId: string) => boolean;
    now?: () => number;
  }) {
    this.service = options.service;
    this.db = options.database;
    this.now = options.now ?? Date.now;
    this.enabled = options.enabled ?? (() => true);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS birdeye_alerts (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS birdeye_alerts_thread ON birdeye_alerts(thread_id);
      CREATE TABLE IF NOT EXISTS birdeye_alert_events (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, alert_id TEXT NOT NULL,
        value TEXT NOT NULL, observed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS birdeye_alert_events_thread ON birdeye_alert_events(thread_id, observed_at);
    `);
  }

  list(threadId?: string): BirdeyeAlert[] {
    const rows = (
      threadId
        ? this.db
            .prepare(
              'SELECT value FROM birdeye_alerts WHERE thread_id=? ORDER BY created_at',
            )
            .all(threadId)
        : this.db
            .prepare('SELECT value FROM birdeye_alerts ORDER BY created_at')
            .all()
    ) as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as BirdeyeAlert);
  }

  create(input: BirdeyeAlertInput): BirdeyeAlert {
    if (
      !input ||
      typeof input.threadId !== 'string' ||
      !input.threadId.trim() ||
      input.threadId.length > 128
    )
      throw new Error('A thread is required for a Birdeye alert.');
    if (!birdeyeSolanaAddress(input.address))
      throw new Error('Enter a valid Solana token mint.');
    if (
      !['absolute', 'percent'].includes(input.kind) ||
      !['above', 'below'].includes(input.direction)
    )
      throw new Error(
        'Choose an absolute or percent alert and an above or below threshold.',
      );
    if (
      typeof input.threshold !== 'number' ||
      !Number.isFinite(input.threshold) ||
      (input.kind === 'absolute' && input.threshold <= 0) ||
      Math.abs(input.threshold) > 1e15
    )
      throw new Error(
        'The alert threshold must be a finite number; absolute prices must be positive.',
      );
    if (input.timeframe != null && !Object.hasOwn(WINDOWS, input.timeframe))
      throw new Error('Choose a 1h, 4h, or 24h percent window.');
    const unixNow = Math.floor(this.now() / 1000);
    if (
      input.baselineUnixTime != null &&
      (!Number.isInteger(input.baselineUnixTime) ||
        input.baselineUnixTime > unixNow - INTERVAL ||
        input.baselineUnixTime < unixNow - 30 * 86400)
    )
      throw new Error(
        'The custom baseline must be a closed candle within the past 30 days.',
      );
    if (input.enabled != null && typeof input.enabled !== 'boolean')
      throw new Error('Alert enabled must be a boolean.');
    if (input.label != null && typeof input.label !== 'string')
      throw new Error('The alert label must be text.');
    if (this.list().length >= 500)
      throw new Error('This workspace supports up to 500 saved alerts.');
    const alert: BirdeyeAlert = {
      id: randomUUID(),
      threadId: input.threadId,
      address: input.address,
      label: input.label?.slice(0, 100),
      kind: input.kind,
      direction: input.direction,
      threshold: input.threshold,
      ...(input.kind === 'percent'
        ? {
            timeframe: input.timeframe ?? '24h',
            baselineUnixTime: input.baselineUnixTime,
          }
        : {}),
      enabled: input.enabled ?? true,
      createdAt: this.now(),
      triggered: false,
      lastPrice: null,
      lastObservedAt: null,
      lastError: null,
      confirmedUnixTime: null,
    };
    this.db
      .prepare('INSERT INTO birdeye_alerts VALUES (?, ?, ?, ?)')
      .run(alert.id, alert.threadId, JSON.stringify(alert), alert.createdAt);
    return alert;
  }

  remove(id: string, threadId?: string): boolean {
    const result = threadId
      ? this.db
          .prepare('DELETE FROM birdeye_alerts WHERE id=? AND thread_id=?')
          .run(id, threadId)
      : this.db.prepare('DELETE FROM birdeye_alerts WHERE id=?').run(id);
    this.rebuilt.delete(id);
    return result.changes > 0;
  }

  events(threadId?: string): BirdeyeAlertEvent[] {
    const rows = (
      threadId
        ? this.db
            .prepare(
              'SELECT value FROM birdeye_alert_events WHERE thread_id=? ORDER BY observed_at DESC LIMIT 100',
            )
            .all(threadId)
        : this.db
            .prepare(
              'SELECT value FROM birdeye_alert_events ORDER BY observed_at DESC LIMIT 100',
            )
            .all()
    ) as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as BirdeyeAlertEvent);
  }

  poll(threadId?: string): Promise<BirdeyeMonitorResult> {
    // Serialize manual and background passes so one crossing cannot generate two events.
    const pass = this.queue.then(() => this.pollPass(threadId));
    this.queue = pass.catch(() => undefined);
    return pass;
  }

  private result(
    threadId: string | undefined,
    state: BirdeyeMonitorResult['state'],
    error?: string,
  ): BirdeyeMonitorResult {
    return {
      source: 'Birdeye',
      state,
      checkedAt: this.now(),
      alerts: this.list(threadId),
      events: this.events(threadId),
      ...(error ? { error } : {}),
    };
  }
  private save(alert: BirdeyeAlert) {
    // A removed alert must not be resurrected by an in-flight provider request.
    this.db
      .prepare('UPDATE birdeye_alerts SET value=? WHERE id=?')
      .run(JSON.stringify(alert), alert.id);
  }
  private allowed(alert: BirdeyeAlert) {
    return (
      !this.stopped && alert.enabled !== false && this.enabled(alert.threadId)
    );
  }

  private async pollPass(threadId?: string): Promise<BirdeyeMonitorResult> {
    const saved = this.list(threadId).filter(
      (alert) => alert.enabled !== false,
    );
    if (!saved.length) return this.result(threadId, 'idle');
    const alerts = saved.filter((alert) => this.allowed(alert));
    if (!alerts.length) return this.result(threadId, 'paused');
    const status = this.service.status?.();
    if (
      status?.configured === false ||
      status?.state === 'missing-configuration'
    )
      return this.result(
        threadId,
        'error',
        'BIRDEYE_API_KEY is not configured on the server.',
      );
    if (this.nextProviderAttemptAt > this.now())
      return this.result(
        threadId,
        'error',
        this.providerError ??
          'Birdeye is recovering from a provider failure; polling will resume after backoff.',
      );
    const addresses = [...new Set(alerts.map((alert) => alert.address))];
    const prices: Record<string, unknown> = {};
    try {
      for (let offset = 0; offset < addresses.length; offset += 100) {
        if (this.stopped) return this.result(threadId, 'paused');
        const batch = addresses
          .slice(offset, offset + 100)
          .filter((address) =>
            alerts.some(
              (alert) => alert.address === address && this.allowed(alert),
            ),
          );
        if (!batch.length) continue;
        const data = record(
          await this.service.request(
            '/defi/multi_price',
            new URLSearchParams({ list_address: batch.join(',') }),
          ),
        );
        Object.assign(prices, data);
      }
    } catch (failure) {
      this.failures++;
      const error = this.providerFailure(failure);
      for (const alert of alerts) {
        if (this.allowed(alert)) {
          alert.lastError = error;
          this.save(alert);
        }
      }
      return this.result(threadId, 'error', error);
    }
    let errors = 0;
    const unixNow = Math.floor(this.now() / 1000);
    for (const alert of alerts) {
      if (!this.allowed(alert)) continue;
      if (this.nextProviderAttemptAt > this.now()) {
        errors++;
        alert.lastError =
          this.providerError ?? 'Birdeye monitoring is backing off.';
        this.save(alert);
        continue;
      }
      try {
        const quote = record(prices[alert.address]);
        const price = number(quote.value);
        const updated = number(quote.updateUnixTime);
        const freshness =
          alert.kind === 'percent'
            ? WINDOWS[alert.timeframe ?? '24h']
            : INTERVAL;
        if (price == null || price <= 0 || updated == null)
          throw new Error(
            'No tracked price with a provider timestamp is available.',
          );
        if (updated > unixNow + 60 || unixNow - updated > freshness)
          throw new Error(
            'The provider price is stale; this alert was skipped.',
          );
        alert.lastPrice = price;
        alert.lastObservedAt = updated * 1000;
        const firstPass = !this.rebuilt.has(alert.id);
        let candidate =
          alert.kind === 'absolute' ? price : number(quote.priceChange24h);
        if (
          alert.kind === 'percent' &&
          (alert.timeframe !== '24h' || alert.baselineUnixTime != null)
        )
          candidate = null;
        const near =
          candidate == null ||
          crossed(candidate, alert) ||
          Math.abs(candidate - alert.threshold) <=
            Math.max(
              Math.abs(alert.threshold) * 0.1,
              alert.kind === 'percent' ? 0.5 : 0,
            );
        if (!firstPass && !alert.triggered && !near) {
          alert.lastError = null;
          this.save(alert);
          continue;
        }
        if (alert.kind === 'percent' && alert.baselineUnixTime == null) {
          const stats = await this.service.request(
            '/defi/v3/price/stats/single',
            new URLSearchParams({
              address: alert.address,
              list_timeframe: alert.timeframe ?? '24h',
            }),
          );
          const percent = this.statsPercent(stats, alert.timeframe ?? '24h');
          if (percent == null)
            throw new Error('The requested percent window is unavailable.');
          if (
            !firstPass &&
            !alert.triggered &&
            !crossed(percent, alert) &&
            Math.abs(percent - alert.threshold) >
              Math.max(Math.abs(alert.threshold) * 0.1, 0.5)
          ) {
            alert.lastError = null;
            this.save(alert);
            continue;
          }
        }
        if (!this.allowed(alert)) continue;
        const timeFrom =
          alert.kind === 'percent'
            ? (alert.baselineUnixTime ??
              unixNow - WINDOWS[alert.timeframe ?? '24h'] - INTERVAL * 3)
            : unixNow - INTERVAL * 3;
        const splitBaseline =
          alert.baselineUnixTime != null &&
          unixNow - alert.baselineUnixTime > 86400;
        const raw = record(
          await this.service.request(
            '/defi/v3/ohlcv',
            new URLSearchParams({
              address: alert.address,
              type: '15m',
              time_from: String(
                splitBaseline ? unixNow - INTERVAL * 3 : timeFrom,
              ),
              time_to: String(unixNow),
            }),
          ),
        );
        let candleItems = Array.isArray(raw.items) ? raw.items : [];
        if (splitBaseline && this.allowed(alert)) {
          const baselineData = record(
            await this.service.request(
              '/defi/v3/ohlcv',
              new URLSearchParams({
                address: alert.address,
                type: '15m',
                time_from: String(alert.baselineUnixTime),
                time_to: String(alert.baselineUnixTime! + INTERVAL * 2),
              }),
            ),
          );
          candleItems = [
            ...(Array.isArray(baselineData.items) ? baselineData.items : []),
            ...candleItems,
          ];
        }
        const candles = this.candles(candleItems, unixNow);
        const latest = candles.at(-1);
        if (!latest || unixNow - latest.unixTime > INTERVAL * 3)
          throw new Error(
            'No recent closed candle with trading volume confirms this move.',
          );
        let value = latest.close;
        if (alert.kind === 'percent') {
          const baseline =
            alert.baselineUnixTime != null
              ? candles.find(
                  (candle) =>
                    candle.unixTime >= alert.baselineUnixTime! &&
                    candle.unixTime - alert.baselineUnixTime! < INTERVAL,
                )
              : candles.findLast(
                  (candle) =>
                    candle.unixTime <=
                    latest.unixTime - WINDOWS[alert.timeframe ?? '24h'],
                );
          if (
            !baseline ||
            baseline.close <= 0 ||
            (alert.baselineUnixTime == null &&
              latest.unixTime -
                WINDOWS[alert.timeframe ?? '24h'] -
                baseline.unixTime >
                INTERVAL)
          )
            throw new Error(
              'A closed candle for the exact baseline is unavailable.',
            );
          value = (latest.close / baseline.close - 1) * 100;
        }
        if (!this.allowed(alert)) continue;
        // Ignore late or duplicate candles, except for the quiet restart rebuild.
        if (
          !firstPass &&
          alert.confirmedUnixTime != null &&
          latest.unixTime <= alert.confirmedUnixTime
        ) {
          alert.lastError = null;
          this.save(alert);
          continue;
        }
        const triggered = crossed(value, alert);
        const exists = this.db
          .prepare('SELECT id FROM birdeye_alerts WHERE id=?')
          .get(alert.id);
        if (!exists) continue;
        const previousTriggered = alert.triggered;
        alert.triggered = triggered;
        alert.confirmedUnixTime = latest.unixTime;
        alert.lastError = null;
        if (!firstPass && triggered && !previousTriggered) {
          const event: BirdeyeAlertEvent = {
            id: randomUUID(),
            alertId: alert.id,
            threadId: alert.threadId,
            address: alert.address,
            label: alert.label,
            source: 'Birdeye',
            observedAt: this.now(),
            candleUnixTime: latest.unixTime,
            price: latest.close,
            value,
            threshold: alert.threshold,
            direction: alert.direction,
            kind: alert.kind,
          };
          this.db.exec('BEGIN IMMEDIATE');
          try {
            this.db
              .prepare(
                'INSERT INTO birdeye_alert_events VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                event.id,
                event.threadId,
                event.alertId,
                JSON.stringify(event),
                event.observedAt,
              );
            this.save(alert);
            this.db
              .prepare(
                'DELETE FROM birdeye_alert_events WHERE id NOT IN (SELECT id FROM birdeye_alert_events ORDER BY observed_at DESC LIMIT 1000)',
              )
              .run();
            this.db.exec('COMMIT');
          } catch (error) {
            this.db.exec('ROLLBACK');
            alert.triggered = previousTriggered;
            throw error;
          }
        } else this.save(alert);
        this.rebuilt.add(alert.id);
      } catch (error) {
        if (!this.allowed(alert)) continue;
        errors++;
        // Only locally defined errors are exposed; provider errors can contain credential URLs.
        const safe =
          error instanceof Error &&
          /^(No tracked|The provider|The requested|No recent|A closed)/.test(
            error.message,
          )
            ? error.message
            : this.providerFailure(error);
        alert.lastError = safe;
        this.save(alert);
      }
    }
    this.failures = errors ? this.failures + 1 : 0;
    return this.result(
      threadId,
      !alerts.some((alert) => this.allowed(alert))
        ? 'paused'
        : errors
          ? 'degraded'
          : 'ready',
    );
  }

  private providerFailure(error: unknown): string {
    const code = record(error).code;
    const denied =
      code === 'tier-unavailable' ||
      code === 'authentication-error' ||
      code === 'missing-configuration';
    const quota = code === 'quota-limited';
    const message = denied
      ? 'Birdeye denied this request. Check the server API key and account entitlement; no alert was fired.'
      : quota
        ? 'Birdeye credits or quota are unavailable. Monitoring is backing off; no alert was fired.'
        : 'Birdeye confirmation is unavailable. Monitoring will retry with backoff; this alert was skipped.';
    this.nextProviderAttemptAt =
      this.now() +
      (denied
        ? 15 * 60_000
        : quota
          ? 5 * 60_000
          : Math.min(60_000, 15_000 * 2 ** Math.min(this.failures, 2)));
    this.providerError = message;
    return message;
  }

  private statsPercent(raw: unknown, timeframe: string): number | null {
    const pending: unknown[] = [raw];
    let visited = 0;
    while (pending.length && visited++ < 500) {
      const item = pending.shift();
      if (Array.isArray(item)) {
        pending.push(...item.slice(0, 100));
        continue;
      }
      const row = record(item);
      const frame = row.timeframe ?? row.time_frame ?? row.type;
      if (frame === timeframe && number(row.price_change_percent) != null)
        return number(row.price_change_percent);
      if (Object.hasOwn(row, timeframe)) {
        const percent = number(record(row[timeframe]).price_change_percent);
        if (percent != null) return percent;
      }
      if (row.data != null) pending.push(row.data);
    }
    return null;
  }

  private candles(raw: unknown, unixNow: number): Candle[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, 3000)
      .flatMap((entry) => {
        const row = record(entry);
        const unixTime = number(row.unix_time ?? row.unixTime);
        const close = number(row.c);
        const volume = Math.max(
          number(row.v) ?? 0,
          number(row.v_usd ?? row.vUsd) ?? 0,
        );
        return unixTime != null &&
          close != null &&
          close > 0 &&
          volume > 0 &&
          unixTime + INTERVAL <= unixNow
          ? [{ unixTime, close, volume }]
          : [];
      })
      .sort((a, b) => a.unixTime - b.unixTime);
  }

  start(intervalMs = 60_000) {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const interval = Math.max(15_000, Math.min(intervalMs, 3_600_000));
    const tick = async () => {
      if (!this.running) return;
      try {
        await this.poll();
      } catch {
        this.failures++;
      }
      if (this.running) {
        const lowCredits = this.service.status?.().credits?.low;
        const delay = Math.max(
          Math.min(
            interval * (lowCredits ? 4 : 1) * 2 ** Math.min(this.failures, 5),
            30 * 60_000,
          ),
          this.nextProviderAttemptAt - this.now(),
        );
        this.timer = setTimeout(tick, delay);
        this.timer.unref?.();
      }
    };
    this.timer = setTimeout(tick, interval);
    this.timer.unref?.();
  }

  async stop() {
    this.running = false;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.queue;
  }
}
