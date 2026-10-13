import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  BirdeyeService,
  birdeyeClosedCandles,
  birdeyeDeduplicateTrades,
} from '../src/server/birdeye-service.js';
import { birdeyeQuerySchema } from '../src/shared/birdeye-types.js';

type Row = Record<string, unknown>;
const mint = new PublicKey(new Uint8Array(32).fill(1)).toBase58();
const wallet = new PublicKey(new Uint8Array(32).fill(2)).toBase58();
const pool = new PublicKey(new Uint8Array(32).fill(3)).toBase58();
const quote = new PublicKey(new Uint8Array(32).fill(4)).toBase58();
const second = new PublicKey(new Uint8Array(32).fill(5)).toBase58();
const nowSeconds = 1_790_000_100;
const env = { BIRDEYE_API_KEY: 'fixture-server-only-secret' };
const cleanSecurity = {
  ownerAddress: null,
  freezeAuthority: null,
  freezeable: null,
  mutableMetadata: false,
  transferFeeEnable: null,
  top10HolderPercent: 0.2,
};
function harness(
  handler: (
    url: URL,
    init: RequestInit,
  ) => unknown | Promise<unknown> = () => ({}),
  now = () => nowSeconds * 1000,
) {
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const result = await handler(new URL(String(input)), init ?? {});
      return result instanceof Response
        ? result
        : Response.json({ success: true, data: result });
    },
  );
  const service = new BirdeyeService({
    env,
    fetchImpl: fetcher as typeof fetch,
    now,
  });
  return { service, fetcher };
}
function asRow(value: unknown): Row {
  return value as Row;
}
function asRows(value: unknown): Row[] {
  return value as Row[];
}
function queryCalls(fetcher: ReturnType<typeof harness>['fetcher']) {
  return fetcher.mock.calls.map(([url]) => new URL(String(url)));
}

describe('Birdeye server reads', () => {
  it('keeps the official origin, server header, URLSearchParams, and credential redaction', async () => {
    const { service, fetcher } = harness(() => ({
      value: 1,
      api_key: env.BIRDEYE_API_KEY,
      detail: `echo ${env.BIRDEYE_API_KEY}`,
    }));
    const result = await service.request(
      '/defi/price',
      new URLSearchParams({ address: mint }),
    );
    expect(queryCalls(fetcher)[0].origin).toBe('https://public-api.birdeye.so');
    expect(queryCalls(fetcher)[0].searchParams.get('address')).toBe(mint);
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: 'error',
      headers: { 'X-API-KEY': env.BIRDEYE_API_KEY, 'x-chain': 'solana' },
    });
    expect(JSON.stringify(result)).not.toContain(env.BIRDEYE_API_KEY);
    expect(JSON.stringify(service.status())).not.toContain(env.BIRDEYE_API_KEY);
    await expect(
      service.request('https://attacker.example/defi/price'),
    ).rejects.toMatchObject({ status: 400, code: 'invalid-input' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports configured access honestly and missing key before requests', async () => {
    const { service } = harness();
    expect(service.status().message).toContain('has not been verified');
    await service.read({ workflow: 'credits' });
    expect(service.status().message).toContain('responded successfully');
    const fetcher = vi.fn();
    const missing = new BirdeyeService({ env: {}, fetchImpl: fetcher });
    await expect(
      missing.read({ workflow: 'portfolio', address: wallet }),
    ).rejects.toMatchObject({ status: 503, code: 'missing-configuration' });
    expect(missing.status()).toMatchObject({
      configured: false,
      state: 'missing-configuration',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [401, 'authentication-error', 503],
    [403, 'tier-unavailable', 403],
    [402, 'quota-limited', 429],
    [429, 'quota-limited', 429],
    [500, 'upstream-unavailable', 502],
  ])('sanitizes upstream HTTP %s', async (httpStatus, code, status) => {
    const { service } = harness(
      () =>
        new Response(`credential:${env.BIRDEYE_API_KEY}`, {
          status: Number(httpStatus),
        }),
    );
    let failure: unknown;
    try {
      await service.request('/defi/price', { address: mint });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code, status });
    expect(String(failure)).not.toContain(env.BIRDEYE_API_KEY);
    expect(service.status().state).not.toBe('ready');
  });
  it('coalesces identical in-flight calls, caches normalized requests, and isolates caller mutations', async () => {
    let release!: (value: unknown) => void;
    const { service, fetcher } = harness(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = service.request('/defi/price', {
      include_liquidity: true,
      address: mint,
    });
    const secondCall = service.request(
      '/defi/price',
      new URLSearchParams({ address: mint, include_liquidity: 'true' }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    release({ value: 2 });
    const [one, two] = await Promise.all([first, secondCall]);
    asRow(one).value = 9;
    expect(asRow(two).value).toBe(2);
    expect(
      await service.request('/defi/price', {
        address: mint,
        include_liquidity: true,
      }),
    ).toMatchObject({ value: 2 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 200])(
    'classifies allowance exhaustion inside HTTP %s and enforces account cooldown',
    async (httpStatus) => {
      let clock = 0;
      const { service, fetcher } = harness(
        () =>
          Response.json(
            {
              success: false,
              code: 'compute_unit_allowance_exhausted',
              message: env.BIRDEYE_API_KEY,
            },
            { status: httpStatus },
          ),
        () => clock,
      );
      await expect(
        service.request('/defi/price', { address: mint }),
      ).rejects.toMatchObject({ status: 429, code: 'quota-limited' });
      await expect(
        service.request('/defi/token_overview', { address: mint }),
      ).rejects.toMatchObject({ code: 'quota-limited' });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(service.status().state).toBe('quota-limited');
      clock = 60_001;
      await expect(
        service.request('/defi/price', { address: mint }),
      ).rejects.toMatchObject({ code: 'quota-limited' });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(service.status())).not.toContain(
        env.BIRDEYE_API_KEY,
      );
    },
  );
  it('caches an endpoint denial without preventing unrelated market reads', async () => {
    const { service, fetcher } = harness((url) =>
      url.pathname === '/token/v1/holder-profile'
        ? new Response(env.BIRDEYE_API_KEY, { status: 403 })
        : { value: 1 },
    );
    await expect(
      service.request('/token/v1/holder-profile', { token_address: mint }),
    ).rejects.toMatchObject({ code: 'tier-unavailable' });
    await expect(
      service.request('/token/v1/holder-profile', { token_address: second }),
    ).rejects.toMatchObject({ code: 'tier-unavailable' });
    await expect(
      service.request('/defi/price', { address: mint }),
    ).resolves.toMatchObject({ value: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(service.status()).toMatchObject({
      state: 'ready',
      lastEndpointFailure: {
        path: '/token/v1/holder-profile',
        code: 'tier-unavailable',
      },
    });
  });
  it('reports cached provider observation separately from the current request time', async () => {
    let clock = 1000;
    const { service, fetcher } = harness(
      () => ({ remaining: { total: 50_000 } }),
      () => clock,
    );
    const first = await service.read({ workflow: 'credits' });
    expect(first).toMatchObject({
      observedAt: 1000,
      fetchedAt: 1000,
      requestedAt: 1000,
      cacheAgeMs: 0,
    });
    clock = 31_000;
    const cached = await service.read({ workflow: 'credits' });
    expect(cached).toMatchObject({
      observedAt: 1000,
      fetchedAt: 1000,
      requestedAt: 31_000,
      cacheAgeMs: 30_000,
    });
    expect(cached.data.checkedAt).toBe(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels one coalesced waiter without cancelling another', async () => {
    let release!: (value: unknown) => void;
    const { service } = harness(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const first = service.request(
      '/defi/price',
      { address: mint },
      undefined,
      controller.signal,
    );
    const secondCall = service.request('/defi/price', { address: mint });
    controller.abort();
    await expect(first).rejects.toMatchObject({
      code: 'cancelled',
      status: 499,
    });
    release({ value: 4 });
    await expect(secondCall).resolves.toMatchObject({ value: 4 });
  });
  it('separates the 5-per-second and 75-per-minute wallet budget from market reads', async () => {
    let clock = 0;
    const { service, fetcher } = harness(
      () => ({}),
      () => clock,
    );
    for (let index = 0; index < 75; index++) {
      clock = Math.floor(index / 5) * 1100;
      await service.request('/wallet/v2/net-worth', { wallet, time: index });
    }
    await expect(
      service.request('/wallet/v2/net-worth', { wallet, time: 76 }),
    ).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(
      service.request('/defi/price', { address: mint }),
    ).resolves.toEqual({});
    clock = 60_001;
    await expect(
      service.request('/wallet/v2/net-worth', { wallet, time: 77 }),
    ).resolves.toEqual({});
    expect(fetcher).toHaveBeenCalledTimes(77);
    const other = harness(
      () => ({}),
      () => 0,
    ).service;
    for (let index = 0; index < 5; index++)
      await other.request('/wallet/v2/net-worth', { wallet, time: index });
    await expect(
      other.request('/wallet/v2/net-worth', { wallet, time: 99 }),
    ).rejects.toMatchObject({ status: 429 });
  });
  it('validates required and bounded fields and rejects signing/execution inputs', async () => {
    expect(
      birdeyeQuerySchema.safeParse({ workflow: 'portfolio' }).success,
    ).toBe(false);
    expect(
      birdeyeQuerySchema.safeParse({
        workflow: 'watchlist',
        addresses: Array(101).fill(mint),
      }).success,
    ).toBe(false);
    expect(
      birdeyeQuerySchema.safeParse({
        workflow: 'chart',
        address: mint,
        timeFrom: 100,
        timeTo: 50,
      }).success,
    ).toBe(false);
    expect(
      birdeyeQuerySchema.safeParse({
        workflow: 'whales',
        address: mint,
        execute: true,
      }).success,
    ).toBe(false);
    const { service, fetcher } = harness();
    await expect(
      service.read({
        workflow: 'chart',
        address: mint,
        interval: '1m',
        timeFrom: 0,
        timeTo: nowSeconds,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('loads three portfolio requests in parallel and normalizes amount, string dollars, nullable PnL, and win rate', async () => {
    const releases: (() => void)[] = [];
    const { service, fetcher } = harness(
      (url) =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve(
              url.pathname.endsWith('current-net-worth')
                ? {
                    total_value: '12.5',
                    items: [
                      {
                        address: mint,
                        amount: 2.5,
                        balance: '2500000',
                        value: '12.5',
                      },
                    ],
                    pagination: { total: 201 },
                  }
                : url.pathname.endsWith('/net-worth')
                  ? {
                      history: [
                        {
                          timestamp: '2026-10-12T00:00:00Z',
                          net_worth: 10,
                          net_worth_change: 2,
                        },
                      ],
                    }
                  : {
                      summary: {
                        pnl: { total_usd: '3' },
                        counts: { win_rate: 0.625 },
                      },
                      tokens: [
                        {
                          address: mint,
                          pnl: {
                            realized_profit_usd: '4',
                            unrealized_usd: '2',
                            total_usd: '6',
                          },
                          pricing: { current_price: null },
                        },
                      ],
                    },
            ),
          );
        }),
    );
    const pending = service.read({ workflow: 'portfolio', address: wallet });
    expect(fetcher).toHaveBeenCalledTimes(3);
    releases.forEach((release) => release());
    const result = await pending;
    expect(result.data).toMatchObject({
      totalValue: 12.5,
      holdings: [
        { amount: 2.5, balance: 2500000, value: 12.5, rawBalance: '2500000' },
      ],
      pnlSummary: { counts: { win_rate: 0.625, winRatePercent: 62.5 } },
      tokenPnl: [{ pnl: { realized_profit_usd: 4, unrealized_usd: null } }],
      pagination: { limit: 100, total: 201, hasMore: true, nextOffset: 100 },
    });
    expect(
      queryCalls(fetcher)
        .find((url) => url.pathname.endsWith('current-net-worth'))
        ?.searchParams.get('limit'),
    ).toBe('100');
    expect(
      queryCalls(fetcher)
        .find((url) => url.pathname.endsWith('/net-worth'))
        ?.searchParams.get('count'),
    ).toBe('30');
    expect(
      result.warnings.some((warning) => warning.includes('more holdings')),
    ).toBe(true);
  });
  it('accepts valid PnL without success and preserves unknown win rate', async () => {
    const { service } = harness((url) =>
      url.pathname.endsWith('pnl/details')
        ? Response.json({
            data: { summary: { counts: { win_rate: null } }, tokens: [] },
          })
        : {},
    );
    const result = await service.read({
      workflow: 'portfolio',
      address: wallet,
    });
    expect(asRow(asRow(result.data.pnlSummary).counts)).toMatchObject({
      win_rate: null,
      winRatePercent: null,
    });
  });
  it('retains current-net-worth pagination supplied outside the provider data envelope', async () => {
    const { service } = harness((url) =>
      url.pathname.endsWith('current-net-worth')
        ? Response.json({
            success: true,
            data: {
              total_value: '10',
              items: [{ address: mint, amount: 1, value: '10' }],
            },
            pagination: { limit: 100, offset: 0, total: 120 },
          })
        : {},
    );
    const result = await service.read({
      workflow: 'portfolio',
      address: wallet,
    });
    expect(result.data.pagination).toMatchObject({
      total: 120,
      hasMore: true,
      nextOffset: 100,
    });
  });
  it('compares wallet-keyed nested pnl/multiple data with exact query names', async () => {
    const { service, fetcher } = harness(() => ({
      data: {
        [wallet]: { pnl: { total_usd: '-3' } },
        [second]: { pnl: { total_usd: '9' } },
      },
    }));
    const result = await service.read({
      workflow: 'pnl-comparison',
      address: mint,
      wallets: [wallet, second],
    });
    expect(asRows(result.data.items).map((item) => item.wallet)).toEqual([
      second,
      wallet,
    ]);
    expect(queryCalls(fetcher)[0].searchParams.get('token_address')).toBe(mint);
    expect(queryCalls(fetcher)[0].searchParams.get('wallets')).toBe(
      `${wallet},${second}`,
    );
  });
  it('searches token groups and requires canonical mint selection even for a single symbol match', async () => {
    const { service, fetcher } = harness(() => ({
      items: [
        {
          type: 'token',
          result: [
            { address: mint, symbol: 'CLAWD', network: 'solana' },
            { address: second, symbol: 'CLAWD', network: 'solana' },
          ],
        },
        { type: 'market', result: [{ address: pool }] },
      ],
    }));
    const result = await service.read({ workflow: 'search', keyword: 'CLAWD' });
    expect(result.data).toMatchObject({
      requiresSelection: true,
      selectedAddress: null,
    });
    expect(asRows(result.data.items)).toHaveLength(2);
    expect(queryCalls(fetcher)[0].searchParams.get('target')).toBe('token');
    const exact = await service.read({ workflow: 'search', keyword: mint });
    expect(exact.data.selectedAddress).toBe(mint);
  });
  it('runs eight independent investigation panels and preserves a package-denied panel', async () => {
    const { service, fetcher } = harness((url) =>
      url.pathname === '/token/v1/holder-profile'
        ? new Response(env.BIRDEYE_API_KEY, { status: 403 })
        : url.pathname === '/defi/token_overview'
          ? {
              holder: 12,
              global_fees_paid: '4.5',
              marketCap: 300,
              v24hUSD: 150,
            }
          : { items: [] },
    );
    const result = await service.read({
      workflow: 'investigation',
      address: mint,
    });
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(result.partial).toBe(true);
    const panels = asRow(result.data.panels);
    expect(panels.behavior).toMatchObject({
      status: 'error',
      code: 'tier-unavailable',
    });
    expect(panels.market).toMatchObject({
      status: 'ready',
      data: { holder: 12, global_fees_paid: 4.5 },
    });
    expect(
      queryCalls(fetcher).find((url) => url.pathname.endsWith('mint-burn-txs'))
        ?.searchParams,
    ).toEqual(expect.any(URLSearchParams));
    expect(JSON.stringify(result)).not.toContain(env.BIRDEYE_API_KEY);
  });
  it('distinguishes nullable controls from omitted authorities and ignores ordinary creation mints', async () => {
    const { service } = harness((url) =>
      url.pathname.endsWith('token_security')
        ? cleanSecurity
        : url.pathname.endsWith('token_creation_info')
          ? { blockUnixTime: nowSeconds - 86400 * 5 }
          : url.pathname.endsWith('token_overview')
            ? { liquidity: 10_000 }
            : url.pathname.endsWith('mint-burn-txs')
              ? {
                  items: [{ type: 'mint', block_time: nowSeconds - 86400 * 5 }],
                }
              : {},
    );
    const result = await service.read({ workflow: 'rug-check', address: mint });
    expect(result.data.gate).toBe('passed');
    expect(
      asRows(result.data.checks).find((check) => check.name === 'freezeable'),
    ).toMatchObject({ state: 'not-applicable' });
    expect(
      asRows(result.data.checks).find(
        (check) => check.name === 'mintAuthority',
      ),
    ).toMatchObject({ state: 'pass', value: null });
    const missing = harness((url) =>
      url.pathname.endsWith('token_security')
        ? {}
        : url.pathname.endsWith('token_overview')
          ? { liquidity: 10_000 }
          : {},
    ).service;
    expect(
      (await missing.read({ workflow: 'rug-check', address: mint })).data.gate,
    ).toBe('unknown');
    const live = harness((url) =>
      url.pathname.endsWith('token_security')
        ? { ...cleanSecurity, ownerAddress: wallet }
        : {},
    ).service;
    expect(
      (await live.read({ workflow: 'rug-check', address: mint })).data.gate,
    ).toBe('rejected');
  });
  it('deduplicates on all three instruction keys and retains unidentified rows', () => {
    expect(
      birdeyeDeduplicateTrades([
        { tx_hash: 'a', ins_index: 1, inner_ins_index: 0 },
        { tx_hash: 'a', ins_index: 1, inner_ins_index: 0 },
        { tx_hash: 'a', ins_index: 1, inner_ins_index: 1 },
        { owner: wallet },
        { owner: wallet },
      ]),
    ).toHaveLength(4);
  });
  it('reports each wash signal, sample concentration, mixed casing churn, and excludes unreliable bundlers', async () => {
    const trades = [
      {
        tx_hash: 'a',
        ins_index: 1,
        inner_ins_index: 0,
        owner: wallet,
        volume_usd: 80,
        block_unix_time: nowSeconds - 10,
      },
      {
        tx_hash: 'b',
        ins_index: 1,
        inner_ins_index: 0,
        owner: second,
        volume_usd: 20,
        block_unix_time: nowSeconds - 5,
      },
    ];
    const { service, fetcher } = harness((url) =>
      url.pathname.endsWith('token_overview')
        ? { liquidity: 100, v24hUSD: 6000, uniqueWallet24h: 1, trade24h: 100 }
        : url.pathname.endsWith('txs-by-volume')
          ? { items: [...trades, trades[0]] }
          : url.pathname.endsWith('top_traders')
            ? {
                items: [
                  {
                    owner: wallet,
                    volumeUsd: '100',
                    volumeBuyUSD: 51,
                    volumeSellUSD: 50,
                  },
                ],
              }
            : url.pathname.endsWith('holder-profile')
              ? {
                  token: { creation_time: Date.UTC(2026, 1, 1) / 1000 },
                  tags: [
                    { tag: 'bundler', percent_of_supply: 80 },
                    { tag: 'sniper', percent_of_supply: 0 },
                  ],
                }
              : {},
    );
    const result = await service.read({
      workflow: 'wash-trading',
      address: mint,
    });
    expect(result.data).toMatchObject({
      score: 3,
      maxScore: 5,
      verdict: 'suspicion-only',
    });
    const signals = asRows(result.data.signals);
    expect(
      asRow(
        signals.find((item) => item.name === 'ownerConcentration')!.evidence,
      ),
    ).toMatchObject({ sampleVolumeUsd: 100, deduplicatedTrades: 2 });
    expect(signals.find((item) => item.name === 'cadence')).toMatchObject({
      flagged: null,
    });
    expect(
      asRow(signals.find((item) => item.name === 'behavior')!.evidence),
    ).toMatchObject({ bundlerReliable: false, bundlerSharePercent: null });
    expect(
      queryCalls(fetcher)
        .find((url) => url.pathname.endsWith('txs-by-volume'))
        ?.searchParams.get('token_address'),
    ).toBe(mint);
  });
  it('normalizes pool ratios in both orientations and confirms only matched consecutive recent USD candles', async () => {
    const lastClosed = Math.floor(nowSeconds / 900) * 900 - 900;
    const candles = [lastClosed - 1800, lastClosed - 900, lastClosed].map(
      (unix_time) => ({ unix_time, c: 10, v: 50, v_usd: 500 }),
    );
    const { service, fetcher } = harness((url, init) => {
      if (url.pathname === '/defi/v2/markets')
        return {
          items: [
            { address: pool, liquidity: 100_000 },
            { address: second, liquidity: 5000 },
          ],
        };
      if (url.pathname === '/defi/price') return { value: 10 };
      if (url.pathname.endsWith('overview/single'))
        return url.searchParams.get('address') === pool
          ? {
              base: { address: mint },
              quote: { address: quote },
              price: 0.055,
              liquidity: 100_000,
              volume_24h: 1000,
            }
          : {
              base: { address: quote },
              quote: { address: mint },
              price: 20,
              liquidity: 5000,
              volume_24h: 200,
            };
      if (url.pathname === '/defi/multi_price') {
        expect(JSON.parse(String(init.body))).toEqual({ list_address: quote });
        return { [quote]: { value: 200 } };
      }
      if (url.pathname === '/defi/v3/ohlcv')
        return {
          items: [
            ...candles,
            { unix_time: lastClosed + 900, c: 20, v: 2, v_usd: 1 },
          ],
        };
      if (url.pathname.endsWith('/ohlcv/pair'))
        return { items: candles.map((candle) => ({ ...candle, c: 11 })) };
      return {};
    });
    const result = await service.read({ workflow: 'cross-dex', address: mint });
    const pools = asRows(result.data.pools);
    expect(pools[0]).toMatchObject({
      priceUsd: 11,
      deviationPercent: expect.closeTo(10),
      confirmed: true,
      volume24hUsd: 1000,
    });
    expect(pools[1]).toMatchObject({
      priceUsd: 10,
      targetInBase: false,
      confirmed: false,
    });
    expect(result.data.weightedPriceUsd).toBeCloseTo(
      (11 * 100_000 + 10 * 5000) / 105_000,
    );
    expect(
      queryCalls(fetcher)
        .find((url) => url.pathname === '/defi/v3/ohlcv')
        ?.searchParams.get('currency'),
    ).toBe('usd');
  });
  it('inverts quote-side candles and does not confirm dust or forming candles', async () => {
    const lastClosed = Math.floor(nowSeconds / 900) * 900 - 900;
    const { service, fetcher } = harness((url) =>
      url.pathname === '/defi/v2/markets'
        ? { items: [{ address: pool, liquidity: 20_000 }] }
        : url.pathname === '/defi/price'
          ? { value: 10 }
          : url.pathname.endsWith('overview/single')
            ? {
                base: { address: quote },
                quote: { address: mint },
                price: 10,
                liquidity: 20_000,
              }
            : url.pathname === '/defi/multi_price'
              ? { [quote]: { value: 200 } }
              : {
                  items: [
                    lastClosed - 1800,
                    lastClosed - 900,
                    lastClosed,
                    lastClosed + 900,
                  ].map((unix_time) => ({
                    unix_time,
                    c: url.pathname.endsWith('/pair') ? 20 : 10,
                    v: 0,
                    v_usd: 0.01,
                  })),
                },
    );
    const result = await service.read({ workflow: 'cross-dex', address: mint });
    expect(asRows(result.data.pools)[0]).toMatchObject({
      priceUsd: 20,
      confirmed: false,
      confirmation: [],
    });
    expect(
      queryCalls(fetcher)
        .find((url) => url.pathname.endsWith('/ohlcv/pair'))
        ?.searchParams.get('inversion'),
    ).toBe('true');
  });
  it('matches liquidity timestamps, identifies a reprice, and only enriches a closed balance drain', async () => {
    const fixture = (drain: boolean) =>
      harness((url) =>
        url.pathname.endsWith('/markets')
          ? { items: [{ address: pool, liquidity: 100_000 }] }
          : url.pathname.endsWith('/liquidity/ohlc/pair')
            ? {
                items: [
                  {
                    unix_time: nowSeconds - 120,
                    open_liquidity_usd: 100,
                    close_liquidity_usd: 50,
                    open_base_balance: 100,
                    close_base_balance: drain ? 50 : 100,
                    open_quote_balance: 100,
                    close_quote_balance: drain ? 50 : 100,
                  },
                ],
                has_more: true,
                prev_cursor: nowSeconds - 180,
              }
            : url.pathname.endsWith('/ohlcv')
              ? {
                  items: [
                    { unix_time: nowSeconds - 120, o: 10, c: 10 },
                    { unix_time: nowSeconds - 60, o: 10, c: 1 },
                  ],
                }
              : {},
      );
    const reprice = fixture(false);
    const calm = await reprice.service.read({
      workflow: 'liquidity',
      address: mint,
    });
    expect(asRows(calm.data.series)[0]).toMatchObject({
      priceClose: 10,
      cause: 'reprice',
      flagged: false,
    });
    expect(calm.data.explanation).toBeUndefined();
    expect(reprice.fetcher).toHaveBeenCalledTimes(3);
    expect(
      queryCalls(reprice.fetcher)
        .find((url) => url.pathname.endsWith('/liquidity/ohlc/pair'))
        ?.searchParams.get('time'),
    ).toBe(String(nowSeconds));
    const drain = fixture(true);
    const flagged = await drain.service.read({
      workflow: 'liquidity',
      address: mint,
    });
    expect(asRows(flagged.data.series)[0]).toMatchObject({
      cause: 'withdrawal',
      flagged: true,
    });
    expect(flagged.data.explanation).toBeDefined();
    expect(drain.fetcher).toHaveBeenCalledTimes(5);
    expect(flagged.data).toMatchObject({
      hasMore: true,
      nextBefore: nowSeconds - 180,
    });
  });
  it('caps trending pagination and pushes screener filters upstream without enrichment', async () => {
    const { service, fetcher } = harness(() => ({ items: [] }));
    await service.read({ workflow: 'trending', limit: 100, offset: 50 });
    expect(queryCalls(fetcher)[0].searchParams.get('limit')).toBe('50');
    expect(queryCalls(fetcher)[0].searchParams.get('offset')).toBe('50');
    await service.read({
      workflow: 'screener',
      minLiquidity: 20_000,
      minHolders: 100,
      minVolume: 80_000,
      offset: 100,
    });
    const url = queryCalls(fetcher)[1];
    expect(url.pathname).toBe('/defi/v3/token/list');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      min_liquidity: '20000',
      min_holder: '100',
      min_volume_24h_usd: '80000',
      offset: '100',
      sort_by: 'volume_24h_change_percent',
      sort_type: 'desc',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('shows discovery survivors only after complete risk gating and bounds enrichment', async () => {
    const { service } = harness((url) =>
      url.pathname.endsWith('/new_listing')
        ? { items: [{ address: mint }, { address: second }] }
        : url.pathname.endsWith('token_security')
          ? url.searchParams.get('address') === mint
            ? cleanSecurity
            : { ...cleanSecurity, ownerAddress: wallet }
          : url.pathname.endsWith('token_overview')
            ? { liquidity: 10_000, priceChange1hPercent: 25 }
            : {},
    );
    const result = await service.read({ workflow: 'new-listings', limit: 20 });
    expect(asRows(result.data.survivors)).toHaveLength(1);
    expect(asRows(result.data.survivors)[0]).toMatchObject({
      address: mint,
      gate: 'passed',
      momentumPercent: 25,
    });
    expect(
      asRows(result.data.items).find((item) => item.address === second),
    ).toMatchObject({ gate: 'rejected', market: null });
    expect(result.warnings.some((warning) => warning.includes('five'))).toBe(
      true,
    );
  });
  it('uses the live listing liquidityAddedAt timestamp for discovery cursors and time filters', async () => {
    const { service, fetcher } = harness((url) =>
      url.pathname.endsWith('/new_listing')
        ? {
            items: [
              {
                address: mint,
                liquidityAddedAt: new Date(
                  (nowSeconds - 60) * 1000,
                ).toISOString(),
              },
              {
                address: second,
                liquidityAddedAt: new Date(
                  (nowSeconds - 300) * 1000,
                ).toISOString(),
              },
            ],
          }
        : url.pathname.endsWith('token_security')
          ? cleanSecurity
          : url.pathname.endsWith('token_overview')
            ? { liquidity: 10_000 }
            : {},
    );
    const result = await service.read({
      workflow: 'new-listings',
      timeFrom: nowSeconds - 120,
    });
    expect(result.data.latestBlockTime).toBe(nowSeconds - 60);
    expect(asRows(result.data.items)).toHaveLength(1);
    expect(asRows(result.data.items)[0].discoveredAt).toBe(nowSeconds - 60);
    expect(
      queryCalls(fetcher).filter((url) =>
        url.pathname.endsWith('token_security'),
      ),
    ).toHaveLength(1);
  });
  it('normalizes live smart-money token fields into selectable canonical addresses', async () => {
    const { service } = harness(() => ({
      items: [{ token: mint, volume_buy_usd: 100, volume_sell_usd: 10 }],
    }));
    const result = await service.read({ workflow: 'smart-money' });
    expect(asRows(result.data.items)[0]).toMatchObject({
      address: mint,
      token: mint,
    });
  });
  it('uses one POST multi-price call with explicit unavailable and stale prices', async () => {
    const { service, fetcher } = harness(() => ({
      [mint]: { value: 1.5, updateUnixTime: nowSeconds - 400 },
      [second]: null,
    }));
    const result = await service.read({
      workflow: 'watchlist',
      addresses: [mint, second, mint],
    });
    expect(asRows(result.data.items)).toMatchObject([
      { address: mint, priceUsd: 1.5, stale: true },
      { address: second, priceUsd: null, unavailable: true },
    ]);
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      list_address: `${mint},${second}`,
    });
  });
  it('normalizes actual v3 trade from/to legs, USD volume and pool ownership without raw-token-as-USD fallback', async () => {
    const trade = {
      tx_hash: 'trade',
      ins_index: 1,
      inner_ins_index: 0,
      owner: wallet,
      pool_id: pool,
      to: { address: mint },
      from: { address: quote },
      volume_usd: '25000',
      volume: 99_000_000,
    };
    const { service } = harness(() => ({
      items: [
        trade,
        trade,
        {
          ...trade,
          tx_hash: 'sell',
          to: { address: quote },
          from: { address: mint },
          volume_usd: 5000,
        },
        {
          tx_hash: 'no-usd',
          ins_index: 1,
          inner_ins_index: 0,
          volume: 80_000_000,
        },
      ],
    }));
    const result = await service.read({ workflow: 'whales', address: mint });
    expect(result.data).toMatchObject({
      buyVolumeUsd: 25000,
      sellVolumeUsd: 5000,
    });
    expect(asRows(result.data.items)[0]).toMatchObject({
      wallet,
      pool,
      side: 'buy',
      volumeUsd: 25000,
    });
    expect(asRows(result.data.items)[2].volumeUsd).toBeNull();
  });
  it('scores selected smart wallets using all-time cumulative PnL and retains provider win-rate denominator', async () => {
    const { service, fetcher } = harness((url) =>
      url.pathname.endsWith('/pnl/details')
        ? {
            summary: {
              counts: { win_rate: 0.4 },
              pnl: { realized_profit_percent: 15 },
            },
            tokens: [],
          }
        : { items: [] },
    );
    const result = await service.read({
      workflow: 'smart-money',
      wallets: [wallet],
    });
    const calls = fetcher.mock.calls.filter(([url]) =>
      String(url).includes('/pnl/details'),
    );
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      wallet,
      duration: 'all',
      position_scope: 'cumulative',
      limit: 100,
    });
    expect(asRow(result.data.trackRecords)[wallet]).toMatchObject({
      status: 'ready',
      data: {
        summary: {
          counts: { win_rate: 0.4, winRatePercent: 40 },
          pnl: { realized_profit_percent: 15 },
        },
      },
    });
  });
  it('returns wallet owner separately from pool, legs, cumulative PnL and integer history bounds', async () => {
    const { service, fetcher } = harness(
      (url) =>
        url.pathname.endsWith('seek_by_time')
          ? {
              items: [
                {
                  owner: wallet,
                  address: pool,
                  blockUnixTime: nowSeconds - 1,
                  base: { address: mint, type_swap: 'to' },
                  quote: { address: quote, type_swap: 'from' },
                },
              ],
            }
          : { summary: {} },
      () => nowSeconds * 1000 + 567,
    );
    const result = await service.read({
      workflow: 'wallet-history',
      address: wallet,
    });
    expect(asRows(result.data.items)[0]).toMatchObject({
      wallet,
      pool,
      base: { direction: 'entry' },
      quote: { direction: 'exit' },
    });
    expect(queryCalls(fetcher)[0].searchParams.get('after_time')).toMatch(
      /^\d+$/,
    );
    expect(result.data).toMatchObject({
      nextBefore: nowSeconds - 1,
      pnlScope: 'all-time cumulative',
    });
  });
  it('reads remaining total REST/WebSocket credits and caches the balance hourly', async () => {
    const { service, fetcher } = harness(() => ({
      remaining: { total: 9000, api: 7000, ws: 2000 },
      usage: { api: 30, ws: 10 },
    }));
    const result = await service.read({ workflow: 'credits' });
    expect(result.data).toMatchObject({
      remaining: 9000,
      low: true,
      raw: { remaining: { api: 7000, ws: 2000 } },
    });
    expect(service.status().credits).toMatchObject({
      remaining: 9000,
      low: true,
    });
    await service.read({ workflow: 'credits' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses only candles closed at the actual boundary and rejects forming bars', () => {
    const cutoff = Math.floor(nowSeconds / 900) * 900;
    expect(
      birdeyeClosedCandles(
        {
          items: [
            { unix_time: cutoff - 900, c: 1 },
            { unix_time: cutoff, c: 2 },
          ],
        },
        '15m',
        nowSeconds,
      ),
    ).toEqual([{ unix_time: cutoff - 900, c: 1 }]);
  });
});
