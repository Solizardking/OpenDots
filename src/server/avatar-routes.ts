import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from './workspace.js';
import { DEFAULT_XAI_IMAGE_MODEL } from './model-config.js';

const input = z
  .object({
    prompt: z.string().trim().min(3).max(1500),
    sourceId: z.string().uuid().optional(),
  })
  .strict();
export function avatarRoutes(
  workspace: WorkspaceStore,
  config: { xaiApiKey?: string; xaiImageModel?: string },
  request: typeof fetch = fetch,
) {
  const app = new Hono();
  let generating = false;
  app.get('/avatars/:id', (c) => {
    const avatar = workspace.avatar(c.req.param('id'));
    return avatar
      ? c.json(avatar)
      : c.json({ error: 'Avatar not found.' }, 404);
  });
  app.post('/avatars', async (c) => {
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: 'Describe your avatar in 3 to 1,500 characters.' },
        400,
      );
    if (!config.xaiApiKey)
      return c.json(
        { error: 'Set XAI_API_KEY on the server to generate avatars.' },
        503,
      );
    const source = parsed.data.sourceId
      ? workspace.avatar(parsed.data.sourceId)
      : undefined;
    if (parsed.data.sourceId && !source)
      return c.json({ error: 'Avatar not found.' }, 404);
    if (generating)
      return c.json(
        {
          error:
            'An avatar is already being generated. Please wait for it to finish.',
        },
        429,
      );
    generating = true;
    try {
      const prompt = source
        ? parsed.data.prompt
        : `Create a square avatar for a friendly personal AI companion called a Dot. One charming rounded plush character, centered, clearly readable at small sizes, soft studio lighting, simple clean background, no lettering. User description: ${parsed.data.prompt}`;
      const response = await request(
        `https://api.x.ai/v1/images/${source ? 'edits' : 'generations'}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.xaiApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: config.xaiImageModel || DEFAULT_XAI_IMAGE_MODEL,
            prompt,
            n: 1,
            response_format: 'b64_json',
            ...(source
              ? { image: { url: source.dataUrl, type: 'image_url' } }
              : { aspect_ratio: '1:1' }),
          }),
          signal: AbortSignal.any([
            c.req.raw.signal,
            AbortSignal.timeout(180_000),
          ]),
        },
      );
      if (!response.ok) {
        const error =
          response.status === 401 || response.status === 403
            ? 'xAI rejected the API key or image access. Check your xAI account.'
            : response.status === 429
              ? 'xAI image generation reached its quota or rate limit. Check your credits and retry.'
              : 'xAI could not generate this avatar. Try another description.';
        return c.json({ error }, 502);
      }
      const payload = (await response.json()) as {
        data?: { b64_json?: string; mime_type?: string }[];
      };
      const item = payload.data?.[0];
      const encoded = item?.b64_json;
      if (
        !encoded ||
        encoded.length > 12_000_000 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
      )
        return c.json(
          { error: 'xAI did not return a usable avatar image.' },
          502,
        );
      const bytes = Buffer.from(encoded, 'base64');
      const mime = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : bytes[0] === 255 && bytes[1] === 216
          ? 'image/jpeg'
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
              bytes.subarray(8, 12).toString() === 'WEBP'
            ? 'image/webp'
            : undefined;
      if (!mime)
        return c.json(
          { error: 'xAI returned an unsupported image format.' },
          502,
        );
      return c.json(
        workspace.saveAvatar(
          `data:${mime};base64,${encoded}`,
          parsed.data.prompt,
        ),
        201,
      );
    } catch {
      return c.json(
        {
          error:
            'Avatar generation was interrupted or timed out. Please retry.',
        },
        502,
      );
    } finally {
      generating = false;
    }
  });
  return app;
}
