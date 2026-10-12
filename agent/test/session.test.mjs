import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, verify } from 'node:crypto';
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { formatRequestForAuthorizationSignature } from '@privy-io/node';
import { AgentSession } from '../session.mjs';
function store() {
  let value;
  return {
    setPassword(v) {
      value = v;
    },
    getPassword() {
      return value;
    },
    deletePassword() {
      value = undefined;
    },
  };
}
test('rotates and persists refreshed tokens, clearing the old signing key', async () => {
  const saved = store();
  const session = new AgentSession(
    'test-app',
    async (_url, init) => {
      assert.deepEqual(JSON.parse(init.body), {
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
      });
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 900,
      });
    },
    saved,
  );
  session.save({
    access_token: 'old-access',
    refresh_token: 'old-refresh',
    expires_in: 0,
  });
  session.key = { privateKey: 'old-key' };
  assert.equal(await session.token(), 'new-access');
  assert.equal(session.key, undefined);
  assert.equal(JSON.parse(saved.getPassword()).refresh_token, 'new-refresh');
  session.logout();
  assert.equal(saved.getPassword(), undefined);
});
test('decrypts an HPKE key and signs the exact authorized RPC, rejecting another wallet', async () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const secret = pair.privateKey
    .export({ format: 'der', type: 'pkcs8' })
    .toString('base64');
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Chacha20Poly1305(),
  });
  let operations = 0;
  const session = new AgentSession(
    'test-app',
    async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer fixture-access');
      assert.equal(init.headers['privy-grant-type'], 'device_code');
      const body = JSON.parse(init.body);
      if (url.endsWith('/authenticate')) {
        const publicKey = await crypto.subtle.importKey(
          'spki',
          Buffer.from(body.recipient_public_key, 'base64'),
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          [],
        );
        const sender = await suite.createSenderContext({
          recipientPublicKey: publicKey,
        });
        const ciphertext = await sender.seal(Buffer.from(secret));
        return Response.json({
          encrypted_authorization_key: {
            encapsulated_key: Buffer.from(sender.enc).toString('base64'),
            ciphertext: Buffer.from(ciphertext).toString('base64'),
          },
          expires_at: Date.now() + 900000,
          wallets: [
            {
              id: 'fixture-wallet',
              address: 'fixture-address',
              chain_type: 'solana',
            },
          ],
        });
      }
      operations++;
      const payload = formatRequestForAuthorizationSignature({
        version: 1,
        method: 'POST',
        url,
        body,
        headers: { 'privy-app-id': 'test-app' },
      });
      assert(
        verify(
          'sha256',
          payload,
          pair.publicKey,
          Buffer.from(init.headers['privy-authorization-signature'], 'base64'),
        ),
      );
      return Response.json({
        data: { signature: 'fixture-message-signature' },
      });
    },
    store(),
  );
  session.save({
    access_token: 'fixture-access',
    refresh_token: 'fixture-refresh',
    expires_in: 900,
  });
  assert.equal((await session.authenticate()).privateKey, secret);
  await assert.rejects(
    () => session.rpc('someone-elses-wallet', { method: 'signMessage' }),
    /not available/,
  );
  assert.equal(operations, 0);
  assert.equal(
    (
      await session.rpc('fixture-wallet', {
        method: 'signMessage',
        params: { message: 'hello' },
      })
    ).data.signature,
    'fixture-message-signature',
  );
  assert.equal(operations, 1);
});
