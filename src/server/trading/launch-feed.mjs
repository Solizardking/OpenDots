/* global fetch, AbortSignal, setInterval, clearInterval, setTimeout, clearTimeout */
import WebSocket from 'ws';
import { validMarketMint } from './market-feed.mjs';

export const LAUNCH_SOURCES = [
  {
    id: 'clawd',
    url: 'https://clawd-ws.fly.dev/',
    socket: 'wss://clawd-ws.fly.dev/ws',
    health: 'https://clawd-ws.fly.dev/health',
  },
  {
    id: 'pump',
    url: 'https://pump-stream-production.up.railway.app/',
    socket: 'wss://pump-stream-production.up.railway.app/ws',
    health: 'https://pump-stream-production.up.railway.app/health',
  },
];
export function normalize_launch(value, source, now = Date.now()) {
  if (
    !value ||
    value.replay === true ||
    ![
      'token-launch',
      'token-update',
      'trade',
      'migration',
      'pool-create',
    ].includes(value.type) ||
    !validMarketMint(value.mint)
  )
    return null;
  const eventAt = Date.parse(value.time);
  if (
    !Number.isFinite(eventAt) ||
    eventAt > now + 10000 ||
    eventAt < now - 120000
  )
    return null;
  const text = (value, max) =>
    typeof value === 'string' ? value.slice(0, max) : '';
  return {
    id: `${source}:${value.type}:${text(value.signature, 100) || value.mint}:${eventAt}`,
    source,
    type: value.type === 'token-update' ? 'token-launch' : value.type,
    mint: value.mint,
    name: text(value.name, 64),
    symbol: text(value.symbol, 20),
    eventAt,
    receivedAt: now,
    platform: text(value.platform || 'pumpfun', 20),
    marketCapSol:
      typeof value.marketCapSol === 'number' &&
      Number.isFinite(value.marketCapSol) &&
      value.marketCapSol >= 0
        ? value.marketCapSol
        : null,
  };
}

export class LaunchFeed {
  constructor({
    fetchImpl = fetch,
    WebSocketImpl = WebSocket,
    now = Date.now,
  } = {}) {
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.now = now;
    this.events = new Map();
    this.listeners = new Set();
    this.connections = new Map();
    this.running = false;
    this.sources = LAUNCH_SOURCES.map((source) => ({
      ...source,
      status: 'connecting',
      healthStatus: null,
      lastEventAt: null,
      message: 'Connecting to source.',
      delay: 1000,
    }));
  }
  snapshot() {
    const now = this.now();
    return {
      sources: this.sources.map(
        ({ id, url, status, lastEventAt, healthStatus, message }) => ({
          id,
          url,
          healthStatus,
          lastEventAt,
          message,
          status:
            status === 'live' && now - lastEventAt > 120000 ? 'stale' : status,
        }),
      ),
      events: [...this.events.values()]
        .filter((event) => now - event.eventAt <= 120000)
        .slice(-80)
        .reverse(),
    };
  }
  emit() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* Isolate disconnected subscribers. */
      }
    }
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start() {
    if (this.running) return;
    this.running = true;
    this.heartbeat = setInterval(() => this.emit(), 15000);
    this.heartbeat.unref();
    await Promise.allSettled(
      this.sources.map((source) => this.connect(source)),
    );
  }
  async connect(source) {
    if (!this.running) return;
    try {
      const health = await this.fetch(source.health, {
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      const data = health.ok ? await health.json() : null;
      source.healthStatus =
        data?.status === 'ok'
          ? 'ok'
          : data?.status === 'degraded'
            ? 'degraded'
            : 'unavailable';
    } catch {
      source.healthStatus = 'unavailable';
    }
    try {
      let protocols,
        headers = { Origin: source.url.slice(0, -1) };
      if (source.id === 'pump') {
        const session = await this.fetch(source.url + 'auth/session', {
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
        if (!session.ok) throw Error();
        const data = await session.json();
        headers.Cookie = session.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        const response = await this.fetch(source.url + 'auth/ws-ticket', {
          method: 'POST',
          headers: { ...headers, 'x-csrf-token': data.csrf },
          signal: AbortSignal.timeout(8000),
          redirect: 'error',
        });
        if (!response.ok) {
          source.status =
            response.status === 401 || response.status === 403
              ? 'authentication_required'
              : 'unavailable';
          throw Error();
        }
        const { ticket } = await response.json();
        if (typeof ticket !== 'string' || ticket.length > 4096) throw Error();
        protocols = ['musebook-stream', `ticket.${ticket}`];
      }
      if (!this.running) return;
      const socket = new this.WebSocket(source.socket, protocols, {
        headers,
        maxPayload: 65536,
        handshakeTimeout: 10000,
      });
      this.connections.set(source.id, socket);
      source.status = 'connecting';
      source.message = 'Waiting for a fresh market event.';
      const watchdog = setTimeout(() => socket.terminate(), 90000);
      watchdog.unref();
      socket.on('message', (bytes) => {
        if (!this.running || bytes.length > 65536) return;
        watchdog.refresh();
        let payload;
        try {
          payload = JSON.parse(String(bytes));
        } catch {
          return;
        }
        if (!payload || typeof payload !== 'object') return;
        const snapshotRows = payload.launches || payload.events;
        const rows = Array.isArray(payload)
          ? payload.slice(0, 40)
          : payload.type === 'snapshot'
            ? Array.isArray(snapshotRows)
              ? snapshotRows.slice(-40)
              : []
            : [payload];
        let changed = false;
        for (const row of rows) {
          const event = normalize_launch(row, source.id, this.now());
          if (!event) continue;
          source.status = 'live';
          source.lastEventAt = event.receivedAt;
          source.message = 'Receiving observed market events.';
          source.delay = 1000;
          const key = `${source.id}:${event.type === 'token-update' ? 'token-launch' : event.type}:${event.type.includes('token-') ? event.mint : event.id}`;
          if (this.events.get(key)?.eventAt === event.eventAt) continue;
          this.events.delete(key);
          this.events.set(key, event);
          changed = true;
        }
        while (this.events.size > 200)
          this.events.delete(this.events.keys().next().value);
        if (changed) this.emit();
      });
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        clearTimeout(watchdog);
        this.connections.delete(source.id);
        this.retry(source);
      });
      this.emit();
    } catch {
      if (this.running) this.retry(source);
    }
  }
  retry(source) {
    if (!this.running) return;
    if (source.status !== 'authentication_required')
      source.status = 'reconnecting';
    source.message =
      source.status === 'authentication_required'
        ? 'Source requires its own authentication.'
        : 'Connection unavailable; reconnecting.';
    source.timer = setTimeout(() => {
      void this.connect(source);
    }, source.delay);
    source.timer.unref();
    source.delay = Math.min(30000, source.delay * 2);
    this.emit();
  }
  stop() {
    this.running = false;
    clearInterval(this.heartbeat);
    for (const source of this.sources) clearTimeout(source.timer);
    for (const socket of this.connections.values()) socket.terminate();
    this.connections.clear();
    this.listeners.clear();
  }
}
