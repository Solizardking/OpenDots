import { Hono } from 'hono';
import bs58 from 'bs58';
import { z } from 'zod';
import { BirdeyeMcpError } from './birdeye-mcp.js';
import { BirdeyeMemeError } from './birdeye-meme.js';
import type { Platform } from './platform.js';

const threadSchema = z.string().trim().min(1).max(128);
const catalogSchema = z
  .object({
    threadId: threadSchema,
    search: z.string().trim().max(100).optional(),
  })
  .strict();
const statusSchema = z.object({ threadId: threadSchema }).strict();
const addressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  .refine((value) => {
    try {
      return bs58.decode(value).length === 32;
    } catch {
      return false;
    }
  });
const memeSchema = z
  .object({ threadId: threadSchema, address: addressSchema })
  .strict();
const prohibitedArgument =
  /^(authorization|headers|api[_-]?key|x-api-key|private[_-]?key|secret|seed|access[_-]?token|url|endpoint|base[_-]?url)$/i;
const validArguments = (value: unknown, depth = 0): boolean => {
  if (depth > 12) return false;
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, item]) =>
      !prohibitedArgument.test(key) && validArguments(item, depth + 1),
  );
};
const callSchema = z
  .object({
    threadId: threadSchema,
    name: z.string().trim().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).refine((value) => {
      try {
        return (
          Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16_000 &&
          validArguments(value)
        );
      } catch {
        return false;
      }
    }),
  })
  .strict();

type ErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 408
  | 409
  | 413
  | 422
  | 429
  | 500
  | 502
  | 503
  | 504;

class RouteError extends Error {
  constructor(
    readonly status: ErrorStatus,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const providerCodes = new Set([
  'invalid-query',
  'invalid-address',
  'invalid-tool',
  'invalid-arguments',
  'invalid-input',
  'invalid-catalog',
  'unknown-tool',
  'read-only',
  'read-only-required',
  'tool-unavailable',
  'missing-configuration',
  'authentication-error',
  'permission-denied',
  'plan-unavailable',
  'tier-unavailable',
  'compute_unit_allowance_exhausted',
  'quota-exhausted',
  'quota-limited',
  'rate-limited',
  'request-budget',
  'concurrency-limit',
  'cancelled',
  'provider-error',
  'protocol-error',
  'mcp-unavailable',
  'session-unavailable',
  'response-too-large',
  'invalid-response',
  'redirect-rejected',
  'timeout',
  'unavailable',
]);

const providerMessages: Partial<Record<ErrorStatus, string>> = {
  400: 'Choose a valid Birdeye request.',
  401: 'Birdeye authentication failed. Check the server API key.',
  402: 'The Birdeye account has exhausted its credits or allowance.',
  403: 'This Birdeye request is unavailable under the account permissions or plan.',
  404: 'This Birdeye tool or resource is unavailable.',
  408: 'Birdeye did not respond in time. Try again.',
  409: 'This Birdeye request cannot run in the current connection state.',
  413: 'The Birdeye request or response is too large.',
  422: 'Birdeye could not accept the requested parameters.',
  429: 'The Birdeye request limit was reached. Try again later.',
  504: 'Birdeye did not respond in time. Try again.',
};
const providerStatuses = new Set<number>([
  400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504,
]);
const codeMessages: Record<string, string> = {
  cancelled: 'The Birdeye request was cancelled.',
  'read-only-required':
    'Only read-only Birdeye tools can run in this workspace.',
  compute_unit_allowance_exhausted:
    'Birdeye compute unit allowance is exhausted. Check the provider account before retrying.',
  'quota-exhausted':
    'Birdeye credits are unavailable. Check the provider account before retrying.',
  'quota-limited':
    'Birdeye quota or credits are unavailable. Check the provider account before retrying.',
  'session-unavailable':
    'Birdeye MCP session verification is temporarily unavailable. Retry later.',
  'response-too-large': 'The Birdeye response is too large.',
};

/** Mounted inside the app's existing owner, origin and body-size boundary. */
export function birdeyeMcpRoutes(platform: Platform) {
  const app = new Hono();
  const scope = (threadId: string) => {
    if (!platform.birdeyeAllowed(threadId))
      throw new RouteError(
        403,
        'Research is paused, disabled, or this conversation is outside your workspace.',
        'research-disabled',
      );
  };
  const active = (signal: AbortSignal) => {
    if (signal.aborted)
      throw new RouteError(
        408,
        'The Birdeye request was cancelled.',
        'cancelled',
      );
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new RouteError(
        400,
        'Select a conversation and use valid Birdeye request parameters.',
        'invalid-query',
      );
    return parsed.data;
  };
  const query = (values: Record<string, string[]>) => {
    if (Object.values(values).some((entries) => entries.length !== 1))
      throw new RouteError(
        400,
        'Use each Birdeye query parameter once.',
        'invalid-query',
      );
    return Object.fromEntries(
      Object.entries(values).map(([name, entries]) => [name, entries[0]]),
    );
  };

  app.onError((error, c) => {
    if (c.req.raw.signal.aborted)
      return c.json(
        {
          source: 'Birdeye',
          error: 'The Birdeye request was cancelled.',
          code: 'cancelled',
        },
        408,
      );
    if (error instanceof RouteError)
      return c.json(
        { source: 'Birdeye', error: error.message, code: error.code },
        error.status,
      );
    if (error instanceof BirdeyeMcpError || error instanceof BirdeyeMemeError) {
      const status = (
        error.status === 499
          ? 408
          : providerStatuses.has(error.status)
            ? error.status
            : 502
      ) as ErrorStatus;
      const code = providerCodes.has(error.code) ? error.code : 'unavailable';
      return c.json(
        {
          source: 'Birdeye',
          error:
            code === 'missing-configuration'
              ? 'Configure the server Birdeye connection before requesting data.'
              : (codeMessages[code] ??
                providerMessages[status] ??
                'Birdeye data is temporarily unavailable.'),
          code,
        },
        status,
      );
    }
    return c.json(
      {
        source: 'Birdeye',
        error: 'Birdeye data is temporarily unavailable.',
        code: 'unavailable',
      },
      502,
    );
  });

  app.get('/birdeye/mcp/status', (c) => {
    const input = parse(statusSchema, query(c.req.queries()));
    scope(input.threadId);
    return c.json(
      platform.config.birdeyeMcp?.status() ?? {
        source: 'Birdeye',
        configured: false,
        transport: 'streamable-http',
      },
    );
  });

  app.get('/birdeye/mcp/catalog', async (c) => {
    const input = parse(catalogSchema, query(c.req.queries()));
    scope(input.threadId);
    active(c.req.raw.signal);
    const service = platform.config.birdeyeMcp;
    if (!service)
      throw new RouteError(
        503,
        'Configure the server Birdeye connection before requesting data.',
        'missing-configuration',
      );
    const result = await service.catalog(input.search, c.req.raw.signal);
    scope(input.threadId);
    active(c.req.raw.signal);
    return c.json(result);
  });

  app.post('/birdeye/mcp/call', async (c) => {
    const input = parse(callSchema, await c.req.json().catch(() => null));
    scope(input.threadId);
    active(c.req.raw.signal);
    const service = platform.config.birdeyeMcp;
    if (!service)
      throw new RouteError(
        503,
        'Configure the server Birdeye connection before requesting data.',
        'missing-configuration',
      );
    const result = await service.call(
      input.name,
      input.arguments,
      c.req.raw.signal,
    );
    scope(input.threadId);
    active(c.req.raw.signal);
    return c.json(result);
  });

  app.get('/birdeye/meme-detail', async (c) => {
    const input = parse(memeSchema, query(c.req.queries()));
    scope(input.threadId);
    active(c.req.raw.signal);
    const service = platform.config.birdeyeMeme;
    if (!service)
      throw new RouteError(
        503,
        'Configure the server Birdeye connection before requesting data.',
        'missing-configuration',
      );
    const result = await service.read(input.address, c.req.raw.signal);
    scope(input.threadId);
    active(c.req.raw.signal);
    return c.json(result);
  });

  return app;
}
