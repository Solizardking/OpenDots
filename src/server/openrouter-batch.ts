import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type {
  OpenRouterBatchJob,
  OpenRouterBatchResult,
  OpenRouterBatchState,
  OpenRouterBatchStatus,
} from '../shared/openrouter-types.js';

export const DEFAULT_OPENROUTER_CLAUDE_MODEL = 'anthropic/claude-haiku-5.5';
const API = 'https://openrouter.ai/api/v1/batches';
const TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 4_000_000;
const MAX_ACTIVE = 3;
const terminal = new Set<OpenRouterBatchStatus>([
  'completed',
  'failed',
  'expired',
  'cancelled',
  'deleted',
]);
const submissions = new WeakMap<DatabaseSync, Set<string>>();

export function openRouterBatchConfigFromEnv(
  env: Record<string, string | undefined>,
) {
  return {
    apiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
    model:
      env.OPENROUTER_CLAUDE_MODEL?.trim() || DEFAULT_OPENROUTER_CLAUDE_MODEL,
  };
}

const submission = z
  .object({
    requestId: z.string().uuid(),
    prompts: z.array(z.string().trim().min(1).max(16_000)).min(1).max(50),
    maxTokens: z.number().int().min(64).max(4096).default(512),
  })
  .strict();
const providerBatch = z
  .object({
    id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    object: z.literal('batch'),
    endpoint: z.literal('/v1/chat/completions'),
    model: z.string(),
    status: z.enum([
      'validating',
      'in_progress',
      'finalizing',
      'completed',
      'failed',
      'expired',
      'cancelling',
      'cancelled',
    ]),
    request_counts: z.object({
      total: z.number().int().min(1).max(50),
      completed: z.number().int().min(0).max(50),
      failed: z.number().int().min(0).max(50),
    }),
    results: z
      .array(
        z.object({
          custom_id: z.string(),
          response: z
            .object({ status_code: z.number().int(), body: z.unknown() })
            .nullish(),
          error: z.unknown().nullish(),
        }),
      )
      .max(50)
      .nullish(),
    usage: z.unknown().nullish(),
    error: z.unknown().nullish(),
  })
  .passthrough();
const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  cost: z.number().nonnegative().nullish(),
});
const providerDeletion = z.object({
  id: z.string(),
  object: z.literal('batch'),
  deletion: z.object({
    openrouter: z.literal('deleted'),
    upstream: z
      .object({
        provider: z.string().min(1),
        status: z.enum(['deleted', 'unsupported', 'not_applicable']),
      })
      .optional(),
  }),
});
const legacyProviderDeletion = z.object({
  id: z.string(),
  deleted: z.literal(true),
});

function providerFailure(status: number) {
  if (status === 400 || status === 422)
    return 'OpenRouter rejected the batch input or selected model.';
  if (status === 401) return 'OpenRouter credentials could not be verified.';
  if (status === 402)
    return 'OpenRouter needs additional credits for this batch. Poll this same batch after adding credits.';
  if (status === 403)
    return 'The OpenRouter account does not permit this model or batch request.';
  if (status === 404) return 'OpenRouter could not find this batch or model.';
  if (status === 409)
    return 'This batch is still processing and cannot be deleted.';
  if (status === 429)
    return 'OpenRouter is rate limiting batch requests. Try again later.';
  return 'OpenRouter is temporarily unavailable. The batch was not resubmitted.';
}

function providerHttpStatus(
  status: number,
): 400 | 402 | 404 | 413 | 422 | 429 | 502 {
  // Provider credentials must not look like an expired application login.
  if (
    status === 400 ||
    status === 402 ||
    status === 404 ||
    status === 413 ||
    status === 422 ||
    status === 429
  )
    return status;
  return 502;
}

function matchesRequestedModel(returned: string, requested: string) {
  const canonical = returned.replace(/:batch$/, '');
  if (canonical === requested) return true;
  if (!canonical.startsWith(`${requested}-`)) return false;
  const dated = canonical.slice(requested.length + 1);
  if (!/^\d{8}$/.test(dated)) return false;
  const year = Number(dated.slice(0, 4));
  const month = Number(dated.slice(4, 6));
  const day = Number(dated.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

type RecordRow = {
  providerId: string | null;
  fingerprint: string;
  job: OpenRouterBatchJob;
};

/** Mount inside the existing authenticated, per-workspace app. */
export function createOpenRouterBatchRoutes(options: {
  database: DatabaseSync;
  apiKey?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  enabled?: () => boolean;
}) {
  const db = options.database;
  const apiKey = options.apiKey?.trim();
  const model = options.model?.trim() || DEFAULT_OPENROUTER_CLAUDE_MODEL;
  const baseModel = model.replace(/:batch$/, '');
  const configured =
    !!apiKey && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(baseModel);
  const request = options.fetch ?? globalThis.fetch;
  const activeSubmissions = submissions.get(db) ?? new Set<string>();
  submissions.set(db, activeSubmissions);
  db.exec(`CREATE TABLE IF NOT EXISTS openrouter_batch_jobs(
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    provider_id TEXT,
    status TEXT NOT NULL,
    value TEXT NOT NULL
  )`);

  function read(where: 'id' | 'request_id', id: string): RecordRow | undefined {
    const row = db
      .prepare(
        `SELECT provider_id,fingerprint,value FROM openrouter_batch_jobs WHERE ${where}=?`,
      )
      .get(id);
    return row
      ? {
          providerId:
            typeof row.provider_id === 'string' ? row.provider_id : null,
          fingerprint: String(row.fingerprint),
          job: JSON.parse(String(row.value)) as OpenRouterBatchJob,
        }
      : undefined;
  }
  function save(row: RecordRow) {
    const current = read('id', row.job.id);
    // A slow poll must not replace a newer completed result or deletion.
    if (
      current &&
      ((current.job.status === 'deleted' && row.job.status !== 'deleted') ||
        (terminal.has(current.job.status) &&
          row.job.status !== 'deleted' &&
          current.job.status !== row.job.status) ||
        (current.job.status === 'completed' &&
          current.job.results !== null &&
          row.job.status === 'completed' &&
          row.job.results === null))
    ) {
      row.job = current.job;
      row.providerId = current.providerId;
      return;
    }
    row.job.updatedAt = Date.now();
    db.prepare(
      'UPDATE openrouter_batch_jobs SET provider_id=?,status=?,value=? WHERE id=?',
    ).run(row.providerId, row.job.status, JSON.stringify(row.job), row.job.id);
  }
  function safeText(text: string) {
    return (apiKey ? text.split(apiKey).join('[redacted]') : text)
      .replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .slice(0, 65_536);
  }
  async function upstream(
    path: string,
    method: 'POST' | 'GET' | 'DELETE',
    body?: unknown,
  ) {
    const response = await request(path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://chatgptee.ai',
        'X-OpenRouter-Title': 'ChatGPTEE',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw Error('Provider response exceeded the supported size.');
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      payload = null;
    }
    return { response, payload };
  }
  function applyProvider(row: RecordRow, payload: unknown) {
    const parsed = providerBatch.safeParse(payload);
    if (!parsed.success) return false;
    const value = parsed.data;
    const counts = value.request_counts;
    if (
      (row.providerId && value.id !== row.providerId) ||
      !matchesRequestedModel(value.model, row.job.baseModel) ||
      counts.total !== row.job.prompts.length ||
      counts.completed + counts.failed > counts.total
    )
      return false;
    let results: OpenRouterBatchResult[] | null = null;
    if (value.status === 'completed' && Array.isArray(value.results)) {
      const byId = new Map(value.results.map((item) => [item.custom_id, item]));
      if (
        byId.size !== row.job.prompts.length ||
        value.results.length !== byId.size ||
        row.job.prompts.some((prompt) => !byId.has(prompt.customId))
      )
        return false;
      results = row.job.prompts.map(({ customId, prompt }) => {
        const item = byId.get(customId)!;
        const statusCode = item.response?.status_code ?? null;
        const body = item.response?.body as
          | { choices?: { message?: { role?: string; content?: unknown } }[] }
          | undefined;
        const message = body?.choices?.[0]?.message;
        const text =
          message?.role === 'assistant' && typeof message.content === 'string'
            ? safeText(message.content).trim()
            : '';
        const success =
          !item.error &&
          statusCode !== null &&
          statusCode >= 200 &&
          statusCode < 300 &&
          !!text;
        return {
          customId,
          prompt,
          text: success ? text : null,
          error: success
            ? null
            : statusCode && statusCode >= 400
              ? providerFailure(statusCode)
              : 'This batch request did not return an assistant answer.',
          statusCode,
        };
      });
    }
    const usage = usageSchema.safeParse(value.usage);
    row.providerId = value.id;
    row.job.status = value.status;
    row.job.requestCounts = {
      total: counts.total,
      completed: counts.completed,
      failed: counts.failed,
    };
    row.job.results = results;
    row.job.usage = usage.success
      ? {
          promptTokens: usage.data.prompt_tokens,
          completionTokens: usage.data.completion_tokens,
          totalTokens: usage.data.total_tokens,
          cost: usage.data.cost ?? null,
        }
      : null;
    row.job.error = value.error
      ? 'OpenRouter could not complete this batch.'
      : ['failed', 'expired', 'cancelled'].includes(value.status)
        ? `The batch ${value.status}.`
        : null;
    row.job.pollError = null;
    return true;
  }

  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use('/', bodyLimit({ maxSize: 3_500_000 }));
  app.get('/', (c) => {
    const jobs = db
      .prepare(
        "SELECT value FROM openrouter_batch_jobs WHERE status<>'deleted' ORDER BY rowid DESC LIMIT 50",
      )
      .all()
      .map((row) => JSON.parse(String(row.value)) as OpenRouterBatchJob);
    return c.json({
      configured,
      configuredModel: model,
      jobs,
    } satisfies OpenRouterBatchState);
  });
  app.post('/', async (c) => {
    if (!configured)
      return c.json(
        {
          error:
            'Configure the server OpenRouter API key and model to use batches.',
        },
        503,
      );
    if (options.enabled && !options.enabled())
      return c.json(
        {
          error:
            'Resume your workspace and enable research before starting a batch.',
        },
        403,
      );
    const parsed = submission.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Use a unique requestId, 1–50 nonempty prompts up to 16,000 characters, and maxTokens from 64–4096.',
        },
        400,
      );
    const input = parsed.data;
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          model,
          prompts: input.prompts,
          maxTokens: input.maxTokens,
        }),
      )
      .digest('hex');
    const previous = read('request_id', input.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return c.json(
          { error: 'This requestId already belongs to a different batch.' },
          409,
        );
      if (previous.job.status === 'deleted')
        return c.json(
          { error: 'This batch was deleted. Its requestId cannot be reused.' },
          410,
        );
      return c.json(
        previous.job,
        terminal.has(previous.job.status) ? 200 : 202,
      );
    }
    const now = Date.now();
    const row: RecordRow = {
      providerId: null,
      fingerprint,
      job: {
        id: randomUUID(),
        requestId: input.requestId,
        model,
        baseModel,
        endpoint: '/v1/chat/completions',
        completionWindow: '24h',
        status: 'submitting',
        createdAt: now,
        updatedAt: now,
        requestCounts: { total: input.prompts.length, completed: 0, failed: 0 },
        prompts: input.prompts.map((prompt, index) => ({
          customId: `req-${String(index + 1).padStart(4, '0')}`,
          prompt,
        })),
        maxTokens: input.maxTokens,
        results: null,
        usage: null,
        error: null,
        pollError: null,
      },
    };
    // Reserve the request id durably before the first potentially billed POST.
    db.exec('BEGIN IMMEDIATE');
    try {
      const count = db
        .prepare(
          "SELECT count(*) AS total FROM openrouter_batch_jobs WHERE status NOT IN ('completed','failed','expired','cancelled','deleted')",
        )
        .get();
      if (Number(count?.total) >= MAX_ACTIVE) {
        db.exec('ROLLBACK');
        return c.json(
          {
            error:
              'Wait for one of your three active batches to finish before submitting another.',
          },
          429,
        );
      }
      db.prepare('INSERT INTO openrouter_batch_jobs VALUES (?,?,?,?,?,?)').run(
        row.job.id,
        input.requestId,
        fingerprint,
        null,
        row.job.status,
        JSON.stringify(row.job),
      );
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      return c.json(
        {
          error:
            'The batch reservation could not be saved. No provider request was sent.',
        },
        503,
      );
    }
    activeSubmissions.add(row.job.id);
    try {
      // OpenRouter requires settings to precede requests in the serialized body.
      const { response, payload } = await upstream(API, 'POST', {
        endpoint: '/v1/chat/completions',
        model: baseModel,
        completion_window: '24h',
        requests: row.job.prompts.map(({ customId, prompt }) => ({
          custom_id: customId,
          body: {
            messages: [{ role: 'user', content: prompt }],
            max_tokens: input.maxTokens,
          },
        })),
      });
      if (response.status !== 202) {
        row.job.status =
          response.status >= 500 || response.ok
            ? 'submission_unknown'
            : 'failed';
        row.job.error = providerFailure(response.status);
        save(row);
        return c.json(
          { error: providerFailure(response.status), job: row.job },
          providerHttpStatus(response.status),
        );
      }
      if (!applyProvider(row, payload)) {
        const id = z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_-]+$/)
          .safeParse(
            payload && typeof payload === 'object' && 'id' in payload
              ? payload.id
              : undefined,
          );
        row.providerId = id.success ? id.data : null;
        row.job.status = 'submission_unknown';
        row.job.error =
          'OpenRouter accepted the submission but its response could not be verified. Do not resubmit it.';
        save(row);
        return c.json({ error: row.job.error, job: row.job }, 502);
      }
      save(row);
      return c.json(row.job, 202);
    } catch {
      row.job.status = 'submission_unknown';
      row.job.error =
        'The submission result is unknown. Reuse this requestId to avoid submitting and billing the same batch twice.';
      save(row);
      return c.json({ error: row.job.error, job: row.job }, 503);
    } finally {
      activeSubmissions.delete(row.job.id);
    }
  });
  app.get('/:id', async (c) => {
    const row = read('id', c.req.param('id'));
    if (!row)
      return c.json({ error: 'Batch not found in your workspace.' }, 404);
    if (row.job.status === 'deleted')
      return c.json({ error: 'This batch was deleted.' }, 410);
    if (
      terminal.has(row.job.status) &&
      (row.job.status !== 'completed' || row.job.results !== null)
    )
      return c.json(row.job);
    if (!row.providerId) {
      if (
        row.job.status === 'submitting' &&
        !activeSubmissions.has(row.job.id)
      ) {
        row.job.status = 'submission_unknown';
        row.job.error =
          'The server restarted before the submission result was saved. Do not resubmit this batch.';
        save(row);
      }
      return c.json(row.job);
    }
    if (!configured)
      return c.json(
        {
          error:
            'OpenRouter is not configured. This accepted batch has not been resubmitted.',
          job: row.job,
        },
        503,
      );
    try {
      const { response, payload } = await upstream(
        `${API}/${encodeURIComponent(row.providerId)}`,
        'GET',
      );
      if (!response.ok) {
        if (response.status === 404) {
          // An accepted provider batch can briefly be unavailable while validating.
          // Retain its durable ownership and retry only this saved provider id.
          const cached = read('id', row.job.id) ?? row;
          if (cached.job.status === 'deleted')
            return c.json({ error: 'This batch was deleted.' }, 410);
          if (
            terminal.has(cached.job.status) &&
            (cached.job.status !== 'completed' || cached.job.results !== null)
          )
            return c.json(cached.job);
          cached.job.pollError =
            'OpenRouter has not made this batch status available yet. This saved batch will be checked again; it has not been resubmitted.';
          save(cached);
          return c.json(cached.job);
        }
        if (response.status === 402) applyProvider(row, payload);
        row.job.pollError = providerFailure(response.status);
        save(row);
        return c.json(
          { error: providerFailure(response.status), job: row.job },
          providerHttpStatus(response.status),
        );
      }
      if (!applyProvider(row, payload)) {
        row.job.pollError =
          'OpenRouter returned an invalid batch response. Poll this same batch again.';
        save(row);
        return c.json({ error: row.job.pollError, job: row.job }, 502);
      }
      const current = read('id', row.job.id);
      if (
        current &&
        terminal.has(current.job.status) &&
        !terminal.has(row.job.status)
      )
        return c.json(current.job);
      save(row);
      return c.json(row.job);
    } catch {
      row.job.pollError =
        'The status request could not finish. Poll this same batch again; it has not been resubmitted.';
      save(row);
      return c.json({ error: row.job.pollError, job: row.job }, 503);
    }
  });
  app.delete('/:id', async (c) => {
    const row = read('id', c.req.param('id'));
    if (!row)
      return c.json({ error: 'Batch not found in your workspace.' }, 404);
    if (row.job.status === 'deleted')
      return c.json({ deleted: true, id: row.job.id });
    if (!terminal.has(row.job.status))
      return c.json(
        {
          error:
            'Only finished batches can be deleted. OpenRouter does not support cancellation through this API.',
        },
        409,
      );
    if (row.providerId) {
      if (!configured)
        return c.json(
          {
            error: 'Configure OpenRouter before deleting this provider batch.',
          },
          503,
        );
      try {
        const { response, payload } = await upstream(
          `${API}/${encodeURIComponent(row.providerId)}`,
          'DELETE',
        );
        if (response.status !== 404 && !response.ok)
          return c.json(
            { error: providerFailure(response.status) },
            response.status === 409 ? 409 : 502,
          );
        const deletion = providerDeletion.safeParse(payload);
        const legacy = legacyProviderDeletion.safeParse(payload);
        const confirmed =
          (deletion.success && deletion.data.id === row.providerId) ||
          (legacy.success && legacy.data.id === row.providerId);
        if (response.status !== 404 && !confirmed) {
          // Only the mapped, owned provider id may establish absence after a
          // successful DELETE with an empty or otherwise unrecognized body.
          const check = await upstream(
            `${API}/${encodeURIComponent(row.providerId)}`,
            'GET',
          );
          if (check.response.status !== 404)
            return c.json(
              {
                error:
                  'OpenRouter did not confirm deletion. Try deleting this same finished batch again.',
              },
              502,
            );
        }
      } catch {
        return c.json(
          {
            error:
              'Batch deletion could not be confirmed. Try deleting this same batch again.',
          },
          503,
        );
      }
    }
    row.job.status = 'deleted';
    row.job.prompts = [];
    row.job.results = null;
    row.job.error = null;
    row.job.pollError = null;
    save(row);
    return c.json({ deleted: true, id: row.job.id });
  });
  return app;
}
