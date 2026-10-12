import { cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(root, 'artifacts/solana-dots', `source-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(destination, { recursive: true });
for (const name of ['src', 'tests', 'public', 'electron', 'scripts', 'docs', 'deployment', 'compose.yml', 'package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'eslint.config.js', 'LICENSE', '.prettierrc.json', 'ARTICLE.md', 'PRIVACY.md', 'TERMS.md', 'SERVICE.md']) cpSync(join(root, name), join(destination, name), { recursive: true });
// Installed packages are reused; private environment and user data are excluded.
symlinkSync(join(root, 'node_modules'), join(destination, 'node_modules'), 'dir');
console.log(destination);
