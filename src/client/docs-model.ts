export interface DocsSection {
  id: string;
  title: string;
  body: string;
}

export const isDocsPath = (path: string) =>
  ['/docs', '/docs/index.html'].includes(path.replace(/\/+$/, ''));
export const docsAnchor = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function docsSections(markdown: string): DocsSection[] {
  return markdown
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const newline = part.indexOf('\n');
      const title = part.slice(0, newline).trim();
      return {
        id: docsAnchor(title),
        title,
        body: part.slice(newline + 1).trim(),
      };
    });
}

export function filterDocs(sections: DocsSection[], query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return sections.filter((section) =>
    words.every((word) =>
      (section.title + ' ' + section.body).toLowerCase().includes(word),
    ),
  );
}
