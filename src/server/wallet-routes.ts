import { Hono } from 'hono';
import { z } from 'zod';
import { WalletError, WalletService } from './wallet-service.js';
import type { WorkspaceStore } from './workspace.js';
const name = z.string().trim().min(1).max(80);
const passphrase = z.string().min(12).max(1024);
const credential = z
  .object({
    type: z.enum(['owner', 'api_token']),
    value: z.string().min(1).max(1024),
  })
  .strict();
export function walletRoutes(
  wallets: WalletService,
  workspace: WorkspaceStore,
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof WalletError)
      return c.json(
        { error: error.message, code: error.code },
        error.status as 400,
      );
    return c.json(
      { error: 'Invalid wallet request.', code: 'INVALID_INPUT' },
      400,
    );
  });
  app.get('/wallets', (c) => c.json({ wallets: wallets.list() }));
  app.get('/wallets/:id', (c) => c.json(wallets.get(c.req.param('id'))));
  app.post('/wallets', async (c) => {
    const data = z
      .object({ name, passphrase })
      .strict()
      .parse(await c.req.json());
    return c.json(wallets.create(data.name, data.passphrase), 201);
  });
  app.post('/wallets/import', async (c) => {
    const data = z
      .object({
        name,
        passphrase,
        kind: z.enum(['mnemonic', 'private_key']),
        value: z.string().min(1).max(2000),
        chain: z.string().max(64).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      wallets.import(
        data.name,
        data.kind,
        data.value,
        data.passphrase,
        data.chain,
      ),
      201,
    );
  });
  app.delete('/wallets/:id', async (c) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    const id = wallets.get(c.req.param('id')).id;
    if (workspace.dots().some((dot) => dot.walletId === id))
      return c.json(
        {
          error: 'Detach this wallet from its Dots before deleting it.',
          code: 'INVALID_INPUT',
        },
        409,
      );
    return c.json(wallets.delete(id));
  });
  app.post('/wallets/:id/sign', async (c) => {
    const data = z
      .object({
        operation: z.enum([
          'sign',
          'signAndSend',
          'signMessage',
          'signTypedData',
        ]),
        chainId: z.string().min(1).max(64),
        payload: z.string().min(1).max(100000),
        credential,
        encoding: z.enum(['utf8', 'hex']).optional(),
        confirm: z.literal(true),
        rpcUrl: z.url().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      wallets.sign(
        c.req.param('id'),
        data.chainId,
        data.operation,
        data.payload,
        data.credential,
        data.rpcUrl,
        data.encoding,
      ),
    );
  });
  app.get('/wallet-policies', (c) => c.json({ policies: wallets.policies() }));
  app.get('/wallet-policies/:id', (c) =>
    c.json(wallets.policy(c.req.param('id'))),
  );
  app.post('/wallet-policies', async (c) => {
    const data = z
      .object({ policy: z.record(z.string(), z.unknown()) })
      .strict()
      .parse(await c.req.json());
    return c.json(wallets.createPolicy(data.policy), 201);
  });
  app.delete('/wallet-policies/:id', async (c) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    return c.json(wallets.deletePolicy(c.req.param('id')));
  });
  app.get('/wallet-api-keys', (c) => c.json({ keys: wallets.keys() }));
  app.post('/wallet-api-keys', async (c) => {
    const data = z
      .object({
        name,
        walletIds: z.array(z.string().uuid()).min(1),
        policyIds: z.array(z.string().min(1)).min(1),
        passphrase,
        expiresAt: z.iso.datetime().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      wallets.createKey(
        data.name,
        data.walletIds,
        data.policyIds,
        data.passphrase,
        data.expiresAt,
      ),
      201,
    );
  });
  app.delete('/wallet-api-keys/:id', async (c) => {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(await c.req.json());
    return c.json(wallets.revokeKey(c.req.param('id')));
  });
  return app;
}
