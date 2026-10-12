import { Hono } from 'hono';
import { z } from 'zod';
import { PumpError, type PumpService } from './pump-service.js';
import { pumpLaunchSchema, pumpTradeSchema } from '../shared/pump-types.js';

export function pumpRoutes(pump: PumpService) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof PumpError
            ? error.message
            : 'Pump request failed. Check the wallet, amount, metadata and RPC connection, then prepare again.',
      },
      error instanceof PumpError
        ? (error.status as 400 | 403 | 404 | 409 | 502)
        : 400,
    ),
  );
  app.post('/markets/pump/context', async (c) => {
    const parsed = z
      .object({ dotId: z.string().uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Select a Dot to open Pump.fun.' }, 400);
    return c.json(pump.context(parsed.data.dotId));
  });
  app.get('/markets/pump/wallet/:address/balance', async (c) =>
    c.json(await pump.balance(c.req.param('address'))),
  );
  app.get('/conversations/:threadId/pump/token/:mint', async (c) =>
    c.json(await pump.token(c.req.param('threadId'), c.req.param('mint'))),
  );
  const connectedAddress = z.string().min(32).max(44);
  app.get('/conversations/:threadId/pump/connected/token/:mint', async (c) => {
    const address = connectedAddress.safeParse(c.req.query('address'));
    if (!address.success)
      return c.json(
        { error: 'Connect a Solana wallet before inspecting a coin.' },
        400,
      );
    return c.json(
      await pump.connectedToken(
        c.req.param('threadId'),
        c.req.param('mint'),
        address.data,
      ),
    );
  });
  app.post('/conversations/:threadId/pump/connected/launch', async (c) => {
    const parsed = z
      .object({ address: connectedAddress, input: pumpLaunchSchema })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0].message }, 400);
    return c.json(
      await pump.prepareConnected(
        c.req.param('threadId'),
        { kind: 'launch', input: parsed.data.input },
        parsed.data.address,
      ),
    );
  });
  app.post('/conversations/:threadId/pump/connected/trade', async (c) => {
    const parsed = z
      .object({ address: connectedAddress, input: pumpTradeSchema })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0].message }, 400);
    return c.json(
      await pump.prepareConnected(
        c.req.param('threadId'),
        { kind: 'trade', input: parsed.data.input },
        parsed.data.address,
      ),
    );
  });
  app.get('/conversations/:threadId/pump/requests', (c) =>
    c.json({ requests: pump.list(c.req.param('threadId')) }),
  );
  app.post('/conversations/:threadId/pump/launch', async (c) => {
    const input = pumpLaunchSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      return c.json({ error: input.error.issues[0].message }, 400);
    return c.json(
      await pump.prepare(c.req.param('threadId'), {
        kind: 'launch',
        input: input.data,
      }),
    );
  });
  app.post('/conversations/:threadId/pump/trade', async (c) => {
    const input = pumpTradeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!input.success)
      return c.json({ error: input.error.issues[0].message }, 400);
    return c.json(
      await pump.prepare(c.req.param('threadId'), {
        kind: 'trade',
        input: input.data,
      }),
    );
  });
  app.get('/conversations/:threadId/pump/requests/:id', async (c) =>
    c.json(await pump.review(c.req.param('threadId'), c.req.param('id'))),
  );
  app.post('/conversations/:threadId/pump/requests/:id/decline', (c) =>
    c.json(pump.decline(c.req.param('threadId'), c.req.param('id'))),
  );
  app.post('/conversations/:threadId/pump/requests/:id/submit', async (c) => {
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
            'Review the transaction and sign it in your connected wallet before submitting.',
        },
        400,
      );
    return c.json(
      await pump.submitConnected(
        c.req.param('threadId'),
        c.req.param('id'),
        parsed.data.transactionHash,
        parsed.data.signedTransactionBase64,
      ),
    );
  });
  app.post('/conversations/:threadId/pump/requests/:id/approve', async (c) => {
    const input = z
      .object({
        confirm: z.literal(true),
        transactionHash: z.string().regex(/^[a-f0-9]{64}$/),
        credential: z
          .object({
            type: z.enum(['owner', 'api_token']),
            value: z.string().min(1).max(4096),
          })
          .strict(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json(
        {
          error:
            'Review this transaction and provide a wallet credential to approve.',
        },
        400,
      );
    return c.json(
      await pump.approve(
        c.req.param('threadId'),
        c.req.param('id'),
        input.data.transactionHash,
        input.data.credential,
      ),
    );
  });
  return app;
}
