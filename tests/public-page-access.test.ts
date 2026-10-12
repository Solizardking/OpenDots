import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  pageAccessBoundary,
  missingPublicResource,
  desktopPageToken,
  hasDesktopPageCookie,
} from '../src/server/public-page-access';
import {
  PUBLIC_PRODUCT_PAGES,
  PUBLIC_ENTRY_UTILITIES,
  publicProductPage,
  publicResource,
} from '../src/shared/public-pages';
import { publicDocumentation } from '../src/build/public-docs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function fixture() {
  const app = new Hono();
  const hasSession = vi.fn(
    (c) => getCookie(c, 'fixture_session') === 'verified-account',
  );
  app.get('/api/auth/config', (c) => c.json({ fixture: true }));
  app.get('/api/auth/callback/provider', (c) =>
    c.json(
      { callback: 'Protocol remains reachable; proof still required' },
      401,
    ),
  );
  app.all('/api/workspace', (c) =>
    hasSession(c)
      ? c.json({ owner: 'verified-account' })
      : c.json({ error: 'Sign in' }, 401),
  );
  app.all('/api/agent/wallets', (c) =>
    c.json({ error: 'Privy authorization proof required' }, 401),
  );
  app.use('/*', pageAccessBoundary(hasSession));
  for (const path of [...PUBLIC_PRODUCT_PAGES, ...PUBLIC_ENTRY_UTILITIES])
    app.get(path, (c) => c.html('<h1>' + path + '</h1>'));
  app.get('/assets/site.js', (c) => c.text('fixture JavaScript'));
  app.get('/PRIVACY.md', (c) => c.text('# Privacy'));
  app.get('*', (c) =>
    missingPublicResource(c)
      ? c.text('Not found.', 404)
      : c.html('<h1>Private workspace shell</h1>'),
  );
  return { app, hasSession };
}
const session = { headers: { Cookie: 'fixture_session=verified-account' } };
describe('only four public product pages', () => {
  it('serves the four exact public product pages and their required resources without requesting an account', async () => {
    const { app, hasSession } = fixture();
    expect(PUBLIC_PRODUCT_PAGES).toEqual([
      '/docs',
      '/privacy',
      '/terms',
      '/service',
    ]);
    for (const path of [
      ...PUBLIC_PRODUCT_PAGES,
      '/assets/site.js',
      '/PRIVACY.md',
    ])
      expect((await app.request(path)).status).toBe(200);
    expect(hasSession).not.toHaveBeenCalled();
    expect(publicProductPage('/private')).toBeUndefined();
    expect(publicProductPage('/privacy/index.html')).toBe('/privacy');
    expect(publicProductPage('/terms/')).toBe('/terms');
    expect(publicResource('/assets/not-a-page.html')).toBe(false);
    expect(publicResource('/agent/unapproved.html')).toBe(false);
  });
  it('denies anonymous private pages and APIs while preserving authenticated account pages', async () => {
    const { app } = fixture();
    const home = await app.request('/');
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/docs');
    for (const path of [
      '/settings',
      '/workspace',
      '/unknown-product-page',
      '/auth/account',
    ]) {
      const denied = await app.request(path);
      expect(denied.status).toBe(302);
      expect(denied.headers.get('location')).toBe('/login');
      expect((await app.request(path, session)).status).toBe(200);
    }
    expect((await app.request('/api/workspace')).status).toBe(401);
    expect((await app.request('/api/workspace', session)).status).toBe(200);
    expect((await app.request('/workspace', { method: 'POST' })).status).toBe(
      401,
    );
    expect((await app.request('/privacy', { method: 'POST' })).status).toBe(
      405,
    );
  });
  it('keeps utility/callback protocols reachable without confusing them with granted access', async () => {
    const { app } = fixture();
    for (const path of PUBLIC_ENTRY_UTILITIES)
      expect((await app.request(path)).status).toBe(200);
    expect((await app.request('/api/auth/config')).status).toBe(200);
    expect((await app.request('/api/auth/callback/provider')).status).toBe(401);
    expect(
      (await app.request('/api/agent/wallets', { method: 'POST' })).status,
    ).toBe(401);
    expect((await app.request('/api/workspace')).status).toBe(401);
  });
  it('returns404 for unknown public-directory/download files rather than a private SPA shell', async () => {
    const { app } = fixture();
    for (const path of [
      '/docs/secret.md',
      '/privacy/private',
      '/assets/missing.js',
      '/brand/missing.png',
      '/agent/unknown.html',
    ]) {
      expect((await app.request(path)).status).toBe(404);
      expect((await app.request(path, session)).status).toBe(404);
    }
  });
  it('uses a native shell-only proof distinct from the owner API token', async () => {
    const app = new Hono();
    const owner = 'fixture-owner-token-with-sufficient-entropy';
    app.use(
      '/*',
      pageAccessBoundary((c) => hasDesktopPageCookie(c, owner)),
    );
    app.get('*', (c) => c.text('Native private shell'));
    expect(desktopPageToken(owner)).not.toBe(owner);
    expect((await app.request('/')).status).toBe(302);
    expect(
      (
        await app.request('/', {
          headers: { Cookie: 'chatgptee_desktop_page=' + owner },
        })
      ).status,
    ).toBe(302);
    expect(
      (
        await app.request('/', {
          headers: {
            Cookie: 'chatgptee_desktop_page=' + desktopPageToken(owner),
          },
        })
      ).status,
    ).toBe(200);
  });
  it('renders policy routes before wallet/auth initialization and emits exactly the authored policy sources', () => {
    const root = resolve(import.meta.dirname, '..');
    const entry = readFileSync(resolve(root, 'src/client/main.tsx'), 'utf8');
    expect(entry.indexOf('{publicPage ?')).toBeLessThan(
      entry.indexOf('<SolanaProvider>'),
    );
    const policyPage = readFileSync(
      resolve(root, 'src/client/PolicyPage.tsx'),
      'utf8',
    );
    expect(policyPage).not.toMatch(/from ['"]\.\/api['"]/);
    const docs = publicDocumentation(root);
    for (const [path, file] of [
      ['/privacy', 'PRIVACY.md'],
      ['/terms', 'TERMS.md'],
      ['/service', 'SERVICE.md'],
    ] as const)
      expect(docs.policies[path].content).toBe(
        readFileSync(resolve(root, file), 'utf8'),
      );
  });
});
