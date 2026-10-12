import { createPrivateKey, createHash } from 'node:crypto';
import { Hono } from 'hono';
import type { PrivyAuth } from './privy-auth.js';

// A fixed provider list keeps paid fetches away from the server's private network.
export const paymentOrigins = [
  'https://pro-api.coingecko.com',
  'https://api.allium.so',
  'https://agents.allium.so',
];
export function paymentDestination(input: string) {
  const url = new URL(input);
  if (url.username || url.password || !paymentOrigins.includes(url.origin))
    throw new Error('Choose a supported CoinGecko or Allium HTTPS API.');
  return url;
}
export function agentAccessRoutes(
  privy: PrivyAuth | undefined,
  request: typeof fetch = fetch,
) {
  const app = new Hono();
  const authorizationUrl =
    process.env.PRIVY_AUTH_URL ?? 'https://chatgptee.ai/authorize';
  if (new URL(authorizationUrl).pathname !== '/authorize')
    throw new Error('PRIVY_AUTH_URL must point to /authorize.');
  const signingKey = process.env.PRIVY_SIGNING_KEY;
  if (signingKey) {
    const key = createPrivateKey({
      key: Buffer.from(signingKey.replace(/^wallet-auth:/, ''), 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
      throw new Error('PRIVY_SIGNING_KEY must be a P-256 authorization key.');
  }
  app.get('/config', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({
      appId: privy?.config.appId,
      clientId: privy?.config.clientId,
      authorizationUrl,
      oauthOrigin: 'https://auth.privy.io',
      serverSigningConfigured: !!signingKey,
      paymentOrigins,
      maxPaymentBaseUnits: '1000000',
    });
  });
  app.post('/wallets', async (c) => {
    c.header('Cache-Control', 'no-store');
    const credential = c.req
      .header('authorization')
      ?.match(/^Bearer (.+)$/)?.[1];
    if (!privy || !credential)
      return c.json({ error: 'Sign in with Privy.' }, 401);
    let subject: string;
    try {
      subject = await privy.verifyAccessToken(credential);
    } catch {
      return c.json(
        { error: 'Your Privy session expired. Sign in again.' },
        401,
      );
    }
    const body = await c.req.json().catch(() => null);
    if (!body || !['solana', 'ethereum'].includes(body.chain_type))
      return c.json({ error: 'Choose Solana or Ethereum.' }, 400);
    const externalId =
      'chatgptee-agent-' +
      createHash('sha256')
        .update(subject + ':' + body.chain_type)
        .digest('hex')
        .slice(0, 40);
    const headers = {
      'privy-app-id': privy.config.appId,
      Authorization: `Basic ${Buffer.from(`${privy.config.appId}:${privy.config.appSecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    const existing = await request(
      'https://api.privy.io/v1/wallets/ext_wal_' + externalId,
      { headers, signal: AbortSignal.timeout(20000) },
    );
    if (!existing.ok && existing.status !== 404)
      return c.json(
        {
          error: `Privy could not read your agent wallet (${existing.status}).`,
        },
        502,
      );
    const response = existing.ok
      ? existing
      : await request('https://api.privy.io/v1/wallets', {
          method: 'POST',
          headers: { ...headers, 'privy-idempotency-key': externalId },
          body: JSON.stringify({
            chain_type: body.chain_type,
            owner: { user_id: subject },
            external_id: externalId,
          }),
          signal: AbortSignal.timeout(20000),
        });
    if (!response.ok)
      return c.json(
        {
          error: `Privy could not create your agent wallet (${response.status}).`,
        },
        502,
      );
    const wallet = await response.json();
    return c.json({
      wallet: {
        id: wallet.id,
        address: wallet.address,
        chain_type: wallet.chain_type,
      },
    });
  });
  app.get('/resource', async (c) => {
    c.header('Cache-Control', 'no-store');
    const credential = c.req
      .header('authorization')
      ?.match(/^Bearer (.+)$/)?.[1];
    if (!privy || !credential)
      return c.json({ error: 'Sign in with Privy.' }, 401);
    try {
      await privy.verifyAccessToken(credential);
    } catch {
      return c.json(
        { error: 'Your Privy session expired. Sign in again.' },
        401,
      );
    }
    let url: URL;
    try {
      url = paymentDestination(c.req.query('url') ?? '');
    } catch {
      return c.json(
        { error: 'Choose a supported CoinGecko or Allium HTTPS API.' },
        400,
      );
    }
    const headers = new Headers({ Accept: 'application/json' });
    for (const name of ['x-payment', 'payment-signature']) {
      const value = c.req.header(name);
      if (value && value.length <= 65536) headers.set(name, value);
    }
    const response = await fetch(url, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return c.json(
        { error: 'Use the final API URL; redirects are blocked.' },
        400,
      );
    }
    const outputHeaders = new Headers({
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    });
    for (const name of [
      'x-payment-response',
      'payment-required',
      'payment-response',
    ]) {
      const value = response.headers.get(name);
      if (value) outputHeaders.set(name, value);
    }
    // Provider responses are streamed; tokens, cookies, and the signing key are never forwarded.
    return new Response(response.body, {
      status: response.status,
      headers: outputHeaders,
    });
  });
  return app;
}
