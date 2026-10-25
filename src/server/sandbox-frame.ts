import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import {
  SANDBOX_FRAME_CSP,
  SANDBOX_FRAME_PATH,
  buildSandboxFrameDocument,
} from '../shared/generative-ui/frame-document.js';

let cached: string | undefined;

function frameDocument(): string {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@jetbrains/websandbox');
  const bundle = readFileSync(join(dirname(pkg), 'frame.js'), 'utf8');
  cached = buildSandboxFrameDocument(bundle);
  return cached;
}

// Served to `<iframe sandbox="allow-scripts">` only. The global security
// middleware runs first; this handler replaces its CSP with the sandbox one.
export function sandboxFrameRoute() {
  const app = new Hono();
  app.get(SANDBOX_FRAME_PATH, (c) => {
    c.header('Content-Security-Policy', SANDBOX_FRAME_CSP);
    c.header('Cache-Control', 'public, max-age=300');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    return c.html(frameDocument());
  });
  return app;
}
