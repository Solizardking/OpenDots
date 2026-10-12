import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  MessagingCoordinator,
  MessagingRequestError,
} from './messaging-coordinator.js';
const platform = z.enum(['telegram', 'imessage']);
export function messagingRoutes(
  coordinator: MessagingCoordinator,
  owner: (context: Context) => Promise<string | undefined>,
) {
  const app = new Hono<{ Variables: { ownerId: string } }>();
  app.use(
    '*',
    bodyLimit({
      maxSize: 2048,
      onError: (c) => c.json({ error: 'Messaging request is too large.' }, 413),
    }),
  );
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const ownerId = await owner(c);
    if (!ownerId)
      return c.json({ error: 'Sign in to link your messaging account.' }, 401);
    c.set('ownerId', ownerId);
    await next();
  });
  app.get('/status', async (c) => {
    const dotId = c.req.query('dotId');
    if (dotId !== undefined && !z.string().uuid().safeParse(dotId).success)
      return c.json({ error: 'Choose a valid Dot.' }, 400);
    return c.json(await coordinator.status(c.get('ownerId'), dotId));
  });
  app.post('/link', async (c) => {
    const input = z
      .object({ platform, dotId: z.string().uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success)
      return c.json({ error: 'Choose a channel and a Dot.' }, 400);
    return c.json(
      await coordinator.link(
        c.get('ownerId'),
        input.data.platform,
        input.data.dotId,
      ),
    );
  });
  app.post('/unlink', async (c) => {
    const input = z
      .object({ platform })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: 'Choose a channel.' }, 400);
    coordinator.unlink(c.get('ownerId'), input.data.platform);
    return c.json(await coordinator.status(c.get('ownerId')));
  });
  app.onError((error, c) =>
    error instanceof MessagingRequestError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: 'Messaging is temporarily unavailable.' }, 503),
  );
  return app;
}
