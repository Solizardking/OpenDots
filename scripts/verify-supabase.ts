// Live Supabase database + existing sign-in verification with a generated fixture wallet.
// Run: node --env-file=.env --import tsx scripts/verify-supabase.ts
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import bs58 from 'bs58';
import { PostgresUserDatabase } from '../src/server/user-database.js';
import { databaseUrlFromEnv } from '../src/server/database-config.js';

const databaseUrl = databaseUrlFromEnv(process.env);
const base = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const publicKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
assert(
  base && publicKey && secretKey,
  'Configure the Supabase URL and public/server API keys.',
);
const tables = [
  'solana_dots_users',
  'solana_dots_auth_challenges',
  'solana_dots_sessions',
  'chatgptee_auth_user',
  'chatgptee_auth_account',
  'chatgptee_auth_session',
  'chatgptee_auth_verification',
  'chatgptee_auth_rate_limit',
];
const directory = mkdtempSync(join(tmpdir(), 'opendots-supabase-'));
const artifacts = 'artifacts/supabase-verification';
mkdirSync(artifacts, { recursive: true });
const keys = generateKeyPairSync('ed25519');
const wallet = bs58.encode(
  keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
);
const db = new PostgresUserDatabase(databaseUrl);
const cookies = new Map<string, string>();
let child: ChildProcess | undefined;
let diagnostics = '';
let userId: string | undefined;
let nonce: string | undefined;
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  databaseProvider: 'supabase',
  authProvider: 'existing Better Auth / Privy',
  workspaceStorage: 'per-user SQLite',
  supabaseStorageUsedByApp: false,
};
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const origin = `http://127.0.0.1:${port}`;
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => current.kill('SIGKILL'), 10000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    current.kill('SIGTERM');
  });
  child = undefined;
}
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_ORIGIN: origin,
      BETTER_AUTH_URL: origin,
      DATABASE_URL: databaseUrl,
      DATABASE_PATH: join(directory, 'workspace.sqlite'),
      USER_DATA_PATH: join(directory, 'users'),
      OWS_VAULT_PATH: join(directory, 'ows'),
      DO_NOT_TRACK: '1',
      SLACK_CHANNEL_NAME: '',
      SLACK_TEAM_ID: '',
      MEM0_API_KEY: '',
      INTELLIGENCE_API_KEY: '',
      CPK_INTELLIGENCE_API_KEY: '',
      COPILOTKIT_INTELLIGENCE_API_KEY: '',
      WEB_SEARCH_PROVIDER: 'disabled',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data) => {
    diagnostics = (diagnostics + String(data)).slice(-8000);
  });
  child.stderr?.on('data', (data) => {
    diagnostics = (diagnostics + String(data)).slice(-8000);
  });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    assert(
      child.exitCode === null,
      'The web runtime exited before becoming ready.',
    );
    try {
      if (
        (
          await fetch(origin + '/healthz', {
            signal: AbortSignal.timeout(1000),
          })
        ).ok
      )
        return;
    } catch {}
    await delay(250);
  }
  throw Error('The web runtime did not become ready.');
}
async function request(path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';')[0],
      index = pair.indexOf('=');
    if (pair.slice(index + 1))
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    else cookies.delete(pair.slice(0, index));
  }
  return response;
}
try {
  await start();
  report.postgresConnected = true;
  report.tlsVerified = true;
  report.webHealth = true;
  assert.equal((await request('/api/workspace')).status, 401);
  const challenge = await request('/api/auth/solana/nonce', {
    address: wallet,
  });
  assert(challenge.ok, 'Sign-in challenge failed.');
  const proof = (await challenge.json()) as {
    input: { nonce: string };
    message: string;
  };
  nonce = proof.input.nonce;
  const verified = await request('/api/auth/solana/verify', {
    nonce,
    message: proof.message,
    signature: bs58.encode(
      sign(null, Buffer.from(proof.message), keys.privateKey),
    ),
  });
  assert(verified.ok, 'The generated wallet proof failed.');
  const session = (await (await request('/api/auth/session')).json()) as {
    user?: { id: string; walletAddress: string };
    owner: boolean;
  };
  assert.equal(session.user?.walletAddress, wallet);
  assert.equal(session.owner, false);
  userId = session.user!.id;
  assert.equal(
    (
      await db.pool.query(
        'SELECT id FROM solana_dots_users WHERE id=$1 AND wallet_address=$2',
        [userId, wallet],
      )
    ).rowCount,
    1,
  );
  assert.equal((await request('/api/workspace')).status, 200);
  report.signedWalletLogin = true;
  report.userStoredInSupabase = true;
  report.privateWorkspaceAccessible = true;
  await stop();
  await start();
  const restored = (await (await request('/api/auth/session')).json()) as {
    user?: { id: string };
  };
  assert.equal(restored.user?.id, userId);
  assert.equal((await request('/api/workspace')).status, 200);
  report.sessionAfterServerRestart = true;
  assert((await request('/api/auth/logout', {})).ok);
  assert.equal((await request('/api/workspace')).status, 401);
  report.logoutRevokesAccess = true;
  const privacy = await db.pool.query<{
    tablename: string;
    rowsecurity: boolean;
    anon_read: boolean;
    authenticated_read: boolean;
  }>(
    "SELECT tablename,rowsecurity,has_table_privilege('anon',format('public.%I',tablename),'SELECT') AS anon_read,has_table_privilege('authenticated',format('public.%I',tablename),'SELECT') AS authenticated_read FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1)",
    [tables],
  );
  assert.equal(privacy.rows.length, tables.length);
  assert(
    privacy.rows.every(
      (row) => row.rowsecurity && !row.anon_read && !row.authenticated_read,
    ),
  );
  report.authTablesPrivate = true;
  report.protectedTables = tables.length;
  const probes = [];
  for (const table of tables) {
    const response = await fetch(`${base}/rest/v1/${table}?select=*&limit=0`, {
      headers: { apikey: publicKey },
      signal: AbortSignal.timeout(12000),
    });
    assert(
      [401, 403, 404].includes(response.status),
      `The public API can access ${table}.`,
    );
    probes.push({ table, status: response.status });
  }
  report.publicApiProbes = probes;
  const authApi = await fetch(base + '/auth/v1/settings', {
    headers: { apikey: publicKey },
    signal: AbortSignal.timeout(12000),
  });
  assert(authApi.ok);
  report.supabaseAuthApiReachable = true;
  report.supabaseAuthUsedByApp = false;
  const storage = await fetch(base + '/storage/v1/bucket', {
    headers: { apikey: secretKey },
    signal: AbortSignal.timeout(12000),
  });
  assert(storage.ok);
  report.supabaseStorageApiReachable = true;
  report.existingBucketCount = ((await storage.json()) as unknown[]).length;
} catch (error) {
  report.error =
    error instanceof Error ? error.message : 'Verification failed.';
  let safe = diagnostics;
  for (const [name, value] of Object.entries(process.env))
    if (value && /KEY|SECRET|PASSWORD|DATABASE_URL|POSTGRES/.test(name))
      safe = safe.split(value).join('[redacted]');
  report.runtimeDiagnostic = safe;
  process.exitCode = 1;
} finally {
  await stop();
  try {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const identities = await client.query<{ id: string }>(
        'SELECT id FROM chatgptee_auth_user WHERE "solanaWallet"=$1 FOR UPDATE',
        [wallet],
      );
      for (const identity of identities.rows) {
        await client.query(
          'DELETE FROM chatgptee_auth_session WHERE "userId"=$1',
          [identity.id],
        );
        await client.query(
          'DELETE FROM chatgptee_auth_account WHERE "userId"=$1 AND "providerId"=$2 AND "accountId"=$3',
          [identity.id, 'solana', wallet],
        );
        await client.query(
          'DELETE FROM solana_dots_users WHERE wallet_address=$1 AND better_auth_user_id=$2',
          [wallet, identity.id],
        );
        await client.query(
          'DELETE FROM chatgptee_auth_user WHERE id=$1 AND "solanaWallet"=$2',
          [identity.id, wallet],
        );
      }
      if (nonce)
        await client.query(
          'DELETE FROM chatgptee_auth_verification WHERE identifier=$1',
          ['clawd-solana:' + nonce],
        );
      await client.query('COMMIT');
      report.fixtureRemoved = true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch {
    report.fixtureRemoved = false;
    process.exitCode = 1;
  }
  await db.close();
  rmSync(directory, { recursive: true, force: true });
  writeFileSync(
    join(artifacts, 'verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report));
}
