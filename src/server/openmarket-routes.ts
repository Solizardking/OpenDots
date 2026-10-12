import { Hono } from 'hono';
import {
  OpenMarketError,
  openMarketService,
  type OpenMarketService,
} from './openmarket-service.js';

export function openMarketRoutes(
  service: OpenMarketService = openMarketService,
) {
  const app = new Hono();
  app.get('/markets/openmarket/:route', async (c) => {
    try {
      return c.json(
        await service.read(
          c.req.param('route'),
          new URL(c.req.url).searchParams,
        ),
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof OpenMarketError
              ? error.message
              : 'OpenMarket is unavailable.',
        },
        error instanceof OpenMarketError
          ? (error.status as 400 | 403 | 404 | 429 | 502 | 503)
          : 502,
      );
    }
  });
  app.all('/markets/openmarket/*', (c) =>
    c.json({ error: 'OpenMarket analytics only support read requests.' }, 405),
  );
  return app;
}
