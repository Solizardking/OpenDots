import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Provider and feed adapters use native ESM with runtime schema validation.
// Type declarations serve the TS callers; copy the exact adapters into the
// compiled server. Desktop esbuild bundles these adapters directly.
const target = new URL('../dist/server/server/trading/', import.meta.url);
mkdirSync(target, { recursive: true });
for (const name of [
  'brain-service',
  'brain-store',
  'brain-providers',
  'launch-feed',
  'market-feed',
]) {
  cpSync(
    fileURLToPath(
      new URL(`../src/server/trading/${name}.mjs`, import.meta.url),
    ),
    fileURLToPath(new URL(`${name}.mjs`, target)),
  );
}
