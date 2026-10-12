import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const publicOrigin = 'https://chatgptee.ai';
type RelayRequest = {
  type: string;
  id: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/** An opt-in outbound TLS tunnel to this Mac's restricted companion app. */
export class DesktopRelay {
  private secret: string;
  readonly id: string;
  private socket?: WebSocket;
  private stopped = true;
  private retry?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private failures = 0;
  private requests = new Map<
    string,
    { abort: AbortController; credits: number; release?: () => void }
  >();
  constructor(
    path: string,
    private handle: (request: Request) => Response | Promise<Response>,
    private localOrigin: () => string,
    private relayOrigin = publicOrigin,
  ) {
    try {
      this.secret = JSON.parse(readFileSync(path, 'utf8')).secret;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.secret = randomBytes(32).toString('base64url');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify({ secret: this.secret }), {
        mode: 0o600,
        flag: 'wx',
      });
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(this.secret))
      throw Error('Invalid Mac relay identity.');
    this.id = createHash('sha256')
      .update(this.secret)
      .digest('hex')
      .slice(0, 32);
    const endpoint = new URL(relayOrigin);
    if (
      endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1')
    )
      throw Error('The Mac relay requires HTTPS.');
  }
  state() {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      id: this.id,
      origin: this.relayOrigin,
    };
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  private connect() {
    if (this.stopped) return;
    const endpoint = new URL(
      `/pair/relay/connect/${this.id}`,
      this.relayOrigin,
    );
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(endpoint, `dots-host-${this.secret}`);
    this.socket = socket;
    const deadline = setTimeout(() => socket.close(), 15000);
    socket.addEventListener('open', () => {
      clearTimeout(deadline);
      this.failures = 0;
      let alive = true;
      this.heartbeat = setInterval(() => {
        if (!alive) {
          socket.close();
          return;
        }
        alive = false;
        socket.send(JSON.stringify({ type: 'ping' }));
      }, 25000);
      socket.addEventListener('message', (event) => {
        if (event.data === '{"type":"pong"}') alive = true;
      });
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > 1500000) {
        socket.close();
        return;
      }
      let message: RelayRequest;
      try {
        message = JSON.parse(event.data);
      } catch {
        socket.close();
        return;
      }
      if (message.type === 'credit') {
        const active = this.requests.get(message.id);
        if (active) {
          active.credits++;
          active.release?.();
          active.release = undefined;
        }
      } else if (message.type === 'cancel')
        this.requests.get(message.id)?.abort.abort();
      else if (message.type === 'request') void this.respond(socket, message);
    });
    socket.addEventListener('error', () => {
      /* Close triggers the bounded reconnect. */
    });
    socket.addEventListener('close', () => {
      clearTimeout(deadline);
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const active of this.requests.values()) {
        active.abort.abort();
        active.release?.();
      }
      this.requests.clear();
      if (!this.stopped)
        this.retry = setTimeout(
          () => this.connect(),
          Math.min(30000, 1000 * 2 ** Math.min(this.failures++, 5)),
        );
    });
  }
  private async respond(socket: WebSocket, message: RelayRequest) {
    if (!/^[a-f0-9]{32}$/.test(message.id) || this.requests.has(message.id))
      return;
    const send = (value: unknown) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(value));
    };
    if (this.requests.size >= 32) {
      send({ type: 'response', id: message.id, status: 429, headers: {} });
      send({ type: 'end', id: message.id });
      return;
    }
    const active = {
      abort: new AbortController(),
      credits: 0,
      release: undefined as (() => void) | undefined,
    };
    this.requests.set(message.id, active);
    const timeout = setTimeout(() => {
      active.abort.abort();
      active.release?.();
    }, 300000);
    try {
      if (
        !['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(
          message.method,
        ) ||
        typeof message.path !== 'string' ||
        !message.path.startsWith('/') ||
        message.path.startsWith('//') ||
        message.path.includes('\\') ||
        message.path.length > 4096
      )
        throw Error('Invalid companion request.');
      const local = this.localOrigin(),
        url = new URL(message.path, local);
      if (url.origin !== local) throw Error('Invalid companion target.');
      const headers = new Headers();
      for (const name of ['accept', 'content-type', 'cookie'])
        if (typeof message.headers?.[name] === 'string')
          headers.set(name, message.headers[name]);
      headers.set('origin', local);
      const body = message.body
        ? Buffer.from(message.body, 'base64')
        : undefined;
      if (body && body.length > 1048576)
        throw Error('Companion request too large.');
      const response = await this.handle(
        new Request(url, {
          method: message.method,
          headers,
          signal: active.abort.signal,
          ...(['GET', 'HEAD'].includes(message.method) ? {} : { body }),
        }),
      );
      const output: Record<string, string> = {};
      for (const name of [
        'content-type',
        'content-length',
        'cache-control',
        'content-security-policy',
        'set-cookie',
        'referrer-policy',
        'x-content-type-options',
      ]) {
        const value = response.headers.get(name);
        if (value) output[name] = value;
      }
      send({
        type: 'response',
        id: message.id,
        status: response.status,
        headers: output,
      });
      const reader =
        message.method !== 'HEAD' ? response.body?.getReader() : undefined;
      if (reader) {
        active.abort.signal.addEventListener(
          'abort',
          () => {
            active.release?.();
            void reader.cancel();
          },
          { once: true },
        );
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          for (let offset = 0; offset < next.value.length; offset += 32768) {
            if (!active.credits && !active.abort.signal.aborted)
              await new Promise<void>((resolve) => {
                active.release = resolve;
              });
            if (active.abort.signal.aborted) throw Error('Request cancelled.');
            active.credits--;
            while (
              socket.bufferedAmount > 1048576 &&
              socket.readyState === WebSocket.OPEN &&
              !active.abort.signal.aborted
            )
              await new Promise((resolve) => setTimeout(resolve, 10));
            if (
              socket.readyState !== WebSocket.OPEN ||
              active.abort.signal.aborted
            )
              throw Error('Relay disconnected.');
            send({
              type: 'data',
              id: message.id,
              body: Buffer.from(
                next.value.subarray(offset, offset + 32768),
              ).toString('base64'),
            });
          }
        }
      }
      send({ type: 'end', id: message.id });
    } catch {
      send({ type: 'error', id: message.id });
    } finally {
      clearTimeout(timeout);
      this.requests.delete(message.id);
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    for (const active of this.requests.values()) {
      active.abort.abort();
      active.release?.();
    }
    this.requests.clear();
    this.socket?.close(1000, 'Phone access disabled');
    this.socket = undefined;
  }
}
