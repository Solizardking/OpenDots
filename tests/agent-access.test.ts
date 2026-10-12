import { describe, expect, it, vi } from 'vitest';
import type { PrivyAuth } from '../src/server/privy-auth.js';
import {
  paymentDestination,
  agentAccessRoutes,
} from '../src/server/agent-access.js';
import {
  usdcBaseUnits,
  samePaymentOffer,
  isUsdcPaymentOffer,
} from '../src/shared/x402-payment.js';

describe('agent payment boundaries', () => {
  it('rejects alternate hosts, credentials, private addresses and insecure URLs', () => {
    for (const url of [
      'http://pro-api.coingecko.com/x',
      'https://pro-api.coingecko.com.evil.test/x',
      'https://user:pass@pro-api.coingecko.com/x',
      'http://127.0.0.1/',
      'https://api.allium.so@127.0.0.1/',
    ])
      expect(() => paymentDestination(url)).toThrow();
    expect(
      paymentDestination(
        'https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=solana',
      ).hostname,
    ).toBe('pro-api.coingecko.com');
  });
  it('converts exact USDC decimals without floating point and bounds the payment', () => {
    expect(usdcBaseUnits('0.000001')).toBe(1n);
    expect(usdcBaseUnits('0.1')).toBe(100000n);
    expect(usdcBaseUnits('1.000000')).toBe(1000000n);
    for (const input of [
      '0',
      '-1',
      '1.000001',
      '0.0000001',
      '1e-6',
      'NaN',
      '999',
    ])
      expect(() => usdcBaseUnits(input)).toThrow();
  });
  it('invalidates a reviewed offer when the recipient, token, network or amount changes', () => {
    const offer = {
      scheme: 'exact',
      network: 'base',
      asset: 'USDC',
      payTo: 'recipient',
      maxAmountRequired: '100000',
      resource: 'https://api.example/resource',
    };
    expect(samePaymentOffer(offer, { ...offer })).toBe(true);
    for (const key of [
      'payTo',
      'asset',
      'network',
      'maxAmountRequired',
      'resource',
    ] as const)
      expect(samePaymentOffer(offer, { ...offer, [key]: 'changed' })).toBe(
        false,
      );
  });
  it('only permits positive exact USDC offers on supported networks', () => {
    const offer = {
      scheme: 'exact',
      network: 'solana',
      asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      payTo: 'recipient',
      maxAmountRequired: '100000',
      resource: 'https://api.example/resource',
    };
    expect(isUsdcPaymentOffer(offer)).toBe(true);
    for (const change of [
      { asset: 'another-token' },
      { network: 'unknown' },
      { scheme: 'upto' },
      { maxAmountRequired: '0' },
      { maxAmountRequired: '1e6' },
    ])
      expect(isUsdcPaymentOffer({ ...offer, ...change })).toBe(false);
  });
  it('keeps paid resources closed without a valid Privy session', async () => {
    const app = agentAccessRoutes(undefined);
    expect(
      (await app.request('/resource?url=https://api.allium.so')).status,
    ).toBe(401);
    const config = await (await app.request('/config')).json();
    expect(JSON.stringify(config)).not.toContain('wallet-auth:');
    expect((await app.request('/wallets', { method: 'POST' })).status).toBe(
      401,
    );
  });
  it('assigns wallet ownership to the verified user and reuses that user wallet', async () => {
    const subject = 'did:privy:temporarytest';
    const identity = {
      config: { appId: 'app-test', appSecret: 'secret-test' },
      verifyAccessToken: vi.fn().mockResolvedValue(subject),
    } as unknown as PrivyAuth;
    const calls: { url: string; body: Record<string, unknown> | null }[] = [];
    let created = false;
    const request = vi.fn(async (...[url, init]: Parameters<typeof fetch>) => {
      calls.push({
        url: String(url),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (init?.method === 'POST') created = true;
      return Response.json(
        created
          ? { id: 'wallet-test', address: 'address-test', chain_type: 'solana' }
          : { error: 'not found' },
        { status: created ? 200 : 404 },
      );
    }) as unknown as typeof fetch;
    const app = agentAccessRoutes(identity, request);
    const create = () =>
      app.request('/wallets', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chain_type: 'solana',
          owner: { user_id: 'did:privy:attacker' },
          additional_signers: [{ signer_id: 'attacker' }],
        }),
      });
    const first = await create();
    const second = await create();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({
      wallet: {
        id: 'wallet-test',
        address: 'address-test',
        chain_type: 'solana',
      },
    });
    const bodies = calls.flatMap((call) => (call.body ? [call.body] : []));
    expect(bodies).toHaveLength(1);
    expect(bodies[0].owner).toEqual({ user_id: subject });
    expect(bodies[0].additional_signers).toBeUndefined();
    expect(bodies[0].external_id).toMatch(/^chatgptee-agent-[a-f0-9]{40}$/);
    expect(identity.verifyAccessToken).toHaveBeenCalledWith('valid-test');
  });
  it('rejects invalid sessions and chains before calling the wallet provider', async () => {
    const request = vi.fn() as unknown as typeof fetch;
    const identity = {
      config: { appId: 'app-test', appSecret: 'secret-test' },
      verifyAccessToken: vi.fn().mockRejectedValue(new Error('expired')),
    } as unknown as PrivyAuth;
    const app = agentAccessRoutes(identity, request);
    expect(
      (
        await app.request('/wallets', {
          method: 'POST',
          headers: { Authorization: 'Bearer expired' },
        })
      ).status,
    ).toBe(401);
    vi.mocked(identity.verifyAccessToken).mockResolvedValue(
      'did:privy:temporarytest',
    );
    expect(
      (
        await app.request('/wallets', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer valid-test',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ chain_type: 'unknown' }),
        })
      ).status,
    ).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });
});
