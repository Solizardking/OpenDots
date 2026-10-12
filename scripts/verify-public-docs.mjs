import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { chromium } from 'playwright';
import {
  pageAccessBoundary,
  missingPublicResource,
} from '../dist/server/server/public-page-access.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'artifacts/public-pages');
mkdirSync(output, { recursive: true });
let server;
let origin = process.env.DOCS_VERIFY_URL;
if (!origin) {
  // Match the compiled Node app's public static middleware without starting
  // PostgreSQL, provider integrations, private workspaces or their lifecycle.
  const app = new Hono();
  app.get('/api/auth/config', (c) => c.json({ betterAuth: false }));
  app.get('/api/auth/session', (c) => c.json({ user: null, owner: false }));
  app.all('/api/*', (c) => c.json({ error: 'Fixture: sign in first.' }, 401));
  app.use(
    '/*',
    pageAccessBoundary(
      (c) => getCookie(c, 'fixture_session') === 'verified-account',
    ),
  );
  app.use('/*', serveStatic({ root: resolve(root, 'dist/client') }));
  app.get('*', async (c, next) => {
    if (missingPublicResource(c)) return c.text('Not found.', 404);
    const response = await serveStatic({
      path: resolve(root, 'dist/client/index.html'),
    })(c, next);
    return response || c.res;
  });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise((done) => server.once('listening', done));
  origin = 'http://127.0.0.1:' + server.address().port;
}
const browser = await chromium.launch(
  existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? { channel: 'chrome' }
    : {},
);
const report = {
  scope:
    'Local compiled static/server fixture or selected docs preview; no live provider verification',
  origin,
  viewports: [],
  downloads: [],
  policyPages: [],
  noPrivateRequests: true,
};
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 320, height: 740 },
  ]) {
    const context = await browser.newContext({
      viewport,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const errors = [];
    const privateRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/'))
        privateRequests.push(request.url());
    });
    for (const path of ['/docs', '/docs/', '/docs/index.html']) {
      const response = await page.goto(origin + path);
      assert.equal(response.status(), 200, path);
      await page
        .getByRole('heading', { name: 'Your workspace, explained.' })
        .waitFor();
      await page.reload();
      await page
        .getByRole('heading', { name: 'Your workspace, explained.' })
        .waitFor();
    }
    assert.match(await page.title(), /ChatGPTEE Docs/);
    assert.equal(
      await page.evaluate(() => {
        const container = document.getElementById('docs-root');
        return container.scrollWidth <= container.clientWidth + 1;
      }),
      true,
      'No page-wide horizontal overflow',
    );
    if (viewport.width < 760) {
      await page
        .getByRole('button', { name: 'Open documentation menu' })
        .click();
      assert.equal(
        await page
          .getByRole('button', {
            name: 'Close documentation menu',
            exact: true,
          })
          .first()
          .getAttribute('aria-expanded'),
        'true',
      );
    }
    const search = page.getByRole('searchbox', {
      name: 'Search documentation',
    });
    await search.fill('Jupiter signature');
    await page
      .getByRole('heading', {
        name: 'Jupiter swaps and DFlow quotes',
        exact: true,
      })
      .waitFor();
    await search.fill('unfindable-documentation-fixture');
    await page
      .getByRole('heading', { name: 'No results', exact: true })
      .waitFor();
    await page
      .locator('.docs-search')
      .getByRole('button', { name: 'Clear search', exact: true })
      .click();
    if (viewport.width < 760)
      await page
        .locator('#docs-sidebar')
        .getByRole('link', { name: 'Quick start', exact: true })
        .click();
    else
      await page
        .locator('#docs-sidebar')
        .getByRole('link', { name: 'Quick start', exact: true })
        .click();
    await page
      .getByRole('button', { name: 'Copy code example' })
      .first()
      .click();
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /Read the pages in my Launch Space/,
    );
    await page
      .getByRole('button', { name: 'The innovation article', exact: true })
      .click();
    await page
      .getByRole('heading', {
        name: 'ChatGPTEE: a workspace where agents can follow through',
        exact: true,
      })
      .waitFor();
    await page
      .getByRole('button', { name: 'Complete guide', exact: true })
      .click();
    await page.goto(origin + '/docs#jupiter-swaps-and-dflow-quotes');
    const target = page.locator('#jupiter-swaps-and-dflow-quotes');
    await target.waitFor();
    await page.waitForFunction(() => {
      const y = document
        .getElementById('jupiter-swaps-and-dflow-quotes')
        .getBoundingClientRect().top;
      return y >= 60 && y < 160;
    });
    await page.goto(origin + '/docs');
    await page
      .getByRole('heading', { name: 'Your workspace, explained.' })
      .waitFor();
    await page.screenshot({
      path: resolve(output, 'docs-' + viewport.width + '.png'),
      fullPage: false,
    });
    await page.evaluate(() =>
      document.documentElement.classList.add('native-desktop'),
    );
    assert.equal(
      await page
        .locator('.docs-root')
        .evaluate((element) => element.getBoundingClientRect().top),
      36,
      'Native titlebar leaves documentation header unobscured',
    );
    await page.evaluate(() =>
      document.documentElement.classList.remove('native-desktop'),
    );
    for (const [path, title] of [
      ['/privacy', 'Privacy Policy'],
      ['/terms', 'Terms of Service'],
      ['/service', 'Service'],
    ]) {
      for (const entry of [path, path + '/', path + '/index.html']) {
        const response = await page.goto(origin + entry);
        assert.equal(response.status(), 200, entry);
        await page.getByRole('heading', { name: title, exact: true }).waitFor();
      }
      await page.reload();
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      assert.match(await page.title(), new RegExp(title + '.*ChatGPTEE'));
      assert.equal(
        await page.locator('link[rel="canonical"]').getAttribute('href'),
        'https://chatgptee.ai' + path,
      );
      assert.equal(
        await page
          .locator('.docs-root')
          .evaluate(
            (element) => element.scrollWidth <= element.clientWidth + 1,
          ),
        true,
        path + ' has no horizontal overflow',
      );
      const firstSection = page.locator('.docs-section').first();
      const anchor = await firstSection.getAttribute('id');
      if (viewport.width < 760)
        await page.getByRole('button', { name: 'Open page menu' }).click();
      await page
        .locator('#policy-sidebar nav[aria-label="Policy sections"] a')
        .first()
        .click();
      assert.equal(new URL(page.url()).hash, '#' + anchor);
      await page.waitForFunction((id) => {
        const y = document.getElementById(id).getBoundingClientRect().top;
        return y >= 60 && y < 160;
      }, anchor);
      await page.goto(origin + path);
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
      await page.screenshot({
        path: resolve(output, path.slice(1) + '-' + viewport.width + '.png'),
        fullPage: false,
      });
      report.policyPages.push({
        path,
        viewport,
        aliases: true,
        reload: true,
        anchor: true,
        overflow: false,
      });
    }
    assert.deepEqual(errors, [], 'No browser runtime errors');
    assert.deepEqual(
      privateRequests,
      [],
      'Public docs never requests private workspace/auth APIs',
    );
    report.viewports.push({
      viewport,
      directPaths: ['/docs', '/docs/', '/docs/index.html'],
      reload: true,
      search: true,
      emptySearch: true,
      clipboard: true,
      article: true,
      deepLink: true,
      overflow: false,
      mobileMenu: viewport.width < 760,
      browserErrors: errors,
    });
    await context.close();
  }
  const page = await browser.newPage();
  for (const path of [
    '/docs/GUIDE.md',
    '/docs/ARTICLE.md',
    '/ARTICLE.md',
    '/docs/API.md',
    '/docs/api.json',
    '/PRIVACY.md',
    '/TERMS.md',
    '/SERVICE.md',
  ]) {
    const response = await page.request.get(origin + path);
    assert.equal(response.status(), 200, path);
    const body = await response.text();
    assert.ok(
      !body.includes('<!doctype html>'),
      'Download must not be SPA fallback',
    );
    if (path.includes('ARTICLE.md'))
      assert.equal(body, readFileSync(resolve(root, 'ARTICLE.md'), 'utf8'));
    if (['/PRIVACY.md', '/TERMS.md', '/SERVICE.md'].includes(path)) {
      assert.equal(body, readFileSync(resolve(root, path.slice(1)), 'utf8'));
      assert.match(response.headers()['content-type'], /text\/markdown/);
    }
    if (path.endsWith('api.json')) assert.ok(JSON.parse(body).length > 100);
    if (path.endsWith('GUIDE.md')) assert.match(body, /## API route reference/);
    report.downloads.push({
      path,
      status: response.status(),
      contentType: response.headers()['content-type'],
      bytes: Buffer.byteLength(body),
    });
  }
  assert.equal((await page.request.get(origin + '/api/state')).status(), 401);
  if (!process.env.DOCS_VERIFY_URL) {
    report.privatePages = [];
    for (const path of [
      '/',
      '/workspace',
      '/auth/account',
      '/unknown-product-page',
    ]) {
      const denied = await page.request.get(origin + path, { maxRedirects: 0 });
      assert.equal(denied.status(), 302, path);
      assert.equal(
        denied.headers().location,
        path === '/' ? '/docs' : '/login',
      );
      const accepted = await page.request.get(origin + path, {
        headers: { Cookie: 'fixture_session=verified-account' },
      });
      assert.equal(accepted.status(), 200, path);
      report.privatePages.push({
        path,
        anonymousStatus: 302,
        authenticatedStatus: 200,
      });
    }
    for (const path of [
      '/docs/secret.md',
      '/privacy/private',
      '/assets/missing.js',
      '/agent/unapproved.html',
    ])
      assert.equal((await page.request.get(origin + path)).status(), 404, path);
    await page.goto(origin + '/unknown-product-page');
    await page.locator('.auth-page').waitFor();
    assert.equal(new URL(page.url()).pathname, '/login');
    assert.equal(await page.locator('.workspace').count(), 0);
    report.anonymousFrontend = 'Sign-in frame, no workspace mount';
  }
  report.privateApiUnauthenticatedStatus = 401;
  writeFileSync(
    resolve(output, 'verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  if (server) await new Promise((done) => server.close(done));
}
