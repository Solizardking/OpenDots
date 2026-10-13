import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const BIRDEYE_MCP_ENDPOINT = 'https://mcp.birdeye.so/mcp';
const MAX_BYTES = 2_000_000;
const prohibited =
  /^(authorization|headers|api[_-]?key|x-api-key|private[_-]?key|secret|seed|access[_-]?token|url|endpoint|base[_-]?url)$/i;

export class BirdeyeMcpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'mcp-unavailable',
  ) {
    super(message);
  }
}

function readOnly(tool: Tool) {
  if (tool.annotations?.destructiveHint === true) return false;
  // Beta catalog entries without read-only metadata remain unavailable.
  // Discovery is still allowed, so a changed catalog never grants new actions.
  return tool.annotations?.readOnlyHint === true;
}

function validateArguments(value: unknown, depth = 0): void {
  if (depth > 12)
    throw new BirdeyeMcpError(
      400,
      'Choose a smaller tool input.',
      'invalid-input',
    );
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (prohibited.test(key))
      throw new BirdeyeMcpError(
        400,
        'Provider credentials, headers and destinations are configured by the server.',
        'invalid-input',
      );
    validateArguments(item, depth + 1);
  }
}

function callerResult<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One fixed authenticated provider; callers cannot supply URLs or credentials. */
export class BirdeyeMcpService {
  #apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private catalogValue?: { tools: Tool[]; observedAt: number };
  private catalogPending?: Promise<{ tools: Tool[]; observedAt: number }>;
  private active = 0;
  private budget = { until: 0, count: 0 };
  private lastError?: { status: number; code: string; message: string };
  private verifiedAt?: number;

  constructor({
    env = process.env,
    fetchImpl = fetch,
    now = Date.now,
  }: {
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {}) {
    this.#apiKey = env.BIRDEYE_API_KEY?.trim() || undefined;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  status() {
    return {
      source: 'Birdeye' as const,
      transport: 'mcp' as const,
      endpoint: BIRDEYE_MCP_ENDPOINT,
      beta: true,
      configured: !!this.#apiKey,
      state: this.lastError
        ? 'unavailable'
        : this.verifiedAt
          ? 'available'
          : 'not-checked',
      ...(this.verifiedAt ? { verifiedAt: this.verifiedAt } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private safe<T>(value: T): T {
    const serialized = JSON.stringify(value, (key, item) => {
      if (prohibited.test(key)) return undefined;
      return typeof item === 'string' && this.#apiKey
        ? item.split(this.#apiKey).join('[redacted]')
        : item;
    });
    if (!serialized || Buffer.byteLength(serialized) > MAX_BYTES)
      throw new BirdeyeMcpError(
        502,
        'Birdeye MCP returned too much data.',
        'response-too-large',
      );
    return JSON.parse(serialized) as T;
  }

  private failure(error: unknown): BirdeyeMcpError {
    if (error instanceof BirdeyeMcpError) return error;
    const message = error instanceof Error ? error.message : '';
    if (/redis|session verification/i.test(message))
      return new BirdeyeMcpError(
        503,
        'Birdeye MCP session verification is temporarily unavailable. Retry later.',
        'session-unavailable',
      );
    if (/429|quota|credits|allowance/i.test(message))
      return new BirdeyeMcpError(
        429,
        'Birdeye MCP quota or credits are unavailable. Check the provider account before retrying.',
        'quota-limited',
      );
    if (/401|unauthorized|authentication/i.test(message))
      return new BirdeyeMcpError(
        401,
        'Birdeye MCP could not authorize the server connection.',
        'authentication-error',
      );
    if (/403|permission|plan|entitlement/i.test(message))
      return new BirdeyeMcpError(
        403,
        'This Birdeye MCP tool is unavailable under the account plan or permissions.',
        'tier-unavailable',
      );
    return new BirdeyeMcpError(
      502,
      'Birdeye MCP is temporarily unavailable.',
      'mcp-unavailable',
    );
  }

  private async withClient<T>(
    operation: (client: Client, signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    caller?.throwIfAborted();
    if (!this.#apiKey)
      throw new BirdeyeMcpError(
        503,
        'Add the server Birdeye connection before using MCP.',
        'missing-configuration',
      );
    if (this.active >= 4)
      throw new BirdeyeMcpError(
        429,
        'Birdeye MCP requests are busy. Retry shortly.',
        'rate-limited',
      );
    if (this.budget.until <= this.now())
      this.budget = { until: this.now() + 60_000, count: 0 };
    if (this.budget.count >= 30)
      throw new BirdeyeMcpError(
        429,
        'Birdeye MCP request limit reached. Retry shortly.',
        'rate-limited',
      );
    this.budget.count++;
    this.active++;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15_000);
    const signal = caller
      ? AbortSignal.any([caller, controller.signal])
      : controller.signal;
    const client = new Client({ name: 'opendots-birdeye', version: '0.2.3' });
    const boundedFetch: typeof fetch = async (input, init) => {
      const response = await this.fetchImpl(input, {
        ...init,
        signal,
        redirect: 'error',
      });
      const reader = response.body?.getReader();
      if (!reader) return response;
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(output) {
          const chunk = await reader.read();
          if (chunk.done) {
            output.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > MAX_BYTES) {
            await reader.cancel();
            output.error(
              new BirdeyeMcpError(
                502,
                'Birdeye MCP returned too much data.',
                'response-too-large',
              ),
            );
          } else output.enqueue(chunk.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(BIRDEYE_MCP_ENDPOINT), {
          fetch: boundedFetch,
          requestInit: {
            headers: { 'x-api-key': this.#apiKey },
            redirect: 'error',
          },
        }),
        { signal, timeout: 15_000 },
      );
      const value = this.safe(await operation(client, signal));
      signal.throwIfAborted();
      this.lastError = undefined;
      this.verifiedAt = this.now();
      return value;
    } catch (error) {
      caller?.throwIfAborted();
      const failure = this.failure(error);
      this.lastError = {
        status: failure.status,
        code: failure.code,
        message: failure.message,
      };
      throw failure;
    } finally {
      controller.abort();
      clearTimeout(deadline);
      await client.close().catch(() => {});
      this.active--;
    }
  }

  private async tools(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.catalogValue && this.now() - this.catalogValue.observedAt < 30_000)
      return this.catalogValue;
    // Catalog metadata is public. Share discovery without sharing tool results.
    this.catalogPending ??= this.withClient(async (client, requestSignal) => {
      const tools: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          signal: requestSignal,
          timeout: 12_000,
        });
        tools.push(...page.tools);
        if (
          tools.length > 500 ||
          (page.nextCursor && cursors.has(page.nextCursor))
        )
          throw new BirdeyeMcpError(
            502,
            'Birdeye MCP returned an invalid or oversized catalog.',
            'invalid-catalog',
          );
        cursor = page.nextCursor;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { tools, observedAt: this.now() };
    })
      .then((value) => (this.catalogValue = value))
      .finally(() => {
        this.catalogPending = undefined;
      });
    // An individual cancelled caller must not cancel other users' discovery.
    const value = await callerResult(this.catalogPending, signal);
    signal?.throwIfAborted();
    return value;
  }

  async catalog(search = '', signal?: AbortSignal) {
    if (search.length > 100)
      throw new BirdeyeMcpError(
        400,
        'Use a shorter tool search.',
        'invalid-input',
      );
    const value = await this.tools(signal);
    const term = search.trim().toLowerCase();
    return this.safe({
      ...this.status(),
      observedAt: value.observedAt,
      total: value.tools.length,
      tools: value.tools
        .filter(
          (tool) =>
            !term ||
            `${tool.name} ${tool.description || ''}`
              .toLowerCase()
              .includes(term),
        )
        .map((tool) => ({ ...tool, callable: readOnly(tool) })),
      instruction:
        'Use exact current names and input schemas. Only tools explicitly marked read-only are callable. Missing metadata does not grant permission.',
    });
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(name) ||
      !args ||
      Array.isArray(args) ||
      typeof args !== 'object'
    )
      throw new BirdeyeMcpError(
        400,
        'Choose a tool from the Birdeye MCP catalog.',
        'invalid-input',
      );
    validateArguments(args);
    const serialized = JSON.stringify(args);
    if (
      Buffer.byteLength(serialized) > 16_000 ||
      (this.#apiKey && serialized.includes(this.#apiKey))
    )
      throw new BirdeyeMcpError(
        400,
        'Choose a smaller data-only input.',
        'invalid-input',
      );
    const value = await this.tools(signal);
    const tool = value.tools.find((item) => item.name === name);
    if (!tool)
      throw new BirdeyeMcpError(
        404,
        'This tool is absent from the current Birdeye MCP catalog.',
        'unknown-tool',
      );
    if (!readOnly(tool))
      throw new BirdeyeMcpError(
        403,
        'Only Birdeye tools explicitly marked read-only are enabled.',
        'read-only-required',
      );
    const result = await this.withClient(
      (client, requestSignal) =>
        client.callTool({ name, arguments: args }, undefined, {
          signal: requestSignal,
          timeout: 12_000,
        }),
      signal,
    );
    return this.safe({
      source: 'Birdeye' as const,
      transport: 'mcp' as const,
      tool: name,
      observedAt: this.now(),
      result,
    });
  }
}
