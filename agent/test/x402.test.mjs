import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { privateKeyToAccount } from 'viem/accounts';

for (const scenario of ['over-limit', 'wrong-asset', 'allowed']) {
  test(`x402 CLI ${scenario}: validates payment before signing`, async () => {
    const appId = 'chatgptee-test-' + randomUUID();
    const entry = new Entry('ai.chatgptee.agent', appId);
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    const account = privateKeyToAccount('0x' + randomBytes(32).toString('hex'));
    const suite = new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
    const originalFetch = globalThis.fetch,
      originalArgs = process.argv,
      originalAppId = process.env.PRIVY_APP_ID;
    let signatures = 0,
      paidRetries = 0;
    entry.setPassword(
      JSON.stringify({
        access_token: 'test-access',
        refresh_token: 'test-refresh',
        expiresAt: Date.now() + 900000,
      }),
    );
    process.env.PRIVY_APP_ID = appId;
    process.argv = [
      process.execPath,
      'cli.mjs',
      'fetch',
      'https://fixture.example/resource',
      '--wallet',
      'fixture-wallet',
      '--max-usdc',
      '0.1',
    ];
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/wallets/authenticate')) {
        const request = JSON.parse(init.body);
        const publicKey = await crypto.subtle.importKey(
          'spki',
          Buffer.from(request.recipient_public_key, 'base64'),
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          [],
        );
        const sender = await suite.createSenderContext({
          recipientPublicKey: publicKey,
        });
        const encrypted = await sender.seal(Buffer.from(key));
        return Response.json({
          encrypted_authorization_key: {
            encapsulated_key: Buffer.from(sender.enc).toString('base64'),
            ciphertext: Buffer.from(encrypted).toString('base64'),
          },
          expires_at: new Date(Date.now() + 900000).toISOString(),
          wallets: [
            {
              id: 'fixture-wallet',
              address: account.address,
              chain_type: 'ethereum',
            },
          ],
        });
      }
      if (url.endsWith('/rpc')) {
        signatures++;
        const body = JSON.parse(init.body);
        assert.equal(body.method, 'eth_signTypedData_v4');
        const { primary_type, ...typed } = body.params.typed_data;
        return Response.json({
          data: {
            signature: await account.signTypedData({
              ...typed,
              primaryType: primary_type,
            }),
          },
        });
      }
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      );
      if (headers.has('PAYMENT-SIGNATURE')) {
        paidRetries++;
        return Response.json({ fixture: true, settledOnchain: false });
      }
      const requirements = {
        x402Version: 2,
        resource: {
          url,
          description: 'Synthetic protocol verification',
          mimeType: 'application/json',
        },
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:8453',
            asset:
              scenario === 'wrong-asset'
                ? '0x0000000000000000000000000000000000000001'
                : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            amount: scenario === 'over-limit' ? '100001' : '10000',
            payTo: '0x0000000000000000000000000000000000000002',
            maxTimeoutSeconds: 60,
            extra: { name: 'USD Coin', version: '2' },
          },
        ],
      };
      return Response.json(
        {},
        {
          status: 402,
          headers: {
            'PAYMENT-REQUIRED': Buffer.from(
              JSON.stringify(requirements),
            ).toString('base64'),
          },
        },
      );
    };
    try {
      await import('../cli.mjs?verification=' + randomUUID());
      if (scenario === 'allowed') {
        assert.equal(signatures, 1);
        assert.equal(paidRetries, 1);
        assert.notEqual(process.exitCode, 1);
      } else {
        assert.equal(signatures, 0);
        assert.equal(paidRetries, 0);
        assert.equal(process.exitCode, 1);
      }
    } finally {
      globalThis.fetch = originalFetch;
      process.argv = originalArgs;
      if (originalAppId === undefined) delete process.env.PRIVY_APP_ID;
      else process.env.PRIVY_APP_ID = originalAppId;
      process.exitCode = 0;
      entry.deletePassword();
    }
  });
}
