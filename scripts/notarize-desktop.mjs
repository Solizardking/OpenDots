import { execFileSync } from 'node:child_process';
import { createReadStream, readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = join(root, 'artifacts/solana-dots/release');
const file = join(directory, 'release.json');
const release = JSON.parse(readFileSync(file));
const profile = process.env.DOTS_NOTARY_PROFILE || 'clawd-bot-notary';
const archive = join(directory, release.filename);
const inputHash = createHash('sha256'); for await (const chunk of createReadStream(archive)) inputHash.update(chunk);
if (statSync(archive).size !== release.bytes || inputHash.digest('hex') !== release.sha256) throw Error('Archive differs from the verified release manifest. Repackage before submitting.');
execFileSync('codesign', ['--verify', '--deep', '--strict', release.appPath]);
let result;
try { result = JSON.parse(execFileSync('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { encoding: 'utf8', maxBuffer: 1024 * 1024 })); }
catch { throw Error(`Apple submission could not finish. Configure the ${profile} Keychain profile or inspect notarytool history; release remains unnotarized.`); }
writeFileSync(join(directory, 'notary-submission.json'), JSON.stringify(result, null, 2));
if (result.status !== 'Accepted') {
  execFileSync('xcrun', ['notarytool', 'log', result.id, '--keychain-profile', profile, join(directory, 'notary-log.json')]);
  throw Error('Apple did not accept this app. Review notary-log.json.');
}
execFileSync('xcrun', ['stapler', 'staple', release.appPath], { stdio: 'inherit' });
execFileSync('xcrun', ['stapler', 'validate', release.appPath], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', release.appPath]);
execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=2', release.appPath], { stdio: 'inherit' });
execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', release.appPath, archive]);
const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
writeFileSync(file, JSON.stringify({ ...release, notarized: true, notarySubmissionId: result.id, bytes: statSync(archive).size, sha256: hash.digest('hex'), notarizedAt: new Date().toISOString() }, null, 2) + '\n');
console.log('Apple accepted the app; ticket stapled and Gatekeeper verified. Release manifest updated.');
