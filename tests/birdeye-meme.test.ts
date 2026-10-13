import bs58 from 'bs58';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BIRDEYE_MEME_ENDPOINT,
  BirdeyeMemeError,
  createBirdeyeMemeService,
} from '../src/server/birdeye-meme.js';

const MINT = 'HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump';
const FIXTURE_KEY = 'fixture-only-birdeye-key';
const env = { BIRDEYE_API_KEY: FIXTURE_KEY };
const mint = (index: number) => {
  const bytes = new Uint8Array(32);
  bytes[0] = 1;
  bytes[30] = Math.floor(index / 256);
  bytes[31] = index % 256;
  return bs58.encode(bytes);
};
const success = (data: unknown = { address: MINT }) =>
  Response.json({ success: true, data });

function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe('Birdeye meme details', () => {
  it('uses only the exact authenticated Solana GET endpoint and preserves all provider data', async () => {
    const payload = {
      address: MINT,
      price: null,
      liquidity: 12.34,
      tags: ['pump'],
      providerExtension: { unknown: null, count: 2 },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success(payload));
    const service = createBirdeyeMemeService({
      env,
      fetchImpl,
      now: () => 1234,
    });

    expect(await service.read(MINT)).toEqual({
      source: 'Birdeye',
      transport: 'rest',
      endpoint: BIRDEYE_MEME_ENDPOINT,
      chain: 'solana',
      observedAt: 1234,
      data: payload,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      `https://public-api.birdeye.so${BIRDEYE_MEME_ENDPOINT}?address=${MINT}`,
    );
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get('X-API-KEY')).toBe(FIXTURE_KEY);
    expect(new Headers(init?.headers).get('x-chain')).toBe('solana');
    expect(new Headers(init?.headers).get('Authorization')).toBeNull();
    expect(String(url)).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(service.status())).not.toContain(FIXTURE_KEY);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports configuration without making a request and preserves an untracked null result', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success(null));
    const missing = createBirdeyeMemeService({ env: {}, fetchImpl });
    expect(missing.status()).toMatchObject({
      configured: false,
      source: 'Birdeye',
      chain: 'solana',
    });
    await expect(missing.read(MINT)).rejects.toMatchObject({
      status: 503,
      code: 'missing-configuration',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const service = createBirdeyeMemeService({ env, fetchImpl });
    expect(service.status().configured).toBe(true);
    expect((await service.read(MINT)).data).toBeNull();
  });

  it('rejects malformed, non-32-byte and URL-injected mints before calling the provider', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const service = createBirdeyeMemeService({ env, fetchImpl });
    for (const address of [
      'SOL',
      '0'.repeat(44),
      bs58.encode(new Uint8Array(31).fill(1)),
      bs58.encode(new Uint8Array(33).fill(1)),
      `${MINT}&x-chain=ethereum`,
      `https://example.com/${MINT}`,
    ]) {
      await expect(service.read(address)).rejects.toMatchObject({
        status: 400,
        code: 'invalid-address',
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('coalesces market reads, isolates returned data, and preserves freshness until cache expiry', async () => {
    let time = 1000;
    const response = deferred<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(response.promise);
    const service = createBirdeyeMemeService({
      env,
      fetchImpl,
      now: () => time,
    });
    const first = service.read(MINT);
    const second = service.read(MINT);
    expect(fetchImpl).toHaveBeenCalledOnce();
    response.resolve(success({ details: { label: 'original' } }));
    const [a, b] = await Promise.all([first, second]);
    (a.data as { details: { label: string } }).details.label = 'changed';
    expect(b.data).toEqual({ details: { label: 'original' } });
    time += 29_999;
    expect((await service.read(MINT)).observedAt).toBe(1000);
    expect((await service.read(MINT)).data).toEqual({
      details: { label: 'original' },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    time++;
    fetchImpl.mockResolvedValueOnce(success({ newer: true }));
    expect((await service.read(MINT)).observedAt).toBe(time);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('cancels one coalesced caller without interrupting another caller', async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const service = createBirdeyeMemeService({ env, fetchImpl });
    const controller = new AbortController();
    const first = service.read(MINT, controller.signal);
    const second = service.read(MINT);
    controller.abort(new Error(`sensitive abort reason ${FIXTURE_KEY}`));
    await expect(first).rejects.toMatchObject({
      status: 499,
      code: 'cancelled',
      message: 'Birdeye research was cancelled.',
    });
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
    response.resolve(success({ valid: true }));
    await expect(second).resolves.toMatchObject({ data: { valid: true } });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('honors cancellation before a request, during response completion, and on a cached result', async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(response.promise);
    const service = createBirdeyeMemeService({ env, fetchImpl });
    const aborted = new AbortController();
    aborted.abort();
    await expect(service.read(MINT, aborted.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    const controller = new AbortController();
    const cancelledRead = service.read(MINT, controller.signal);
    const healthyRead = service.read(MINT);
    response.resolve(success());
    controller.abort();
    await expect(cancelledRead).rejects.toMatchObject({ code: 'cancelled' });
    await healthyRead;
    await expect(service.read(MINT, aborted.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    const cachedController = new AbortController();
    const cachedRead = service.read(MINT, cachedController.signal);
    cachedController.abort();
    await expect(cachedRead).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('preserves quota HTTP status, exposes safe actionable errors, and never caches failures or retries them', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            message: `compute_unit_allowance_exhausted key=${FIXTURE_KEY}`,
          },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(success({ recovered: true }));
    const service = createBirdeyeMemeService({ env, fetchImpl });
    const error = await service.read(MINT).catch((failure) => failure);
    expect(error).toBeInstanceOf(BirdeyeMemeError);
    expect(error).toMatchObject({
      status: 400,
      code: 'compute_unit_allowance_exhausted',
    });
    expect(error.message).toContain('Replenish credits');
    expect(error.message).not.toContain(FIXTURE_KEY);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await service.read(MINT)).data).toEqual({ recovered: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      403,
      { success: false, message: 'Plan upgrade required' },
      'plan-unavailable',
    ],
    [
      401,
      { success: false, message: 'Invalid API key' },
      'authentication-error',
    ],
    [429, { success: false, message: 'Slow down' }, 'rate-limited'],
    [200, { success: false, message: 'provider failure' }, 'provider-error'],
    [200, { data: null }, 'invalid-response'],
  ])(
    'rejects HTTP %s or incomplete provider envelopes (%s)',
    async (httpStatus, payload, code) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(payload, { status: httpStatus }));
      const service = createBirdeyeMemeService({ env, fetchImpl });
      await expect(service.read(MINT)).rejects.toMatchObject({
        status: httpStatus === 200 ? 502 : httpStatus,
        code,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('sanitizes arbitrary fetch exceptions and unreadable provider error bodies', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`network URL api-key=${FIXTURE_KEY}`))
      .mockResolvedValueOnce(
        new Response(`failed key=${FIXTURE_KEY}`, { status: 403 }),
      );
    const service = createBirdeyeMemeService({ env, fetchImpl });
    for (const status of [502, 403]) {
      const error = await service.read(MINT).catch((failure) => failure);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain(FIXTURE_KEY);
      expect(error.message).not.toContain('api-key=');
    }
  });

  it('sanitizes errors from fetch wrappers and interrupted provider response streams', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error(`stream failure key=${FIXTURE_KEY}`));
      },
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        new BirdeyeMemeError(502, `wrapper failure key=${FIXTURE_KEY}`),
      )
      .mockResolvedValueOnce(new Response(body));
    const service = createBirdeyeMemeService({ env, fetchImpl });
    for (let index = 0; index < 2; index++) {
      const error = await service.read(MINT).catch((failure) => failure);
      expect(error).toMatchObject({ status: 502, code: 'unavailable' });
      expect(error.message).not.toContain(FIXTURE_KEY);
    }
  });

  it('rejects redirects without following a different origin', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/receive-credentials' },
      }),
    );
    const service = createBirdeyeMemeService({ env, fetchImpl });
    await expect(service.read(MINT)).rejects.toMatchObject({
      status: 502,
      code: 'redirect-rejected',
    });
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('error');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('caps response bytes on streamed data even when content-length is absent', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body));
    const service = createBirdeyeMemeService({ env, fetchImpl });
    await expect(service.read(MINT)).rejects.toMatchObject({
      status: 502,
      code: 'response-too-large',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('times out a stalled provider read, aborts it, and releases the in-flight slot', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockReturnValue(new Promise(() => {}));
    const service = createBirdeyeMemeService({ env, fetchImpl });
    const pending = service.read(MINT);
    const rejection = expect(pending).rejects.toMatchObject({
      status: 504,
      code: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await rejection;
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    fetchImpl.mockResolvedValueOnce(success());
    await expect(service.read(MINT)).resolves.toMatchObject({
      data: { address: MINT },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds distinct in-flight reads while allowing same-token coalescing', async () => {
    const response = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      await response.promise;
      return success();
    });
    const service = createBirdeyeMemeService({ env, fetchImpl });
    const active = Array.from({ length: 4 }, (_, index) =>
      service.read(mint(index)),
    );
    const shared = service.read(mint(0));
    await expect(service.read(mint(4))).rejects.toMatchObject({
      status: 429,
      code: 'concurrency-limit',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    response.resolve(success());
    await Promise.all([...active, shared]);
    await service.read(mint(4));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('enforces a minute request budget, excludes cache hits, and permits reads after it resets', async () => {
    let time = 1000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => success());
    const service = createBirdeyeMemeService({
      env,
      fetchImpl,
      now: () => time,
    });
    for (let index = 0; index < 60; index++) await service.read(mint(index));
    await service.read(mint(0));
    expect(fetchImpl).toHaveBeenCalledTimes(60);
    await expect(service.read(mint(60))).rejects.toMatchObject({
      status: 429,
      code: 'request-budget',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(60);
    time += 60_000;
    await service.read(mint(60));
    expect(fetchImpl).toHaveBeenCalledTimes(61);
  });
});
