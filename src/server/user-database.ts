import { Pool } from 'pg';
import { postgresConnectionOptions } from './database-config.js';
import type { SignInChallenge, SolanaUser } from '../shared/auth-types.js';
export class IdentityConflict extends Error {}

const USER_AUTH_TABLES = [
  'solana_dots_users',
  'solana_dots_auth_challenges',
  'solana_dots_sessions',
] as const;
const BETTER_AUTH_TABLES = [
  'chatgptee_auth_user',
  'chatgptee_auth_account',
  'chatgptee_auth_session',
  'chatgptee_auth_verification',
  'chatgptee_auth_rate_limit',
] as const;

function privateAuthTablesSql(
  tables: readonly (
    (typeof USER_AUTH_TABLES)[number] | (typeof BETTER_AUTH_TABLES)[number]
  )[],
) {
  // These fixed application tables are accessed by the server's owning role.
  // Supabase's public API roles must never read session or identity records.
  // Do not force RLS: the table owner must retain backend access without policies.
  return `DO $private_auth_tables$
  DECLARE
    private_table text;
    browser_role text;
  BEGIN
    FOREACH private_table IN ARRAY ARRAY[${tables.map((table) => `'${table}'`).join(', ')}]
    LOOP
      IF to_regclass(format('public.%I', private_table)) IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', private_table);
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC', private_table);
        FOREACH browser_role IN ARRAY ARRAY['anon', 'authenticated']
        LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = browser_role) THEN
            EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I', private_table, browser_role);
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END
  $private_auth_tables$;`;
}

export const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS solana_dots_users (
  id uuid PRIMARY KEY,
  wallet_address varchar(44) NOT NULL UNIQUE,
  display_name varchar(80),
  privy_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE solana_dots_users ADD COLUMN IF NOT EXISTS privy_user_id text;
ALTER TABLE solana_dots_users ALTER COLUMN wallet_address DROP NOT NULL;
ALTER TABLE solana_dots_users ADD COLUMN IF NOT EXISTS better_auth_user_id text;
CREATE UNIQUE INDEX IF NOT EXISTS solana_dots_better_auth_user ON solana_dots_users(better_auth_user_id);
CREATE TABLE IF NOT EXISTS solana_dots_auth_challenges (
  id uuid PRIMARY KEY,
  binding_hash char(64) NOT NULL,
  origin text NOT NULL,
  input jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS solana_dots_challenges_expiry ON solana_dots_auth_challenges(expires_at);
CREATE TABLE IF NOT EXISTS solana_dots_sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES solana_dots_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS solana_dots_sessions_expiry ON solana_dots_sessions(expires_at);
`;

export interface UserDatabase {
  createChallenge(
    challenge: SignInChallenge,
    bindingHash: string,
    origin: string,
    expires: Date,
  ): Promise<void>;
  consumeChallenge(
    id: string,
    bindingHash: string,
    origin: string,
    now: Date,
  ): Promise<SignInChallenge['input'] | undefined>;
  createSession(
    address: string,
    hash: string,
    expires: Date,
    privyUserId?: string,
  ): Promise<SolanaUser>;
  session(hash: string, now: Date): Promise<SolanaUser | undefined>;
  revokeSession(hash: string): Promise<void>;
}
type UserRow = {
  id: string;
  wallet_address: string | null;
  better_auth_user_id?: string | null;
  display_name: string | null;
  created_at: Date;
  last_login_at: Date;
};
const user = (row: UserRow): SolanaUser => ({
  id: row.id,
  walletAddress: row.wallet_address,
  displayName: row.display_name,
  createdAt: row.created_at.toISOString(),
  lastLoginAt: row.last_login_at.toISOString(),
});

export class PostgresUserDatabase implements UserDatabase {
  readonly pool: Pool;
  constructor(connectionString: string) {
    // Verify TLS certificates and keep credentials exclusively on the server.
    this.pool = new Pool({
      ...postgresConnectionOptions(connectionString),
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      enableChannelBinding: true,
    });
    this.pool.on('error', () =>
      console.error('User database connection interrupted.'),
    );
  }
  async initialize() {
    // A single simple-query batch commits creation and protection together.
    await this.pool.query(USER_SCHEMA + privateAuthTablesSql(USER_AUTH_TABLES));
    await this.pool.query(
      'DELETE FROM solana_dots_auth_challenges WHERE expires_at <= now()',
    );
    await this.pool.query(
      'DELETE FROM solana_dots_sessions WHERE expires_at <= now()',
    );
  }
  async protectBetterAuthTables() {
    // Missing tables are expected before Better Auth's first migration.
    await this.pool.query(privateAuthTablesSql(BETTER_AUTH_TABLES));
  }
  async createChallenge(
    challenge: SignInChallenge,
    bindingHash: string,
    origin: string,
    expires: Date,
  ) {
    // Bound pending challenges for a browser without trusting proxy IP headers.
    await this.pool.query(
      'DELETE FROM solana_dots_auth_challenges WHERE expires_at <= now()',
    );
    await this.pool.query(
      'INSERT INTO solana_dots_auth_challenges(id,binding_hash,origin,input,expires_at) VALUES($1,$2,$3,$4,$5)',
      [challenge.id, bindingHash, origin, challenge.input, expires],
    );
  }
  async consumeChallenge(
    id: string,
    bindingHash: string,
    origin: string,
    now: Date,
  ) {
    // DELETE RETURNING makes one-time consumption atomic across server instances.
    const result = await this.pool.query(
      'DELETE FROM solana_dots_auth_challenges WHERE id=$1 AND binding_hash=$2 AND origin=$3 AND expires_at>$4 RETURNING input',
      [id, bindingHash, origin, now],
    );
    return result.rows[0]?.input as SignInChallenge['input'] | undefined;
  }
  async createSession(
    address: string,
    hash: string,
    expires: Date,
    privyUserId?: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<UserRow>(
        'INSERT INTO solana_dots_users(id,wallet_address,privy_user_id) VALUES(gen_random_uuid(),$1,$2) ON CONFLICT(wallet_address) DO UPDATE SET last_login_at=now(),privy_user_id=COALESCE(EXCLUDED.privy_user_id,solana_dots_users.privy_user_id) RETURNING *',
        [address, privyUserId ?? null],
      );
      await client.query(
        'INSERT INTO solana_dots_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',
        [hash, result.rows[0].id, expires],
      );
      await client.query('COMMIT');
      return user(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async session(hash: string, now: Date) {
    const result = await this.pool.query<UserRow>(
      'SELECT u.* FROM solana_dots_sessions s JOIN solana_dots_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',
      [hash, now],
    );
    return result.rows[0] ? user(result.rows[0]) : undefined;
  }
  async revokeSession(hash: string) {
    await this.pool.query(
      'DELETE FROM solana_dots_sessions WHERE token_hash=$1',
      [hash],
    );
  }
  async walletIdentity(address: string) {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM solana_dots_users WHERE wallet_address=$1',
      [address],
    );
    return result.rows[0];
  }
  async mappedIdentity(id: string) {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM solana_dots_users WHERE better_auth_user_id=$1',
      [id],
    );
    return result.rows[0] ? user(result.rows[0]) : undefined;
  }
  async resolveIdentity(identity: {
    id: string;
    name?: string;
    solanaWallet?: string | null;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize wallet claims and preserve each existing workspace UUID.
      if (identity.solanaWallet)
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          ['wallet:' + identity.solanaWallet],
        );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        ['better-auth:' + identity.id],
      );
      const byId = (
        await client.query<UserRow>(
          'SELECT * FROM solana_dots_users WHERE better_auth_user_id=$1 FOR UPDATE',
          [identity.id],
        )
      ).rows[0];
      const byWallet = identity.solanaWallet
        ? (
            await client.query<UserRow>(
              'SELECT * FROM solana_dots_users WHERE wallet_address=$1 FOR UPDATE',
              [identity.solanaWallet],
            )
          ).rows[0]
        : undefined;
      if (
        (byId && byWallet && byId.id !== byWallet.id) ||
        (byWallet?.better_auth_user_id &&
          byWallet.better_auth_user_id !== identity.id) ||
        (byId?.wallet_address &&
          identity.solanaWallet &&
          byId.wallet_address !== identity.solanaWallet)
      )
        throw new IdentityConflict(
          'This wallet has a different workspace. Sign in with that wallet, then link your social account from its account settings.',
        );
      const existing = byId ?? byWallet;
      const result = existing
        ? await client.query<UserRow>(
            'UPDATE solana_dots_users SET better_auth_user_id=$2,wallet_address=COALESCE(wallet_address,$3),last_login_at=now() WHERE id=$1 RETURNING *',
            [existing.id, identity.id, identity.solanaWallet ?? null],
          )
        : await client.query<UserRow>(
            'INSERT INTO solana_dots_users(id,better_auth_user_id,wallet_address,display_name) VALUES(gen_random_uuid(),$1,$2,$3) RETURNING *',
            [
              identity.id,
              identity.solanaWallet ?? null,
              identity.name?.slice(0, 80) ?? null,
            ],
          );
      await client.query('COMMIT');
      return user(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async users() {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM solana_dots_users',
    );
    return result.rows.map(user);
  }
  async byId(id: string) {
    const result = await this.pool.query<UserRow>(
      'SELECT * FROM solana_dots_users WHERE id = $1',
      [id],
    );
    return result.rows[0] ? user(result.rows[0]) : undefined;
  }
  async close() {
    await this.pool.end();
  }
}
