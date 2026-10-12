import { expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { PrivyAuth } from '../src/server/privy-auth.js';

it('verifies Privy audience, issuer, expiry, signature, and linked Solana ownership', async () => {
  const keys = await generateKeyPair('ES256');
  const publicKey = await exportJWK(keys.publicKey);
  const jwks = createLocalJWKSet({
    keys: [{ ...publicKey, kid: 'fixture', alg: 'ES256' }],
  });
  const address = 'fixture-solana-wallet';
  const request = (async () =>
    new Response(
      JSON.stringify({
        id: 'did:privy:fixture',
        linked_accounts: [{ type: 'wallet', chain_type: 'solana', address }],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch;
  const privy = new PrivyAuth(
    { appId: 'fixture-app', appSecret: 'fixture-secret' },
    request,
    jwks,
  );
  const token = async (
    audience = 'fixture-app',
    issuer = 'privy.io',
    expiry = '1h',
  ) =>
    new SignJWT({ sid: 'fixture-session' })
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture' })
      .setSubject('did:privy:fixture')
      .setIssuedAt()
      .setExpirationTime(expiry)
      .setAudience(audience)
      .setIssuer(issuer)
      .sign(keys.privateKey);
  await expect(privy.verify(await token(), address)).resolves.toBe(
    'did:privy:fixture',
  );
  await expect(privy.verifyIdentity(await token())).resolves.toEqual({
    subject: 'did:privy:fixture',
    displayName: undefined,
  });
  await expect(
    privy.verify(await token('other-app'), address),
  ).rejects.toThrow();
  await expect(
    privy.verify(await token('fixture-app', 'other-issuer'), address),
  ).rejects.toThrow();
  await expect(
    privy.verify(await token('fixture-app', 'privy.io', '-1h'), address),
  ).rejects.toThrow();
  await expect(privy.verify(await token(), 'other-wallet')).rejects.toThrow();
  await expect(
    privy.verify((await token()).slice(0, -6) + 'forged', address),
  ).rejects.toThrow();
  await expect(
    privy.verifyIdentity(await token('other-app')),
  ).rejects.toThrow();
  await expect(
    privy.verifyIdentity((await token()).slice(0, -6) + 'forged'),
  ).rejects.toThrow();
});

it('accepts a verified social identity without a wallet and rejects a mismatched user record', async () => {
  const keys = await generateKeyPair('ES256');
  const key = await exportJWK(keys.publicKey);
  const token = await new SignJWT({ sid: 'social-session' })
    .setProtectedHeader({ alg: 'ES256', kid: 'social' })
    .setSubject('did:privy:social')
    .setIssuer('privy.io')
    .setAudience('social-app')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(keys.privateKey);
  let subject = 'did:privy:social';
  const privy = new PrivyAuth(
    { appId: 'social-app', appSecret: 'fixture' },
    (async () =>
      Response.json({
        id: subject,
        linked_accounts: [{ type: 'google_oauth', name: 'Social user' }],
      })) as typeof fetch,
    createLocalJWKSet({ keys: [{ ...key, kid: 'social', alg: 'ES256' }] }),
  );
  await expect(privy.verifyIdentity(token)).resolves.toEqual({
    subject,
    displayName: 'Social user',
  });
  await expect(privy.verify(token, 'unlinked-wallet')).rejects.toThrow();
  subject = 'did:privy:another-user';
  await expect(privy.verifyIdentity(token)).rejects.toThrow();
});
