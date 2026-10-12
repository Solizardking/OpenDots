import { build } from 'esbuild';
import { mkdirSync, cpSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(process.env.DOTS_ARTIFACT_DIRECTORY || join(root, 'artifacts/solana-dots'), 'runtime');
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'server'), { recursive: true });
await build({
  entryPoints: [join(root, 'src/server/desktop-server.ts')], outfile: join(output, 'server/desktop-server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['playwright', '@open-wallet-standard/core'],
  plugins: [{ name: 'bundled-package-metadata', setup(builder) {
    builder.onLoad({ filter: /channels-core\/dist\/create-channel\.js$/ }, ({ path }) => ({
      contents: readFileSync(path, 'utf8').replace('createRequire(import.meta.url)("../package.json")', JSON.stringify(JSON.parse(readFileSync(join(dirname(dirname(path)), 'package.json'))))), loader: 'js',
    }));
  } }],
  banner: { js: "import { createRequire as dotsCreateRequire } from 'node:module'; import { fileURLToPath as dotsFileURLToPath } from 'node:url'; import { dirname as dotsDirname } from 'node:path'; const require = dotsCreateRequire(import.meta.url); const __filename = dotsFileURLToPath(import.meta.url); const __dirname = dotsDirname(__filename);" },
  metafile: true,
}).then(result => writeFileSync(join(output, 'server-build.json'), JSON.stringify(result.metafile, null, 2)));
cpSync(join(root, 'dist/client'), join(output, 'client'), { recursive: true });
// N-API wallet bindings and Playwright resolve assets relative to their packages.
for (const name of ['@open-wallet-standard/core', '@open-wallet-standard/core-darwin-arm64', 'playwright', 'playwright-core']) {
  cpSync(join(root, 'node_modules', name), join(output, 'server/node_modules', name), { recursive: true });
}
cpSync(join(root, 'public/brand/solana-dots-icon.png'), join(output, 'app-icon.png'));
// All runtime inputs are explicit. Private .env, user data, logs and tests are excluded.
cpSync(join(root, 'LICENSE'), join(output, 'LICENSE-OpenDots.txt'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
cpSync(join(root, 'electron'), join(output, 'electron'), { recursive: true });
const inputs = [];
function record(path) {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) record(file);
    else if (entry.isFile()) inputs.push({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') });
  }
}
for (const path of ['src', 'electron', 'public', 'scripts']) record(path);
for (const file of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'LICENSE', 'ARTICLE.md', 'docs/PUBLIC-GUIDE.md', 'PRIVACY.md', 'TERMS.md', 'SERVICE.md']) inputs.push({ file, sha256: createHash('sha256').update(readFileSync(join(root, file))).digest('hex') });
inputs.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(join(output, 'source-manifest.json'), JSON.stringify({ version: manifest.version, inputsHash: createHash('sha256').update(JSON.stringify(inputs)).digest('hex'), files: inputs }, null, 2));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
const notices = ['Solana Dots third-party notices', 'Dependency metadata and available license notices for production packages.'];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev || !existsSync(join(root, path, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(root, path, 'package.json')));
  notices.push(`\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license || metadata.license || 'See package source'}\n${typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || pkg.homepage || ''}`);
  for (const name of readdirSync(join(root, path))) {
    if (/^(license|licence|copying|notice)(\.[\w-]+)?$/i.test(name)) {
      try { notices.push(readFileSync(join(root, path, name), 'utf8')); } catch {}
    }
  }
}
writeFileSync(join(output, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'));
console.log(JSON.stringify({ built: true, version: manifest.version, output, secretsIncluded: false }));
