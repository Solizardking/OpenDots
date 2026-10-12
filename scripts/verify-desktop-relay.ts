import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { startDesktopServer } from '../src/server/desktop-server';

const origin = process.argv[2] || 'http://127.0.0.1:8794';
const directory = mkdtempSync(join(tmpdir(), 'solana-dots-relay-'));
const evidence = 'artifacts/desktop-relay'; mkdirSync(evidence, { recursive: true });
const checks: string[] = [];
let runtime: Awaited<ReturnType<typeof startDesktopServer>> | undefined;
let cookie = '';
const select = async (mac: string) => {
  const result = await fetch(origin + '/api/relay/select', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ mac }) });
  assert.equal(result.status, 200); cookie = result.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.startsWith('solana_dots_phone=')).join('; ');
};
const call = (path: string, method = 'GET', body?: unknown, suppliedCookie = cookie) => fetch(origin + path, { method, headers: { Origin: origin, Cookie: suppliedCookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
const online = async () => {
  for (let i = 0; i < 120; i++) { if (runtime!.state().remote?.connected) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw Error('The native outbound relay did not connect.');
};
try {
  runtime = await startDesktopServer({ dataPath: directory, clientPath: join(process.cwd(), 'dist/client'), token: 'isolated-relay-fixture-owner-token', relayOrigin: origin });
  await runtime.action('start'); await online();
  const mac = runtime.state().remote!.id;
  await select(mac);
  assert.equal((await call('/api/workspace')).status, 401);
  const opened = await runtime.action('pair');
  const paired = await call('/api/companion/pair', 'POST', { credential: opened.pairing!.token, name: 'Relay QA phone' });
  assert.equal(paired.status, 200); cookie += '; ' + paired.headers.getSetCookie()[0].split(';')[0];
  assert(paired.headers.getSetCookie()[0].includes('Secure'));
  assert.equal((await call('/api/workspace')).status, 200);
  checks.push('outbound Mac WebSocket pairs a browser over the relay and grants only the Mac workspace');
  for (const [path, method] of [['/api/wallets', 'GET'], ['/api/wallets/fixture/sign', 'POST'], ['/api/settings','PATCH'], ['/api/connections','GET']]) assert.equal((await call(path, method, method === 'GET' ? undefined : {})).status, 403);
  assert.equal((await call('/api/companion/pair', 'POST', { credential: opened.pairing!.token, name: 'Replay' })).status, 400);
  assert.equal((await fetch(origin + '/api/companion/pair', { method: 'POST', headers: { Origin: 'https://untrusted.example', Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  checks.push('single-use pairing, cross-origin rejection, wallet/provider restrictions and secure cookies pass');
  const html = readFileSync('dist/client/index.html', 'utf8');
  const asset = /src="(\/assets\/[^" ]+\.js)"/.exec(html)![1];
  const response = await call(asset), bytes = Buffer.from(await response.arrayBuffer());
  const expected = readFileSync(join('dist/client', asset));
  assert.equal(response.status, 200); assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(expected).digest('hex'));
  checks.push('large native renderer assets stream through the relay with exact checksums');
  const state = runtime!.state(), device = state.devices.find(device => device.name === 'Relay QA phone')!;
  const stableMac = state.remote!.id;
  await runtime!.action('stop');
  for (let i = 0; i < 20; i++) { if ((await call('/api/workspace')).status === 503) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal((await call('/api/workspace')).status, 503);
  await runtime!.action('start'); await online(); assert.equal(runtime!.state().remote!.id, stableMac);
  assert.equal((await call('/api/workspace')).status, 200);
  checks.push('turning Phone access off closes the internet tunnel; restarting retains the Mac identity and device session');
  await runtime!.action('revoke', device.id); assert.equal((await call('/api/workspace')).status, 401);
  await select('f'.repeat(32)); assert.equal((await call('/api/workspace')).status, 503);
  checks.push('Mac revocation takes effect immediately and other Mac routing IDs cannot access the workspace');
  writeFileSync(join(evidence, origin.startsWith('https:') ? (process.argv.includes('--public-dns') ? 'public-dns-protocol.json' : 'live-protocol.json') : 'local-protocol.json'), JSON.stringify({ checkedAt: new Date().toISOString(), origin, dnsMode: process.argv.includes('--public-dns') ? 'public-resolver-in-test-process' : 'normal-network-resolver', checks, privateKeysUsed: false, modelRequests: 0 }, null, 2));
  console.log(JSON.stringify({ origin, checks }));
} finally { await runtime?.close(); rmSync(directory, { recursive: true, force: true }); }
