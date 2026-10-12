import { Hono } from 'hono';
import { z } from 'zod';
import { JupiterError, type JupiterService } from './jupiter-service.js';
import {
  jupiterQuoteSchema,
  jupiterPrepareSchema,
} from '../shared/jupiter-types.js';
export function jupiterRoutes(service: JupiterService) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof JupiterError
            ? error.message
            : 'Jupiter request failed. Check the draft and prepare again.',
      },
      error instanceof JupiterError
        ? (error.status as 400 | 403 | 404 | 409 | 429 | 502 | 503)
        : 400,
    ),
  );
  app.get('/markets/jupiter/status', (c) => c.json(service.availability()));
  app.post('/markets/jupiter/context', async (c) => {
    const input = z
      .object({ dotId: z.string().uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: 'Select a Dot to open Jupiter.' }, 400);
    return c.json(service.context(input.data.dotId));
  });
  app.post('/markets/jupiter/quote', async (c) => {
    const parsed = jupiterQuoteSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0].message }, 400);
    return c.json(await service.quote(parsed.data.input, parsed.data.address));
  });
  app.post('/conversations/:threadId/jupiter/prepare', async (c) => {
    const parsed = jupiterPrepareSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0].message }, 400);
    return c.json(
      await service.prepare(
        c.req.param('threadId'),
        parsed.data.input,
        parsed.data.address,
        c.req.raw.signal,
      ),
    );
  });
  app.get('/conversations/:threadId/jupiter/requests', (c) =>
    c.json({ requests: service.list(c.req.param('threadId')) }),
  );
  app.get('/conversations/:threadId/jupiter/requests/:id', async (c) =>
    c.json(await service.review(c.req.param('threadId'), c.req.param('id'))),
  );
  app.post('/conversations/:threadId/jupiter/requests/:id/decline', (c) =>
    c.json(service.decline(c.req.param('threadId'), c.req.param('id'))),
  );
  app.post(
    '/conversations/:threadId/jupiter/requests/:id/submit',
    async (c) => {
      const parsed = z
        .object({
          confirm: z.literal(true),
          transactionHash: z.string().regex(/^[a-f0-9]{64}$/),
          signedTransactionBase64: z.string().min(1).max(1644),
        })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json(
          {
            error:
              'Review and sign this exact swap in the connected wallet first.',
          },
          400,
        );
      return c.json(
        await service.submit(
          c.req.param('threadId'),
          c.req.param('id'),
          parsed.data.transactionHash,
          parsed.data.signedTransactionBase64,
        ),
      );
    },
  );
  return app;
}
