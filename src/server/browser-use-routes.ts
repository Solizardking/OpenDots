import { Hono } from 'hono';
import { z } from 'zod';
import {
  BrowserUseError,
  cloudTask,
  type BrowserUseService,
} from './browser-use-service.js';

export function browserUseRoutes(service: BrowserUseService) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error:
            'Provide a non-empty browser task or a valid permission setting.',
        },
        400,
      );
    if (error instanceof BrowserUseError)
      return c.json(
        { error: error.message },
        error.status as 400 | 403 | 404 | 409 | 502 | 503 | 504,
      );
    return c.json(
      {
        error:
          'Browser Use request failed. Check provider availability and server configuration.',
      },
      502,
    );
  });
  app.get('/dots/:id/browser-use', async (c) =>
    c.json(await service.status(c.req.param('id'))),
  );
  app.patch('/dots/:id/browser-use/permission', async (c) => {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(await c.req.json());
    return c.json(await service.permission(c.req.param('id'), enabled));
  });
  app.post('/dots/:id/browser-use/start', async (c) =>
    c.json(await service.startBrowser(c.req.param('id')), 201),
  );
  app.post('/dots/:id/browser-use/stop-browser', async (c) =>
    c.json(await service.stopBrowser(c.req.param('id'))),
  );
  app.post('/dots/:id/browser-use/stop', async (c) =>
    c.json(await service.stop(c.req.param('id'))),
  );
  app.post('/dots/:id/browser-use/stop-run', async (c) =>
    c.json(await service.stopRun(c.req.param('id'))),
  );
  app.post('/dots/:id/browser-use/runs', async (c) =>
    c.json(
      await service.createRun(
        c.req.param('id'),
        cloudTask.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post('/dots/:id/browser-use/check-cdp', async (c) =>
    c.json(await service.checkCdp(c.req.param('id'))),
  );
  return app;
}
