import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import { DflowService, atomicAmount } from '../src/server/dflow-service';
import { dflowRoutes } from '../src/server/dflow-routes';
import { displayUnits, percentageBasisPoints } from '../src/shared/dflow-types';

const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const env = {
  DFLOW_API_KEY: 'fixture-server-only-key',
  DFLOW_PUBLIC_SPOT_FEE_SOL: '0.006942',
  DFLOW_PUBLIC_SPOT_SOL_FEE_ACCOUNT: getAssociatedTokenAddressSync(
    NATIVE_MINT,
    new PublicKey(new Uint8Array(32).fill(2)),
    true,
  ).toBase58(),
  DFLOW_PUBLIC_SPOT_FEE_OWNER: new PublicKey(
    new Uint8Array(32).fill(2),
  ).toBase58(),
};
const input = { mint, side: 'buy' as const, amount: '0.1', slippageBps: 50 };
function harness(
  change: (
    order: Record<string, unknown>,
    query: URLSearchParams,
  ) => void = () => {},
) {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const query = new URL(String(url)).searchParams;
    const order: Record<string, unknown> = {
      inputMint: query.get('inputMint'),
      outputMint: query.get('outputMint'),
      inAmount: query.get('amount'),
      outAmount: query.get('outputMint') === mint ? '1000000' : '100000000',
      minOutAmount: query.get('outputMint') === mint ? '995000' : '99500000',
      otherAmountThreshold:
        query.get('outputMint') === mint ? '995000' : '99500000',
      slippageBps: Number(query.get('slippageBps')),
      executionMode: 'sync',
      transaction: 'provider-private-bytes',
      debugSecret: env.DFLOW_API_KEY,
      ...(query.has('platformFeeBps')
        ? {
            platformFee: {
              amount: '6940000',
              feeBps: Number(query.get('platformFeeBps')),
              mode: query.get('platformFeeMode'),
            },
          }
        : {}),
    };
    change(order, query);
    return Response.json(order);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return {
    service: new DflowService(
      env,
      fetcher,
      async () => 6,
      () => 1000,
    ),
    fetcher,
  };
}
describe('server-only DFlow quotes', () => {
  it('uses actual token decimals, sync quotes, verified fees and a strict public result', async () => {
    const { service, fetcher } = harness();
    const quote = await service.quote(input);
    expect(quote).toMatchObject({
      inAmount: '100000000',
      inputDecimals: 9,
      outputDecimals: 6,
      platformFeeBps: 694,
      platformFeeSol: '0.00694',
      executionAvailable: false,
      observedAt: 1000,
      expiresAt: 31000,
    });
    expect(JSON.stringify(quote)).not.toContain(env.DFLOW_API_KEY);
    expect(JSON.stringify(quote)).not.toContain('provider-private-bytes');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetcher.mock.calls) {
      const query = new URL(String(url)).searchParams;
      expect(query.get('userPublicKey')).toBeNull();
      expect(query.get('allowAsyncExec')).toBe('false');
      expect(init.headers['x-api-key']).toBe(env.DFLOW_API_KEY);
      expect(init.redirect).toBe('error');
    }
  });
  it('sells token atomic units and charges SOL output fees', async () => {
    const { service, fetcher } = harness();
    const quote = await service.quote({
      ...input,
      side: 'sell',
      amount: '2.5',
    });
    expect(quote).toMatchObject({
      inAmount: '2500000',
      inputDecimals: 6,
      outputDecimals: 9,
    });
    expect(
      new URL(String(fetcher.mock.calls[1][0])).searchParams.get(
        'platformFeeMode',
      ),
    ).toBe('outputMint');
  });
  it.each([
    'inputMint',
    'outputMint',
    'inAmount',
    'executionMode',
    'slippageBps',
    'minOutAmount',
  ])('rejects provider mismatch in %s', async (field) => {
    const { service } = harness((order) => {
      order[field] = field === 'slippageBps' ? 99 : 'mismatch';
    });
    await expect(service.quote(input)).rejects.toThrow('does not match');
  });
  it('rejects an excessive platform fee', async () => {
    const { service } = harness((order, query) => {
      if (query.has('platformFeeBps'))
        (order.platformFee as { amount: string }).amount = '8000000';
    });
    await expect(service.quote(input)).rejects.toThrow('configured limit');
  });
  it('rejects an amount too small for the configured fee before second provider request', async () => {
    const { service, fetcher } = harness();
    await expect(service.quote({ ...input, amount: '0.01' })).rejects.toThrow(
      'fee limit',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns explicit missing configuration without attempting RPC', async () => {
    const decimals = vi.fn();
    await expect(
      new DflowService({}, vi.fn(), decimals).quote(input),
    ).rejects.toThrow('not configured');
    expect(decimals).not.toHaveBeenCalled();
  });
  it('rejects a fee receiver unrelated to the configured owner', async () => {
    const { fetcher } = harness();
    const service = new DflowService(
      { ...env, DFLOW_PUBLIC_SPOT_SOL_FEE_ACCOUNT: mint },
      fetcher,
      async () => 6,
    );
    await expect(service.quote(input)).rejects.toThrow('fee receiver');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects a non-mainnet RPC before reading token metadata or contacting DFlow', async () => {
    const fetcher = vi.fn(async (_url: unknown, init: { body: string }) => {
      const request = JSON.parse(init.body) as { id: number; method: string };
      expect(request.method).toBe('getGenesisHash');
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result: 'testnet-genesis',
      });
    });
    await expect(
      new DflowService(env, fetcher as unknown as typeof fetch).quote(input),
    ).rejects.toThrow('mainnet RPC');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not forward upstream quota errors or secrets', async () => {
    const service = new DflowService(
      env,
      vi.fn(
        async () => new Response(env.DFLOW_API_KEY, { status: 429 }),
      ) as unknown as typeof fetch,
      async () => 6,
    );
    const response = await dflowRoutes(service).request(
      '/markets/dflow/quote',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    );
    expect(response.status).toBe(429);
    expect(await response.text()).not.toContain(env.DFLOW_API_KEY);
  });
  it('rejects extra wallet/execution arguments', async () => {
    const { service } = harness();
    const response = await dflowRoutes(service).request(
      '/markets/dflow/quote',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, wallet: mint }),
      },
    );
    expect(response.status).toBe(400);
  });
  it('keeps exact atomic arithmetic and display values', () => {
    expect(percentageBasisPoints('0.29')).toBe(29);
    expect(percentageBasisPoints('1.1')).toBe(110);
    expect(() => percentageBasisPoints('1e1')).toThrow('percentage');
    expect(() => percentageBasisPoints('0.001')).toThrow('percentage');
    expect(atomicAmount('1.000000001', 9)).toBe('1000000001');
    expect(displayUnits('1000000001', 9)).toBe('1.000000001');
    expect(displayUnits('10', 0)).toBe('10');
    expect(() => atomicAmount('1.0000001', 6)).toThrow('decimal');
    expect(() => atomicAmount('18446744073709551616', 0)).toThrow('limit');
  });
});
