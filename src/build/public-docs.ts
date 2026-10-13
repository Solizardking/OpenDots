import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';
import type { PublicProductPage } from '../shared/public-pages';

export interface DocumentedRoute {
  method: string;
  path: string;
  group: string;
  access: string;
  source: string;
  line: number;
}

const modules = [
  ['src/server/index.ts', '', 'Service readiness', 'Public health response'],
  [
    'src/server/app.ts',
    '',
    'Tasks, settings and workspace memory',
    'Workspace session or owner token',
  ],
  [
    'src/server/workspace-routes.ts',
    '/api',
    'Workspace, Dots, conversations and calls',
    'Workspace session or owner token',
  ],
  [
    'src/server/page-routes.ts',
    '/api',
    'Pages and reviewed documents',
    'Workspace session or owner token',
  ],
  [
    'src/server/avatar-routes.ts',
    '/api',
    'Avatars',
    'Workspace session or owner token',
  ],
  [
    'src/server/computer-routes.ts',
    '/api',
    'Dot computers',
    'Workspace session plus computer permission',
  ],
  [
    'src/server/browser-use-routes.ts',
    '/api',
    'Browser Use',
    'Workspace session plus Browser Use permission',
  ],
  [
    'src/server/connection-routes.ts',
    '/api',
    'MCP connections and approvals',
    'Workspace session plus current tool permission',
  ],
  [
    'src/server/wallet-routes.ts',
    '/api',
    'OWS wallets, policies and scoped keys',
    'Workspace session; explicit credential and confirmation to sign',
  ],
  [
    'src/server/pump-routes.ts',
    '/api',
    'Pump.fun reviews and transactions',
    'Workspace session; explicit wallet approval to submit',
  ],
  [
    'src/server/jupiter-routes.ts',
    '/api',
    'Jupiter quotes and swaps',
    'Workspace session; explicit wallet approval to submit',
  ],
  [
    'src/server/dflow-routes.ts',
    '/api',
    'DFlow indicative quotes',
    'Workspace session or owner token',
  ],
  [
    'src/server/openmarket-routes.ts',
    '/api',
    'OpenMarket datasets',
    'Workspace session; Data API entitlement',
  ],
  [
    'src/server/birdeye-routes.ts',
    '/api',
    'Birdeye market research and alerts',
    'Workspace session plus conversation research permission; Birdeye entitlement',
  ],
  [
    'src/server/birdeye-mcp-routes.ts',
    '/api',
    'Birdeye MCP and meme token data',
    'Workspace session plus conversation research permission; Birdeye entitlement',
  ],
  [
    'src/server/trading-routes.ts',
    '/api',
    'Trading Brain',
    'Workspace session plus research/memory permissions',
  ],
  [
    'src/server/openrouter-batch.ts',
    '/api/openrouter/batches',
    'OpenRouter batch jobs',
    'Workspace session; configured paid provider',
  ],
  [
    'src/server/messaging-routes.ts',
    '/api/messaging',
    'Messaging links',
    'Workspace session or owner token',
  ],
  [
    'src/server/solana-auth.ts',
    '/api/auth',
    'Authentication',
    'Public challenge/session; verified proof for sign-in',
  ],
  [
    'src/server/better-auth.ts',
    '/api/auth',
    'Authentication',
    'Public config/session; verified proof or current session',
  ],
  [
    'src/server/solana-better-auth.ts',
    '/api/auth',
    'Authentication',
    'Public nonce; verified proof for sign-in/linking',
  ],
  [
    'src/server/agent-access.ts',
    '/api/agent',
    'External-agent authorization and API proxy',
    'Route-specific Privy proof, grant or public offer',
  ],
  [
    'src/server/desktop-server.ts',
    '',
    'Native desktop and companion controls',
    'Desktop owner token or limited paired-device access',
  ],
] as const;

export function extractRoutes(
  source: string,
  file: string,
  prefix: string,
  group: string,
  access: string,
): DocumentedRoute[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string>();
  const literal = (node: ts.Node | undefined): string | undefined => {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return constants.get(node.text);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = literal(node.left),
        right = literal(node.right);
      if (left !== undefined && right !== undefined) return left + right;
    }
    return undefined;
  };
  const rows: DocumentedRoute[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const value = literal(node.initializer);
      if (value !== undefined) constants.set(node.name.text, value);
    }
    if (ts.isCallExpression(node)) {
      let method: string | undefined;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        ['app', 'routes'].includes(node.expression.expression.text) &&
        ['get', 'post', 'put', 'patch', 'delete', 'all'].includes(
          node.expression.name.text,
        )
      ) {
        method = node.expression.name.text.toUpperCase();
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createAuthEndpoint'
      ) {
        const options = node.arguments[1];
        if (options && ts.isObjectLiteralExpression(options)) {
          const field = options.properties.find(
            (p) =>
              ts.isPropertyAssignment(p) && p.name.getText(tree) === 'method',
          );
          if (field && ts.isPropertyAssignment(field))
            method = literal(field.initializer);
        }
      }
      const path = literal(node.arguments[0]);
      if (method && path && path !== '*' && path !== '/api/*') {
        const joined = (prefix + (path === '/' ? '' : path)).replace(
          /\/+/g,
          '/',
        );
        rows.push({
          method,
          path: joined || '/',
          group,
          access,
          source: file,
          line:
            tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return rows;
}

export function publicDocumentation(root: string) {
  const guideSource = readFileSync(
    resolve(root, 'docs/PUBLIC-GUIDE.md'),
    'utf8',
  );
  const article = readFileSync(resolve(root, 'ARTICLE.md'), 'utf8');
  const byKey = new Map<string, DocumentedRoute>();
  for (const [file, prefix, group, access] of modules) {
    const rows = extractRoutes(
      readFileSync(resolve(root, file), 'utf8'),
      file,
      prefix,
      group,
      access,
    );
    for (const row of rows) {
      const key = row.method + ' ' + row.path;
      // Prefer the hosted account contract for shared auth paths.
      if (file === 'src/server/desktop-server.ts' && byKey.has(key)) continue;
      byKey.set(key, row);
    }
  }
  const routes = [...byKey.values()].sort(
    (a, b) =>
      a.group.localeCompare(b.group) ||
      a.path.localeCompare(b.path) ||
      a.method.localeCompare(b.method),
  );
  const rows = routes.map(
    (r) =>
      '| ' +
      r.method +
      ' | ' +
      r.path +
      ' | ' +
      r.access +
      ' | ' +
      r.source +
      ':' +
      r.line +
      ' |',
  );
  let reference = '';
  for (const group of [...new Set(routes.map((r) => r.group))]) {
    reference +=
      '\n### ' +
      group +
      '\n\n| Method | Route | Access / precondition | Implementation |\n| --- | --- | --- | --- |\n';
    reference +=
      rows.filter((_, index) => routes[index].group === group).join('\n') +
      '\n';
  }
  const api =
    '# ChatGPTEE API route reference\n\n' +
    'Generated from first-party registrations in the current checkout. Colon segments are owned-resource parameters. ' +
    'ALL denotes a catchall handler with its own validation, not permission for every path or method. ' +
    'Standard Better Auth endpoints are handled by its installed client behind /api/auth/*.\n\n' +
    reference;
  const guide =
    guideSource.trimEnd() +
    '\n\n## API route reference\n\n' +
    routes.length +
    ' first-party route registrations, including native/companion controls. ' +
    'Read the group access requirements and the API contracts above before calling a route. ' +
    'Source locations identify the request validation and response implementation in this checkout.\n\n' +
    reference;
  const policies: Record<
    Exclude<PublicProductPage, '/docs'>,
    { title: string; description: string; download: string; content: string }
  > = {
    '/privacy': {
      title: 'Privacy Policy',
      description:
        'ChatGPTEE data flows, storage, providers, retention and privacy controls.',
      download: '/PRIVACY.md',
      content: readFileSync(resolve(root, 'PRIVACY.md'), 'utf8'),
    },
    '/terms': {
      title: 'Terms of Service',
      description:
        'ChatGPTEE account, content, provider, approval and service responsibilities.',
      download: '/TERMS.md',
      content: readFileSync(resolve(root, 'TERMS.md'), 'utf8'),
    },
    '/service': {
      title: 'Service',
      description:
        'ChatGPTEE features, access controls, provider dependencies and support.',
      download: '/SERVICE.md',
      content: readFileSync(resolve(root, 'SERVICE.md'), 'utf8'),
    },
  };
  return { guide, article, api, routes, policies };
}

export function publicDocsPlugin(): Plugin {
  let root = '';
  const publicFiles = () => {
    const docs = publicDocumentation(root);
    return new Map([
      ...Object.values(docs.policies).map(
        (policy) =>
          [
            policy.download,
            { body: policy.content, type: 'text/markdown; charset=utf-8' },
          ] as const,
      ),
      [
        '/docs/GUIDE.md',
        { body: docs.guide, type: 'text/markdown; charset=utf-8' },
      ],
      [
        '/docs/ARTICLE.md',
        { body: docs.article, type: 'text/markdown; charset=utf-8' },
      ],
      [
        '/ARTICLE.md',
        { body: docs.article, type: 'text/markdown; charset=utf-8' },
      ],
      [
        '/docs/API.md',
        { body: docs.api, type: 'text/markdown; charset=utf-8' },
      ],
      [
        '/docs/api.json',
        {
          body: JSON.stringify(docs.routes, null, 2),
          type: 'application/json; charset=utf-8',
        },
      ],
    ]);
  };
  return {
    name: 'chatgptee-public-docs',
    enforce: 'post',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === 'virtual:chatgptee-docs') return '\0virtual:chatgptee-docs';
    },
    load(id) {
      if (id !== '\0virtual:chatgptee-docs') return;
      for (const file of [
        'docs/PUBLIC-GUIDE.md',
        'ARTICLE.md',
        'PRIVACY.md',
        'TERMS.md',
        'SERVICE.md',
        ...modules.map((m) => m[0]),
      ])
        this.addWatchFile(resolve(root, file));
      const docs = publicDocumentation(root);
      return (
        'export const guide = ' +
        JSON.stringify(docs.guide) +
        '; export const article = ' +
        JSON.stringify(docs.article) +
        '; export const policies = ' +
        JSON.stringify(docs.policies) +
        '; export const routeCount = ' +
        docs.routes.length +
        ';'
      );
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path || !['GET', 'HEAD'].includes(request.method || ''))
          return next();
        const asset = publicFiles().get(path);
        if (!asset) return next();
        response.setHeader('Content-Type', asset.type);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.end(request.method === 'HEAD' ? undefined : asset.body);
      });
    },
    generateBundle(_options, bundle) {
      for (const [path, asset] of publicFiles())
        this.emitFile({
          type: 'asset',
          fileName: path.slice(1),
          source: asset.body,
        });
      const shell = bundle['index.html'];
      if (shell?.type === 'asset' && typeof shell.source === 'string') {
        const html = shell.source
          .replace(
            '<title>ChatGPTEE</title>',
            '<title>ChatGPTEE Docs — Dots, Spaces, computers and Solana</title>',
          )
          .replace(
            'ChatGPTEE is your personal agent workspace. Chat, call, browse, and create with your Dots.',
            'Complete ChatGPTEE documentation for Dots, Spaces, agent computers, permissions, wallets, APIs and deployment.',
          )
          .replace(
            '</head>',
            '<link rel="canonical" href="https://chatgptee.ai/docs" /><meta property="og:title" content="ChatGPTEE documentation" /><meta property="og:description" content="Learn Dots, Spaces, computers, approved actions, APIs and hosting." /></head>',
          )
          .replace(
            '<div id="root"></div>',
            '<div id="root"></div><noscript>ChatGPTEE documentation is available as <a href="/docs/GUIDE.md">a complete downloadable Markdown guide</a>.</noscript>',
          );
        this.emitFile({
          type: 'asset',
          fileName: 'docs/index.html',
          source: html,
        });
        for (const [path, policy] of Object.entries(
          publicDocumentation(root).policies,
        )) {
          const content = shell.source
            .replace(
              '<title>ChatGPTEE</title>',
              '<title>' + policy.title + ' — ChatGPTEE</title>',
            )
            .replace(
              'ChatGPTEE is your personal agent workspace. Chat, call, browse, and create with your Dots.',
              policy.description,
            )
            .replace(
              '</head>',
              '<link rel="canonical" href="https://chatgptee.ai' +
                path +
                '" /></head>',
            )
            .replace(
              '<div id="root"></div>',
              '<div id="root"></div><noscript><a href="' +
                policy.download +
                '">Read ' +
                policy.title +
                ' as Markdown</a></noscript>',
            );
          this.emitFile({
            type: 'asset',
            fileName: path.slice(1) + '/index.html',
            source: content,
          });
        }
      }
    },
  };
}
