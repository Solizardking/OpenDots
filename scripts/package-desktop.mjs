import { packager } from '@electron/packager';
import { sign } from '@electron/osx-sign';
import { mkdirSync, cpSync, readFileSync, writeFileSync, statSync, createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = process.env.DOTS_ARTIFACT_DIRECTORY || join(root, 'artifacts/solana-dots');
const runtime = join(directory, 'runtime');
const source = join(directory, 'application');
const iconset = join(directory, 'SolanaDots.iconset');
const icon = join(directory, 'SolanaDots.icns');
const manifest = JSON.parse(readFileSync(join(root, 'package.json')));
const identity = process.env.DOTS_SIGNING_IDENTITY || 'Developer ID Application: James Knox (MU4489QPHP)';
const teamId = 'MU4489QPHP';
mkdirSync(join(source, 'electron'), { recursive: true });
mkdirSync(iconset, { recursive: true });
cpSync(join(runtime, 'electron/main.mjs'), join(source, 'electron/main.mjs'));
cpSync(join(runtime, 'electron/preload.cjs'), join(source, 'electron/preload.cjs'));
cpSync(join(root, 'LICENSE'), join(source, 'LICENSE'));
writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'solana-dots', productName: 'Solana Dots', version: manifest.version, description: manifest.description, type: 'module', main: 'electron/main.mjs', license: 'MIT' }, null, 2));
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) execFileSync('sips', ['-z', String(size * scale), String(size * scale), join(runtime, 'app-icon.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icon]);
const [appDirectory] = await packager({
  dir: source, name: 'Solana Dots', appBundleId: 'com.solanadots.app', appVersion: manifest.version,
  platform: 'darwin', arch: 'arm64', electronVersion: manifest.devDependencies.electron,
  out: join(directory, 'release'), overwrite: true, asar: true, icon,
  extraResource: [join(runtime, 'client'), join(runtime, 'server'), join(runtime, 'app-icon.png'), join(runtime, 'LICENSE-OpenDots.txt'), join(runtime, 'THIRD-PARTY-NOTICES.txt'), join(runtime, 'source-manifest.json')],
  extendInfo: { NSMicrophoneUsageDescription: 'Solana Dots uses your microphone only when you start a call.', NSLocalNetworkUsageDescription: 'Pair your phone with this Mac to continue your Solana Dots workspace over your local network.' },
});
const appPath = join(appDirectory, 'Solana Dots.app');
const isCode = file => {
  if (file.endsWith('.app') || file.endsWith('.framework')) return true;
  try {
    const fd = openSync(file, 'r'); const header = Buffer.alloc(4);
    try { readSync(fd, header, 0, 4, 0); } finally { closeSync(fd); }
    return ['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'));
  } catch { return false; }
};
await sign({ app: appPath, identity, platform: 'darwin', type: 'distribution', preAutoEntitlements: false, ignore: file => !isCode(file), optionsForFile: () => ({ hardenedRuntime: true, entitlements: join(runtime, 'electron/entitlements.plist') }) });
execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
execFileSync('codesign', ['-dv', '--verbose=4', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const filename = `Solana-Dots-${manifest.version}-macOS-arm64.zip`;
const archive = join(directory, 'release', filename);
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive]);
const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
const plist = execFileSync('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' });
const info = JSON.parse(plist);
const sourceManifest = JSON.parse(readFileSync(join(runtime, 'source-manifest.json')));
const release = { inputsHash: sourceManifest.inputsHash, electronVersion: manifest.devDependencies.electron, releaseId: `solana-dots-${manifest.version}-macos-arm64`, product: 'Solana Dots', version: manifest.version, filename, platform: 'macOS', architecture: 'arm64', minimumMacOS: info.LSMinimumSystemVersion, bundleId: 'com.solanadots.app', developerId: 'James Knox (MU4489QPHP)', teamId, signed: true, notarized: false, bytes: statSync(archive).size, sha256: hash.digest('hex'), appPath, source: root, builtAt: new Date().toISOString() };
writeFileSync(join(directory, 'release/release.json'), JSON.stringify(release, null, 2) + '\n');
console.log(JSON.stringify({ appPath, archive, release }, null, 2));
