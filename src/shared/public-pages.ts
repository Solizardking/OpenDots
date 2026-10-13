export const PUBLIC_PRODUCT_PAGES = [
  '/docs',
  '/privacy',
  '/terms',
  '/service',
] as const;
export type PublicProductPage = (typeof PUBLIC_PRODUCT_PAGES)[number];

export const PUBLIC_ENTRY_UTILITIES = [
  '/login',
  '/signin',
  '/register',
  '/signup',
  '/authorize',
  '/pair',
  '/connect',
  '/supermemory/callback',
] as const;

export const PUBLIC_DOCUMENT_DOWNLOADS = [
  '/docs/GUIDE.md',
  '/docs/ARTICLE.md',
  '/ARTICLE.md',
  '/docs/API.md',
  '/docs/api.json',
  '/PRIVACY.md',
  '/TERMS.md',
  '/SERVICE.md',
] as const;

export function normalizePagePath(path: string) {
  return path.replace(/\/+$/, '') || '/';
}
export function publicProductPage(path: string): PublicProductPage | undefined {
  const normal = normalizePagePath(path).replace(/\/index\.html$/, '');
  return PUBLIC_PRODUCT_PAGES.find((page) => page === normal);
}
export function publicEntryUtility(path: string) {
  return (PUBLIC_ENTRY_UTILITIES as readonly string[]).includes(
    normalizePagePath(path),
  );
}
export function publicResource(path: string) {
  if ((PUBLIC_DOCUMENT_DOWNLOADS as readonly string[]).includes(path))
    return true;
  if (
    [
      '/logo.png',
      '/favicon.svg',
      '/theme.js',
      '/opendots-release.json',
      '/agent/SKILL.md',
      '/agent/chatgptee-agent-0.1.0.tgz',
      '/agent/chatgptee-agent-0.1.1.tgz',
    ].includes(path)
  )
    return true;
  return (
    /^\/(?:assets|brand|dots)\/[a-zA-Z0-9_./-]+\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|wasm|map)$/.test(
      path,
    ) && !path.includes('..')
  );
}
