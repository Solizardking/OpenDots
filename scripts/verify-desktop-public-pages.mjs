import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from '../dist/server/server/desktop-server.js';
import { desktopPageToken } from '../dist/server/server/public-page-access.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'chatgptee-page-auth-fixture-'));
const output = resolve(root, 'artifacts/public-pages');
mkdirSync(output, { recursive: true });
const token = 'fixture-owner-token-for-local-page-boundary-only';
let runtime;
const report = {
  scope:
    'Actual desktop server; temporary empty workspace; no configured provider or companion relay',
  publicPages: [],
};
try {
  runtime = await startDesktopServer({
    dataPath: temporary,
    clientPath: resolve(root, 'dist/client'),
    token,
    env: {},
    port: 0,
  });
  const request = (path, options = {}) =>
    fetch(runtime.origin + path, { redirect: 'manual', ...options });
  for (const path of ['/docs', '/privacy', '/terms', '/service']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<!doctype html>/i);
    report.publicPages.push({ path, status: response.status });
  }
  assert.equal((await request('/')).headers.get('location'), '/docs');
  assert.equal((await request('/workspace')).headers.get('location'), '/login');
  const shellProof = {
    Cookie: 'chatgptee_desktop_page=' + desktopPageToken(token),
  };
  assert.equal((await request('/', { headers: shellProof })).status, 200);
  assert.equal(
    (await request('/api/auth/session', { headers: shellProof })).status,
    401,
  );
  assert.equal(
    (
      await request('/api/auth/session', {
        headers: { Authorization: 'Bearer ' + token },
      })
    ).status,
    200,
  );
  assert.equal((await request('/api/workspace')).status, 401);
  assert.equal(
    (
      await request('/api/workspace', {
        headers: { Authorization: 'Bearer ' + token },
      })
    ).status,
    200,
  );
  assert.equal((await request('/privacy/private')).status, 404);
  assert.equal((await request('/docs/missing.md')).status, 404);
  assert.equal(
    (await request('/PRIVACY.md')).headers.get('content-type'),
    'text/markdown; charset=utf-8',
  );
  Object.assign(report, {
    anonymousPrivatePage: 302,
    shellCookieAccepted: 200,
    shellCookieApiDenied: 401,
    ownerApiAccepted: 200,
    anonymousWorkspaceApiDenied: 401,
    unknownPublicFile: 404,
  });
  writeFileSync(
    resolve(output, 'desktop-access.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime?.close();
  rmSync(temporary, { recursive: true, force: true });
}
