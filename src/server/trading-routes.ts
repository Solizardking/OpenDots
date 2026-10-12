import type { PumpService } from './pump-service.js';
import { Hono } from 'hono';
import { z } from 'zod';
import type { TradingService } from './trading-service.js';
import { tradingStrategySchema } from '../shared/trading-types.js';
export function tradingRoutes(trading: TradingService, pump: PumpService) {
  const app = new Hono();
  app.onError((error, c) => {
    const status =
      'status' in error && typeof error.status === 'number'
        ? error.status
        : 400;
    return c.json(
      {
        error:
          status === 400 && !('status' in error)
            ? 'Select an existing Dot in your workspace.'
            : error.message,
      },
      status as 400 | 403 | 409 | 429 | 502 | 503,
    );
  });
  app.get('/markets/brain/config', (c) => c.json(trading.config()));
  app.get('/markets/brain/feeds', (c) => c.json(trading.feeds()));
  const base = '/dots/:dotId/trading';
  app.get(base, async (c) => c.json(await trading.view(c.req.param('dotId')!)));
  app.put(base + '/strategy', async (c) => {
    const parsed = tradingStrategySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0].message }, 400);
    return c.json({
      strategy: await trading.save(c.req.param('dotId')!, parsed.data),
    });
  });
  app.post(base + '/monitor', async (c) => {
    const parsed = z
      .object({ enabled: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Choose start or pause monitoring.' }, 400);
    return c.json(
      await trading.monitor(c.req.param('dotId')!, parsed.data.enabled),
    );
  });
  app.post(base + '/decide', async (c) => {
    const parsed = z
      .object({
        requestId: z.string().uuid(),
        command: z.string().min(3).max(1000).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Use a unique decision request and a command of 3–1,000 characters.',
        },
        400,
      );
    return c.json(await trading.evaluate(c.req.param('dotId')!, parsed.data));
  });
  app.post(base + '/review', async (c) => {
    const parsed = z
      .object({
        decisionId: z.string().uuid(),
        threadId: z.string().min(1).max(128),
        amount: z.string().max(28),
        slippageBps: z.number().int().min(0).max(2000),
        address: z.string().min(32).max(44).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Choose the decision, conversation, wallet, amount and slippage.',
        },
        400,
      );
    const { decisionId, threadId, ...input } = parsed.data;
    return c.json(
      await trading.reviewPump(
        c.req.param('dotId')!,
        decisionId,
        threadId,
        input,
        pump,
      ),
    );
  });
  return app;
}
