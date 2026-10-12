import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  normalizePagePath,
  publicEntryUtility,
  publicProductPage,
  publicResource,
} from '../shared/public-pages.js';

export function desktopPageToken(ownerToken: string) {
  return createHash('sha256')
    .update('chatgptee-desktop-page:' + ownerToken)
    .digest('hex');
}
export function hasDesktopPageCookie(context: Context, ownerToken: string) {
  const supplied = Buffer.from(
    getCookie(context, 'chatgptee_desktop_page') || '',
  );
  const expected = Buffer.from(desktopPageToken(ownerToken));
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function pageAccessBoundary(
  authenticated: (context: Context) => boolean | Promise<boolean>,
): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const publicPath =
      publicProductPage(path) ||
      publicEntryUtility(path) ||
      publicResource(path);
    c.header('Cache-Control', 'no-store');
    if (publicPath) {
      if (!['GET', 'HEAD'].includes(c.req.method))
        return c.text('Method not allowed.', 405, { Allow: 'GET, HEAD' });
      await next();
      if (path.endsWith('.md') && publicResource(path) && c.res.status === 200)
        c.header('Content-Type', 'text/markdown; charset=utf-8');
      return;
    }
    if (
      /^\/(?:docs|privacy|terms|service|assets|brand|dots|agent)\//.test(path)
    )
      return c.text('Not found.', 404);
    if (!(await authenticated(c))) {
      if (['GET', 'HEAD'].includes(c.req.method)) {
        const root = normalizePagePath(path) === '/';
        const error = c.req.query('error');
        return c.redirect(
          root && !error ? '/docs' : '/login' + (error ? '?error=signin' : ''),
          302,
        );
      }
      return c.json({ error: 'Sign in to open your workspace.' }, 401);
    }
    await next();
  };
}

export function missingPublicResource(c: Context) {
  // A missing download/static file must never fall through to the app shell.
  return (
    publicResource(c.req.path) ||
    /^\/(?:docs|privacy|terms|service|assets|brand|dots|agent)\//.test(
      c.req.path,
    ) ||
    /\.(?:md|json|js|css|png|svg|tgz)$/.test(c.req.path)
  );
}
