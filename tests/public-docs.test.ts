import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractRoutes, publicDocumentation } from '../src/build/public-docs';
import { docsSections, filterDocs, isDocsPath } from '../src/client/docs-model';
import { createApp } from '../src/server/app';
import { Store } from '../src/server/store';
import { Runner } from '../src/server/runner';
import type { Config } from '../src/server/research';
import worker from '../deployment/chatgptee-edge.mjs';

const root = resolve(import.meta.dirname, '..');
describe('public documentation contracts', () => {
  it('builds searchable anchored sections from the exact downloadable guide', () => {
    const docs = publicDocumentation(root);
    const sections = docsSections(docs.guide);
    expect(sections.length).toBeGreaterThan(25);
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
    expect(
      filterDocs(sections, 'Jupiter signature').map((s) => s.id),
    ).toContain('jupiter-swaps-and-dflow-quotes');
    expect(filterDocs(sections, 'unfindable-documentation-fixture')).toEqual(
      [],
    );
    expect(docs.guide).toContain('## API route reference');
    expect(docs.article).toBe(
      readFileSync(resolve(root, 'ARTICLE.md'), 'utf8'),
    );
    expect(docs.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          path: '/api/conversations/:threadId/jupiter/requests/:id/submit',
        }),
        expect.objectContaining({
          method: 'POST',
          path: '/api/auth/solana/verify',
        }),
        expect.objectContaining({
          method: 'PUT',
          path: '/api/dots/:dotId/trading/strategy',
        }),
      ]),
    );
  });

  it('extracts static route prefixes, concatenation, auth endpoints and multiline registrations without mistaking store operations for routes', () => {
    const rows = extractRoutes(
      "const base = '/dots/:id'; app.post(base + '/review', handler); app.get(\n'/status', handler); store.get('/private'); createAuthEndpoint('/solana/nonce', {method:'POST'}, handler);",
      'fixture.ts',
      '/api',
      'Fixture',
      'Session',
    );
    expect(rows.map((r) => r.method + ' ' + r.path)).toEqual([
      'POST /api/dots/:id/review',
      'GET /api/status',
      'POST /api/solana/nonce',
    ]);
  });

  it('keeps the public docs route exact and independent of private API access', async () => {
    expect(isDocsPath('/docs')).toBe(true);
    expect(isDocsPath('/docs/')).toBe(true);
    expect(isDocsPath('/docs/index.html')).toBe(true);
    expect(isDocsPath('/docs/api.json')).toBe(false);
    expect(isDocsPath('/api/docs')).toBe(false);
    const entry = readFileSync(resolve(root, 'src/client/main.tsx'), 'utf8');
    expect(entry.indexOf('{publicPage ?')).toBeLessThan(
      entry.indexOf('<SolanaProvider>'),
    );
    expect(
      readFileSync(resolve(root, 'src/client/DocsPage.tsx'), 'utf8'),
    ).not.toMatch(/from ['"]\.\/api['"]/);
    const store = new Store(':memory:');
    try {
      const config: Config = {
        mode: 'sample',
        baseUrl: 'https://api.openai.com/v1',
      };
      const app = createApp({
        store,
        config,
        runner: new Runner(store, config),
        ownerToken: 'fixture-owner',
      });
      expect((await app.request('/api/state')).status).toBe(401);
      expect(
        (
          await app.request('/api/state', {
            headers: { Authorization: 'Bearer fixture-owner' },
          })
        ).status,
      ).toBe(200);
    } finally {
      store.close();
    }
  });

  it('lists every registered base-app route and ships only curated documentation sources', () => {
    const store = new Store(':memory:');
    try {
      const config: Config = {
        mode: 'sample',
        baseUrl: 'https://api.openai.com/v1',
      };
      const app = createApp({
        store,
        config,
        runner: new Runner(store, config),
      });
      const routes = publicDocumentation(root).routes;
      for (const route of app.routes.filter((r) => r.method !== 'ALL'))
        expect(
          routes.some(
            (row) => row.method === route.method && row.path === route.path,
          ),
        ).toBe(true);
      const source = readFileSync(
        resolve(root, 'src/build/public-docs.ts'),
        'utf8',
      );
      expect(source).not.toContain('glob');
      expect(source).not.toContain('RELEASE-HANDOFF.md');
      expect(source).not.toContain('INTEGRATION-VERIFICATION.md');
    } finally {
      store.close();
    }
  });

  it.each([
    '/docs',
    '/docs/',
    '/docs/GUIDE.md',
    '/docs/ARTICLE.md',
    '/ARTICLE.md',
    '/docs/API.md',
    '/docs/api.json',
    '/privacy',
    '/privacy/index.html',
    '/terms',
    '/terms/index.html',
    '/service',
    '/service/index.html',
    '/PRIVACY.md',
    '/TERMS.md',
    '/SERVICE.md',
  ])(
    'forwards %s to the app origin without changing its path or requiring auth proof',
    async (path) => {
      const original = globalThis.fetch;
      let forwarded = '';
      globalThis.fetch = async (request) => {
        forwarded = (request as Request).url;
        return new Response('docs', {
          headers: {
            'Content-Type': path.endsWith('.json')
              ? 'application/json'
              : 'text/html',
          },
        });
      };
      try {
        const response = await worker.fetch(
          new Request('https://chatgptee.ai' + path),
          {
            APP_UPSTREAM: 'https://fixture.example',
            BRAND_ASSETS: { fetch: async () => new Response('wrong') },
          },
        );
        expect(response.status).toBe(200);
        expect(forwarded).toBe('https://fixture.example' + path);
        expect(response.headers.has('x-chatgptee-proxy-secret')).toBe(false);
      } finally {
        globalThis.fetch = original;
      }
    },
  );
});
