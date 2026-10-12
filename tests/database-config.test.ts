import { X509Certificate } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  databaseUrlFromEnv,
  postgresConnectionOptions,
} from '../src/server/database-config.js';

it('uses an explicit database URL before Supabase integration aliases and never hides invalid configuration', () => {
  expect(
    databaseUrlFromEnv({
      DATABASE_URL: ' postgres://user@primary.invalid/db ',
      POSTGRES_URL_NON_POOLING: 'postgres://user@fallback.invalid/db',
    }),
  ).toBe('postgres://user@primary.invalid/db');
  expect(
    databaseUrlFromEnv({
      DATABASE_URL: ' ',
      POSTGRES_URL_NON_POOLING: 'postgres://user@session.invalid/db',
      POSTGRES_URL: 'postgres://user@transaction.invalid/db',
    }),
  ).toBe('postgres://user@session.invalid/db');
  expect(() =>
    databaseUrlFromEnv({
      DATABASE_URL: 'https://user:private-password@invalid.example',
    }),
  ).toThrow('valid PostgreSQL URL');
  expect(() => databaseUrlFromEnv({})).toThrow('Set DATABASE_URL');
});

it('verifies Supabase TLS with its official CA even when an imported URL requests weaker TLS', () => {
  const options = postgresConnectionOptions(
    'postgres://fixture@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=no-verify&ssl=0&uselibpqcompat=true',
  );
  expect(options.ssl?.rejectUnauthorized).toBe(true);
  const url = new URL(options.connectionString);
  expect(url.searchParams.has('sslmode')).toBe(false);
  expect(url.searchParams.has('ssl')).toBe(false);
  const fingerprints = options.ssl?.ca.map(
    (pem) => new X509Certificate(pem).fingerprint256,
  );
  expect(fingerprints).toContain(
    '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
  );
  expect(
    postgresConnectionOptions(
      'postgres://fixture@db.exampleproject.supabase.co/postgres',
    ).ssl?.rejectUnauthorized,
  ).toBe(true);
});

it('keeps explicit CA files with hostname verification and requires verified TLS on other remote providers', () => {
  for (const host of [
    'aws-0-us-east-1.pooler.supabase.com',
    'postgres.example.com',
  ]) {
    const options = postgresConnectionOptions(
      `postgres://fixture@${host}/db?sslrootcert=/provider/root.crt&sslmode=no-verify`,
    );
    const url = new URL(options.connectionString);
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.get('sslrootcert')).toBe('/provider/root.crt');
    expect(options.ssl).toBeUndefined();
  }
  const local = postgresConnectionOptions('postgres://fixture@127.0.0.1/db');
  expect(new URL(local.connectionString).searchParams.has('sslmode')).toBe(
    false,
  );
  expect(local.ssl).toBeUndefined();
});
