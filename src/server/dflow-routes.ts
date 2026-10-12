import { Hono } from 'hono';
import { dflowQuoteInput } from '../shared/dflow-types.js';
import { DflowError, DflowService } from './dflow-service.js';

export function dflowRoutes(service = new DflowService()) {
  const app = new Hono();
  app.get('/markets/dflow/status', (c) =>
    c.json({ configured: service.enabled, source: 'DFlow', quotesOnly: true }),
  );
  app.post('/markets/dflow/quote', async (c) => {
    const parsed = dflowQuoteInput.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0].message }, 400);
    try {
      return c.json(await service.quote(parsed.data, c.req.raw.signal));
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof DflowError
              ? error.message
              : 'DFlow quote failed. Please retry.',
        },
        error instanceof DflowError
          ? (error.status as 400 | 429 | 502 | 503)
          : 502,
      );
    }
  });
  return app;
}
