import bs58 from 'bs58';

const ORIGIN = 'https://public-api.birdeye.so';
export const BIRDEYE_MEME_ENDPOINT = '/defi/v3/token/meme/detail/single';
const TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 100;
const MAX_INFLIGHT = 4;
const MAX_REQUESTS_PER_MINUTE = 60;

export class BirdeyeMemeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'provider-error',
  ) {
    super(message);
    this.name = 'BirdeyeMemeError';
  }
}

export interface BirdeyeMemeResult {
  source: 'Birdeye';
  transport: 'rest';
  endpoint: typeof BIRDEYE_MEME_ENDPOINT;
  chain: 'solana';
  observedAt: number;
  data: unknown;
}

const cancelled = () =>
  new BirdeyeMemeError(499, 'Birdeye research was cancelled.', 'cancelled');

function requireActive(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}

function requireAddress(address: string) {
  if (
    typeof address !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
  ) {
    throw new BirdeyeMemeError(
      400,
      'Enter a valid Solana token mint.',
      'invalid-address',
    );
  }
  try {
    if (bs58.decode(address).length === 32) return;
  } catch {
    // Validation errors never include user-supplied text.
  }
  throw new BirdeyeMemeError(
    400,
    'Enter a valid Solana token mint.',
    'invalid-address',
  );
}

function providerError(status: number, payload: unknown) {
  // Inspect provider diagnostics to classify known failures, but never return
  // their text: upstream errors can include a credential or credentialed URL.
  const diagnostic = JSON.stringify(payload)?.toLowerCase() ?? '';
  if (diagnostic.includes('compute_unit_allowance_exhausted')) {
    return new BirdeyeMemeError(
      status,
      'Birdeye compute unit allowance is exhausted. Replenish credits or wait for the allowance to reset.',
      'compute_unit_allowance_exhausted',
    );
  }
  if (/quota|credit.{0,20}(exhaust|insufficient)/.test(diagnostic)) {
    return new BirdeyeMemeError(
      status,
      'Birdeye credits are unavailable. Check the account allowance before retrying.',
      'quota-exhausted',
    );
  }
  if (status === 429 || /rate.?limit|too many requests/.test(diagnostic)) {
    return new BirdeyeMemeError(
      status,
      'Birdeye rate limit reached. Wait before requesting more research.',
      'rate-limited',
    );
  }
  if (
    /plan|package|subscription|not permitted|permission|upgrade|premium|business|enterprise/.test(
      diagnostic,
    )
  ) {
    return new BirdeyeMemeError(
      status,
      'This Birdeye endpoint is unavailable on the current plan. Check API entitlements.',
      'plan-unavailable',
    );
  }
  if (
    status === 401 ||
    /invalid.{0,15}(key|token)|unauthoriz/.test(diagnostic)
  ) {
    return new BirdeyeMemeError(
      status,
      'Birdeye authentication failed. Check the server API key.',
      'authentication-error',
    );
  }
  return new BirdeyeMemeError(
    status,
    'Birdeye could not return meme token details. Check the token and API access.',
  );
}

async function readJson(response: Response): Promise<unknown> {
  const size = response.headers.get('content-length');
  if (size && Number(size) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new BirdeyeMemeError(
      502,
      'Birdeye returned too much data.',
      'response-too-large',
    );
  }
  if (!response.body) {
    throw new BirdeyeMemeError(
      502,
      'Birdeye returned an empty response.',
      'invalid-response',
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new BirdeyeMemeError(
          502,
          'Birdeye could not finish returning token details.',
          'unavailable',
        );
      }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BirdeyeMemeError(
          502,
          'Birdeye returned too much data.',
          'response-too-large',
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text);
    } catch {
      throw new BirdeyeMemeError(
        response.ok ? 502 : response.status,
        'Birdeye returned an unreadable response.',
        'invalid-response',
      );
    }
  } finally {
    reader.releaseLock();
  }
}

/** One server credential, one fixed read-only REST endpoint. */
export function createBirdeyeMemeService(
  options: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
) {
  const key = (options.env ?? process.env).BIRDEYE_API_KEY?.trim() ?? '';
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, BirdeyeMemeResult>();
  const inflight = new Map<string, Promise<BirdeyeMemeResult>>();
  let requestTimes: number[] = [];

  async function request(address: string): Promise<BirdeyeMemeResult> {
    const controller = new AbortController();
    let rejectTimeout!: (error: BirdeyeMemeError) => void;
    const timeout = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(
        new BirdeyeMemeError(
          504,
          'Birdeye research timed out. Try again later.',
          'timeout',
        ),
      );
    }, TIMEOUT_MS);
    timer.unref?.();
    const operation = async (): Promise<BirdeyeMemeResult> => {
      const url = new URL(BIRDEYE_MEME_ENDPOINT, ORIGIN);
      url.searchParams.set('address', address);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-API-KEY': key,
            'x-chain': 'solana',
          },
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        throw new BirdeyeMemeError(
          502,
          'Birdeye research is temporarily unavailable. Try again later.',
          'unavailable',
        );
      }
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new BirdeyeMemeError(
          502,
          'Birdeye redirected this research request.',
          'redirect-rejected',
        );
      }
      const payload = await readJson(response);
      const object =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : undefined;
      if (!response.ok || object?.success === false) {
        throw providerError(response.ok ? 502 : response.status, payload);
      }
      // The documented envelope requires an explicit successful provider read.
      if (object?.success !== true || !Object.hasOwn(object, 'data')) {
        throw new BirdeyeMemeError(
          502,
          'Birdeye returned an incomplete response.',
          'invalid-response',
        );
      }
      return {
        source: 'Birdeye',
        transport: 'rest',
        endpoint: BIRDEYE_MEME_ENDPOINT,
        chain: 'solana',
        observedAt: now(),
        data: object.data,
      };
    };
    try {
      return await Promise.race([operation(), timeout]);
    } catch (error) {
      if (error instanceof BirdeyeMemeError) throw error;
      throw new BirdeyeMemeError(
        502,
        'Birdeye research is temporarily unavailable. Try again later.',
        'unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForCaller(
    pending: Promise<BirdeyeMemeResult>,
    signal?: AbortSignal,
  ) {
    requireActive(signal);
    let onAbort: (() => void) | undefined;
    try {
      const result = signal
        ? await Promise.race([
            pending,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(cancelled());
              signal.addEventListener('abort', onAbort, { once: true });
              if (signal.aborted) onAbort();
            }),
          ])
        : await pending;
      requireActive(signal);
      return structuredClone(result);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    status() {
      return {
        configured: Boolean(key),
        source: 'Birdeye' as const,
        transport: 'rest' as const,
        chain: 'solana' as const,
        endpoint: BIRDEYE_MEME_ENDPOINT,
      };
    },
    async read(address: string, signal?: AbortSignal) {
      requireActive(signal);
      requireAddress(address);
      if (!key) {
        throw new BirdeyeMemeError(
          503,
          'Birdeye is not configured on this server.',
          'missing-configuration',
        );
      }
      const observedAt = now();
      const cached = cache.get(address);
      if (
        cached &&
        observedAt >= cached.observedAt &&
        observedAt - cached.observedAt < CACHE_MS
      ) {
        return waitForCaller(Promise.resolve(cached), signal);
      }
      cache.delete(address);
      const existing = inflight.get(address);
      if (existing) return waitForCaller(existing, signal);
      if (inflight.size >= MAX_INFLIGHT) {
        throw new BirdeyeMemeError(
          429,
          'Birdeye research is busy. Wait for the current requests to finish.',
          'concurrency-limit',
        );
      }
      requestTimes = requestTimes.filter((time) => observedAt - time < 60_000);
      if (requestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
        throw new BirdeyeMemeError(
          429,
          'Birdeye research reached its local request budget. Wait before requesting more details.',
          'request-budget',
        );
      }
      requestTimes.push(observedAt);
      // Callers cancel their own wait only. A coalesced caller cannot cancel
      // another caller's provider read, and every provider read has a timeout.
      const pending = request(address)
        .then((result) => {
          if (cache.size >= MAX_CACHE_ENTRIES) {
            cache.delete(cache.keys().next().value!);
          }
          cache.set(address, result);
          return result;
        })
        .finally(() => inflight.delete(address));
      inflight.set(address, pending);
      return waitForCaller(pending, signal);
    },
  };
}

export type BirdeyeMemeService = ReturnType<typeof createBirdeyeMemeService>;
