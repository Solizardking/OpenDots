import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarRoutes } from '../src/server/avatar-routes.js';
import { WorkspaceStore } from '../src/server/workspace.js';
const stores: WorkspaceStore[] = [];
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZy8AAAAASUVORK5CYII=';
const body = (data: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});
it('generates, edits with JSON source data, and stores image bytes durably', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avatars-'));
  const path = join(dir, 'db');
  let workspace = new WorkspaceStore(path, 'owner');
  try {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
    const app = avatarRoutes(workspace, { xaiApiKey: 'secret' }, request);
    const result = await app.request(
      '/avatars',
      body({ prompt: 'A blue plush Dot' }),
    );
    expect(result.status).toBe(201);
    const avatar = await result.json();
    expect(request.mock.calls[0][0]).toBe(
      'https://api.x.ai/v1/images/generations',
    );
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
      model: 'grok-imagine-image-2.0',
      aspect_ratio: '1:1',
      response_format: 'b64_json',
    });
    const dot = workspace.dots()[0];
    workspace.updateDot(dot.id, { ...dot, avatarId: avatar.id });
    workspace.close();
    workspace = new WorkspaceStore(path, 'owner');
    expect(workspace.dot(dot.id)?.avatarId).toBe(avatar.id);
    expect(workspace.avatar(avatar.id)?.dataUrl).toBe(
      `data:image/png;base64,${png}`,
    );
    const editRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
    const edit = avatarRoutes(workspace, { xaiApiKey: 'secret' }, editRequest);
    expect(
      (
        await edit.request(
          '/avatars',
          body({ prompt: 'Add glasses', sourceId: avatar.id }),
        )
      ).status,
    ).toBe(201);
    expect(editRequest.mock.calls[0][0]).toBe(
      'https://api.x.ai/v1/images/edits',
    );
    expect(
      JSON.parse(String(editRequest.mock.calls[0][1]?.body)).image,
    ).toEqual({ url: `data:image/png;base64,${png}`, type: 'image_url' });
  } finally {
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('rejects missing keys, invalid sources, provider denials and non-image bytes', async () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  stores.push(ws);
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      data: [{ b64_json: Buffer.from('<script>').toString('base64') }],
    }),
  );
  expect(
    (
      await avatarRoutes(ws, {}, request).request(
        '/avatars',
        body({ prompt: 'A Dot' }),
      )
    ).status,
  ).toBe(503);
  expect(request).not.toHaveBeenCalled();
  const app = avatarRoutes(ws, { xaiApiKey: 'secret' }, request);
  expect(
    (
      await app.request(
        '/avatars',
        body({
          prompt: 'A Dot',
          sourceId: '11111111-1111-4111-8111-111111111111',
        }),
      )
    ).status,
  ).toBe(404);
  expect(
    (await app.request('/avatars', body({ prompt: 'A Dot' }))).status,
  ).toBe(502);
  request.mockResolvedValueOnce(new Response('secret', { status: 401 }));
  const denied = await app.request('/avatars', body({ prompt: 'A Dot' }));
  expect(denied.status).toBe(502);
  expect(await denied.text()).not.toContain('secret');
});
