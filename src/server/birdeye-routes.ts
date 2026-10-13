import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { birdeyeQuerySchema } from '../shared/birdeye-types.js';
import { BirdeyeError } from './birdeye-service.js';
import { birdeyeAlertSchema } from './birdeye-monitor.js';
import { birdeyeStreamSchema } from './birdeye-stream.js';
import type { Platform } from './platform.js';

const fail = (status: number, message: string, code: string) =>
  new BirdeyeError(message, status, code);
const threadSchema = z.string().min(1).max(128);
export function birdeyeRoutes(platform: Platform) {
  const app = new Hono();
  const scope = (threadId: unknown) => {
    const parsed = threadSchema.safeParse(threadId);
    if (!parsed.success)
      throw fail(
        400,
        'Select a conversation for Birdeye research.',
        'invalid-query',
      );
    if (!platform.birdeyeAllowed(parsed.data))
      throw fail(
        403,
        'Research is paused, disabled, or this conversation is outside your workspace.',
        'research-disabled',
      );
    return parsed.data;
  };
  app.onError((error, c) =>
    c.json(
      {
        source: 'Birdeye',
        error:
          error instanceof BirdeyeError
            ? error.message
            : 'Birdeye research is temporarily unavailable.',
        code: error instanceof BirdeyeError ? error.code : 'unavailable',
      },
      error instanceof BirdeyeError
        ? (error.status as 400 | 403 | 404 | 409 | 429 | 502 | 503)
        : 502,
    ),
  );
  app.get('/birdeye/status', (c) => {
    scope(c.req.query('threadId'));
    return c.json({
      ...platform.birdeye.status(),
      streaming: platform.config.birdeyeStream?.status(),
    });
  });
  app.post('/birdeye/query', async (c) => {
    const raw = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!raw || Array.isArray(raw) || typeof raw !== 'object')
      throw fail(400, 'Choose a Birdeye research workflow.', 'invalid-query');
    const { threadId, ...input } = raw;
    scope(threadId);
    const parsed = birdeyeQuerySchema.safeParse(input);
    if (!parsed.success)
      throw fail(400, parsed.error.issues[0].message, 'invalid-query');
    const result = await platform.birdeye.read(parsed.data, c.req.raw.signal);
    scope(threadId);
    return c.json(result);
  });
  app.get('/birdeye/alerts', (c) => {
    const threadId = scope(c.req.query('threadId'));
    return c.json({
      source: 'Birdeye',
      alerts: platform.birdeyeMonitor.list(threadId),
      events: platform.birdeyeMonitor.events(threadId),
    });
  });
  app.post('/birdeye/alerts', async (c) => {
    const parsed = birdeyeAlertSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw fail(400, parsed.error.issues[0].message, 'invalid-alert');
    scope(parsed.data.threadId);
    try {
      return c.json(
        {
          source: 'Birdeye',
          alert: platform.birdeyeMonitor.create(parsed.data),
        },
        201,
      );
    } catch {
      throw fail(
        400,
        'Use a valid alert threshold and a closed baseline candle within the past 30 days. This workspace supports up to 500 alerts.',
        'invalid-alert',
      );
    }
  });
  app.delete('/birdeye/alerts/:id', (c) => {
    const threadId = scope(c.req.query('threadId'));
    const removed = platform.birdeyeMonitor.remove(c.req.param('id'), threadId);
    return removed
      ? c.json({ source: 'Birdeye', removed })
      : c.json(
          { source: 'Birdeye', error: 'Alert not found in this conversation.' },
          404,
        );
  });
  app.post('/birdeye/alerts/poll', async (c) => {
    const parsed = z
      .object({ threadId: threadSchema })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw fail(
        400,
        'Select a conversation to check alerts.',
        'invalid-query',
      );
    scope(parsed.data.threadId);
    const result = await platform.birdeyeMonitor.poll(parsed.data.threadId);
    scope(parsed.data.threadId);
    return c.json(result);
  });
  app.post('/birdeye/stream', async (c) => {
    const parsed = birdeyeStreamSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      throw fail(400, parsed.error.issues[0].message, 'invalid-subscription');
    const threadId = scope(parsed.data.threadId);
    const source = platform.config.birdeyeStream;
    if (!source)
      throw fail(
        503,
        'Live Birdeye streaming is not configured. Use on-demand research.',
        'stream-unavailable',
      );
    if (!platform.birdeye.status().configured)
      throw fail(
        503,
        'Add the Birdeye server connection before starting live research.',
        'missing-configuration',
      );
    // The browser only connects to this authenticated relay. The credentialed
    // provider URL never leaves the server or enters an SSE event.
    return streamSSE(c, async (stream) => {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      let disconnected = false;
      let queued = 0;
      let writing = Promise.resolve();
      let unsubscribe = () => {};
      const cleanup = () => {
        if (disconnected) return;
        disconnected = true;
        unsubscribe();
        platform.birdeyeSubscriptions.delete(cleanup);
        resolveClosed();
      };
      const enqueue = (event: { id?: string; event: string; data: string }) => {
        if (disconnected) return;
        if (queued >= 64) {
          cleanup();
          return;
        }
        queued++;
        writing = writing
          .then(async () => {
            if (disconnected) return;
            if (!platform.birdeyeAllowed(threadId)) {
              cleanup();
              return;
            }
            await stream.writeSSE(event);
          })
          .catch(() => cleanup())
          .finally(() => {
            queued--;
          });
      };
      try {
        unsubscribe = source.subscribe(
          parsed.data,
          (event) =>
            enqueue({
              id: event.id,
              event: 'birdeye',
              data: JSON.stringify(event),
            }),
          () => platform.birdeyeAllowed(threadId),
        );
      } catch {
        await stream
          .writeSSE({
            event: 'birdeye',
            data: JSON.stringify({
              source: 'Birdeye',
              kind: 'status',
              state: 'unavailable',
              observedAt: Date.now(),
              error:
                'This live feed could not start. Reduce the subscribed addresses or retry after the account connection becomes available.',
            }),
          })
          .catch(() => {});
        cleanup();
        return;
      }
      platform.birdeyeSubscriptions.add(cleanup);
      stream.onAbort(cleanup);
      if (c.req.raw.signal.aborted) cleanup();
      const heartbeat = setInterval(() => {
        if (!platform.birdeyeAllowed(threadId)) {
          cleanup();
          return;
        }
        enqueue({ event: 'heartbeat', data: '{}' });
      }, 15_000);
      heartbeat.unref();
      try {
        await closed;
      } finally {
        clearInterval(heartbeat);
        cleanup();
      }
    });
  });
  return app;
}
