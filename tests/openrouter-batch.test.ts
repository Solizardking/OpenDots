import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenRouterBatchRoutes,
  openRouterBatchConfigFromEnv,
} from '../src/server/openrouter-batch.js';
import type { OpenRouterBatchJob as Job } from '../src/shared/openrouter-types.js';

const BASE_MODEL = 'anthropic/claude-haiku-5.5';
const REQUESTED_MODEL = `${BASE_MODEL}:batch`;
const PROVIDER_URL = 'https://openrouter.ai/api/v1/batches';
const FIXTURE_KEY = 'sk-or-fixture-private-key';
const databases = new Set<DatabaseSync>();
const temporaryDirectories = new Set<string>();

type BatchInput = {
  requestId: string;
  prompts: string[];
  maxTokens?: number;
};

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of temporaryDirectories)
    rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function openDatabase(path = ':memory:') {
  const database = new DatabaseSync(path);
  databases.add(database);
  return database;
}

function closeDatabase(database: DatabaseSync) {
  databases.delete(database);
  database.close();
}

function temporaryDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'chatgptee-batch-test-'));
  temporaryDirectories.add(directory);
  return join(directory, 'workspace.sqlite');
}

function queuedBatch(id = 'batch_provider_1', count = 1) {
  return {
    id,
    object: 'batch',
    endpoint: '/v1/chat/completions',
    model: BASE_MODEL,
    completion_window: '24h',
    status: 'validating',
    created_at: 1791633600,
    finalized_at: null,
    request_counts: { total: count, completed: 0, failed: 0 },
    results: null,
    usage: null,
    error: null,
  };
}

function result(customId: string, text: string) {
  return {
    custom_id: customId,
    response: {
      status_code: 200,
      request_id: `request_${customId}`,
      body: {
        id: `gen_${customId}`,
        model: BASE_MODEL,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          },
        ],
      },
    },
    error: null,
  };
}

function completedBatch(id = 'batch_provider_1', text = 'Completed answer') {
  return {
    ...queuedBatch(id),
    status: 'completed',
    finalized_at: 1791634200,
    request_counts: { total: 1, completed: 1, failed: 0 },
    results: [result('req-0001', text)],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 40,
      total_tokens: 60,
      cost: 0.00002,
    },
  };
}

function providerFetch() {
  return vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(queuedBatch(), { status: 202 }),
  );
}

function fixture(
  fetch = providerFetch(),
  options: Partial<
    Omit<Parameters<typeof createOpenRouterBatchRoutes>[0], 'fetch'>
  > = {},
) {
  const database = options.database ?? openDatabase();
  const app = createOpenRouterBatchRoutes({
    database,
    apiKey: FIXTURE_KEY,
    model: REQUESTED_MODEL,
    ...options,
    fetch,
  });
  return { app, database, fetch };
}

function input(prompts = ['Describe Solana.']): BatchInput {
  return { requestId: randomUUID(), prompts };
}

function jsonRequest(body: unknown) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function post(
  app: ReturnType<typeof createOpenRouterBatchRoutes>,
  body: BatchInput = input(),
) {
  return app.request('/', jsonRequest(body));
}

function readJob(response: Response): Promise<Job> {
  return response.json();
}

describe('OpenRouter batch configuration and submission', () => {
  it('uses the explicit OpenRouter key and base default, retaining a requested batch variant', () => {
    expect(openRouterBatchConfigFromEnv({})).toMatchObject({
      model: BASE_MODEL,
    });
    expect(openRouterBatchConfigFromEnv({}).apiKey).toBeUndefined();
    expect(
      openRouterBatchConfigFromEnv({
        OPENROUTER_API_KEY: ' fixture-openrouter-key ',
        OPENROUTER_CLAUDE_MODEL: ` ${REQUESTED_MODEL} `,
      }),
    ).toMatchObject({
      apiKey: 'fixture-openrouter-key',
      model: REQUESTED_MODEL,
    });
    expect(
      openRouterBatchConfigFromEnv({
        OPENROUTER_API_KEY: '   ',
        OPENROUTER_CLAUDE_MODEL: '   ',
      }),
    ).toMatchObject({ apiKey: undefined, model: BASE_MODEL });
  });

  it('reports missing configuration without submitting any provider request', async () => {
    const { app, fetch } = fixture(providerFetch(), { apiKey: undefined });
    expect(await (await app.request('/')).json()).toMatchObject({
      configured: false,
      configuredModel: REQUESTED_MODEL,
      jobs: [],
    });
    expect((await post(app)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks submission permission before contacting the provider', async () => {
    const { app, fetch } = fixture(providerFetch(), { enabled: () => false });
    expect((await post(app)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(await (await app.request('/')).json()).toMatchObject({ jobs: [] });
  });

  it('submits to the fixed endpoint with ordered prompts and the configured batch model', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(
      Response.json(queuedBatch('batch_provider_1', 2), { status: 202 }),
    );
    const { app } = fixture(fetch);
    const body = input(['First prompt', 'Second prompt']);
    const response = await post(app, body);
    expect(response.status).toBe(202);
    const job = await readJob(response);
    expect(job).toMatchObject({
      requestId: body.requestId,
      model: REQUESTED_MODEL,
      baseModel: BASE_MODEL,
      status: 'validating',
      requestCounts: { total: 2, completed: 0, failed: 0 },
      prompts: [
        { customId: 'req-0001', prompt: 'First prompt' },
        { customId: 'req-0002', prompt: 'Second prompt' },
      ],
      results: null,
      error: null,
      pollError: null,
    });
    expect(job.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(job.id).not.toBe('batch_provider_1');
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(PROVIDER_URL);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Bearer ${FIXTURE_KEY}`,
    );
    const outbound = JSON.parse(String(init?.body));
    expect(outbound).toMatchObject({
      endpoint: '/v1/chat/completions',
      model: BASE_MODEL,
      requests: [
        {
          custom_id: 'req-0001',
          body: {
            messages: [{ role: 'user', content: 'First prompt' }],
            max_tokens: 512,
          },
        },
        {
          custom_id: 'req-0002',
          body: {
            messages: [{ role: 'user', content: 'Second prompt' }],
            max_tokens: 512,
          },
        },
      ],
    });
    expect(Object.keys(outbound).indexOf('model')).toBeLessThan(
      Object.keys(outbound).indexOf('requests'),
    );
    expect(Object.keys(outbound).indexOf('endpoint')).toBeLessThan(
      Object.keys(outbound).indexOf('requests'),
    );
    expect(JSON.stringify(job)).not.toContain(FIXTURE_KEY);
  });

  it('supports the configured base slug without adding a suffix to the provider request', async () => {
    const { app, fetch } = fixture(providerFetch(), { model: BASE_MODEL });
    const job = await readJob(await post(app));
    expect(job).toMatchObject({ model: BASE_MODEL, baseModel: BASE_MODEL });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe(
      BASE_MODEL,
    );
  });

  it.each([BASE_MODEL, REQUESTED_MODEL])(
    'accepts a dated canonical provider alias for configured model %s through completion',
    async (model) => {
      const canonicalModel = `${BASE_MODEL}-20261007`;
      const answer = result('req-0001', 'Canonical model answer');
      answer.response.body.model = canonicalModel;
      const fetch = providerFetch();
      fetch.mockResolvedValueOnce(
        Response.json(
          { ...queuedBatch(), model: canonicalModel, status: 'in_progress' },
          { status: 202 },
        ),
      );
      fetch.mockResolvedValueOnce(
        Response.json({
          ...completedBatch(),
          model: canonicalModel,
          results: [answer],
        }),
      );
      const { app } = fixture(fetch, { model });
      const submission = await post(app);
      expect(submission.status).toBe(202);
      const job = await readJob(submission);
      expect(job).toMatchObject({
        model,
        baseModel: BASE_MODEL,
        status: 'in_progress',
        results: null,
        error: null,
      });
      expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).model).toBe(
        BASE_MODEL,
      );
      const response = await app.request(`/${job.id}`);
      expect(response.status).toBe(200);
      const completed = await readJob(response);
      expect(completed).toMatchObject({
        id: job.id,
        model,
        baseModel: BASE_MODEL,
        status: 'completed',
        results: [
          {
            customId: 'req-0001',
            prompt: 'Describe Solana.',
            text: 'Canonical model answer',
            statusCode: 200,
            error: null,
          },
        ],
        pollError: null,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await readJob(await app.request(`/${job.id}`))).toEqual(completed);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    'anthropic/claude-sonnet-5.5-20261007',
    'anthropic/claude-haiku-5.6-20261007',
    `${BASE_MODEL}-20261007-preview`,
    `${BASE_MODEL}-2026107`,
    `${BASE_MODEL}-20261307`,
    `${BASE_MODEL}-20260230`,
  ])('rejects unrelated or malformed provider model %s', async (model) => {
    const rejectedFetch = providerFetch();
    rejectedFetch.mockResolvedValueOnce(
      Response.json({ ...queuedBatch(), model }, { status: 202 }),
    );
    const { app: rejectedApp } = fixture(rejectedFetch);
    const rejected = await post(rejectedApp);
    expect(rejected.status).toBe(502);
    expect(await rejected.json()).toMatchObject({
      job: { status: 'submission_unknown', results: null },
    });

    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(Response.json({ ...completedBatch(), model }));
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const response = await app.request(`/${job.id}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      job: {
        id: job.id,
        status: 'validating',
        results: null,
        pollError: expect.any(String),
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing request id', { prompts: ['Hello'] }],
    ['invalid request id', { requestId: 'reused-id', prompts: ['Hello'] }],
    ['empty prompts', { requestId: randomUUID(), prompts: [] }],
    [
      'too many prompts',
      { requestId: randomUUID(), prompts: Array(51).fill('x') },
    ],
    ['empty prompt', { requestId: randomUUID(), prompts: [''] }],
    ['non-string prompt', { requestId: randomUUID(), prompts: [1] }],
    [
      'too few tokens',
      { requestId: randomUUID(), prompts: ['x'], maxTokens: 63 },
    ],
    [
      'too many tokens',
      { requestId: randomUUID(), prompts: ['x'], maxTokens: 4097 },
    ],
    [
      'fractional tokens',
      { requestId: randomUUID(), prompts: ['x'], maxTokens: 64.5 },
    ],
  ])('rejects %s before submission', async (_label, body) => {
    const { app, fetch } = fixture();
    expect((await app.request('/', jsonRequest(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(await (await app.request('/')).json()).toMatchObject({ jobs: [] });
  });

  it.each([64, 4096])(
    'passes an allowed %i token limit to the provider',
    async (maxTokens) => {
      const { app, fetch } = fixture();
      expect((await post(app, { ...input(), maxTokens })).status).toBe(202);
      expect(
        JSON.parse(String(fetch.mock.calls[0][1]?.body)).requests[0].body
          .max_tokens,
      ).toBe(maxTokens);
    },
  );

  it('limits pending jobs to three without affecting existing request-id retries', async () => {
    const { app, fetch } = fixture();
    const first = input();
    for (const body of [first, input(), input()])
      expect((await post(app, body)).status).toBe(202);
    expect((await post(app)).status).toBe(429);
    expect((await post(app, first)).status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await (await app.request('/')).json()).jobs).toHaveLength(3);
  });
});

describe('batch workspace ownership and durable idempotency', () => {
  it('keeps jobs within the workspace database and refuses foreign identifiers without upstream calls', async () => {
    const owner = fixture();
    const another = fixture();
    const ownerJob = await readJob(await post(owner.app));
    expect((await (await owner.app.request('/')).json()).jobs).toHaveLength(1);
    expect((await (await another.app.request('/')).json()).jobs).toEqual([]);
    expect((await another.app.request(`/${ownerJob.id}`)).status).toBe(404);
    expect(
      (await another.app.request(`/${ownerJob.id}`, { method: 'DELETE' }))
        .status,
    ).toBe(404);
    expect((await owner.app.request('/batch_provider_1')).status).toBe(404);
    const unknownId = randomUUID();
    expect((await owner.app.request(`/${unknownId}`)).status).toBe(404);
    expect(
      (await owner.app.request(`/${unknownId}`, { method: 'DELETE' })).status,
    ).toBe(404);
    expect(another.fetch).not.toHaveBeenCalled();
    expect(owner.fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses a request id for the same payload and rejects changed prompts or token limits', async () => {
    const { app, fetch } = fixture();
    const body = input();
    const first = await readJob(await post(app, body));
    const retry = await post(app, body);
    expect(retry.status).toBe(202);
    expect((await readJob(retry)).id).toBe(first.id);
    expect(
      (await post(app, { ...body, prompts: ['Changed prompt'] })).status,
    ).toBe(409);
    expect((await post(app, { ...body, maxTokens: 513 })).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await (await app.request('/')).json()).jobs).toHaveLength(1);
  });

  it('preserves the accepted request across a database restart', async () => {
    const path = temporaryDatabasePath();
    const fetch = providerFetch();
    const first = fixture(fetch, { database: openDatabase(path) });
    const body = input();
    const accepted = await readJob(await post(first.app, body));
    closeDatabase(first.database);
    const restarted = fixture(fetch, { database: openDatabase(path) });
    const response = await post(restarted.app, body);
    expect(response.status).toBe(202);
    expect((await readJob(response)).id).toBe(accepted.id);
    expect((await (await restarted.app.request('/')).json()).jobs).toHaveLength(
      1,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reserves a request id once across concurrent route instances', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = providerFetch();
    fetch.mockImplementationOnce(() => pending);
    const database = openDatabase();
    const first = fixture(fetch, { database });
    const second = fixture(fetch, { database });
    const body = input();
    const submitted = post(first.app, body);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const retried = post(second.app, body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const callsBeforeResponse = fetch.mock.calls.length;
    release(Response.json(queuedBatch(), { status: 202 }));
    const [submission, retry] = await Promise.all([submitted, retried]);
    expect(callsBeforeResponse).toBe(1);
    expect(submission.status).toBe(202);
    expect(retry.status).toBe(202);
    expect((await readJob(retry)).id).toBe((await readJob(submission)).id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('persists an unknown submission outcome and does not resubmit after retry or restart', async () => {
    const path = temporaryDatabasePath();
    const fetch = providerFetch();
    fetch.mockRejectedValueOnce(
      new DOMException(
        `Provider timeout including ${FIXTURE_KEY}`,
        'TimeoutError',
      ),
    );
    const first = fixture(fetch, { database: openDatabase(path) });
    const body = input();
    const response = await post(first.app, body);
    expect(response.status).toBe(503);
    const unknown = await response.json();
    expect(unknown).toMatchObject({
      error: expect.any(String),
      job: {
        status: 'submission_unknown',
        requestId: body.requestId,
        results: null,
      },
    });
    expect(JSON.stringify(unknown)).not.toContain(FIXTURE_KEY);
    closeDatabase(first.database);
    const restarted = fixture(fetch, { database: openDatabase(path) });
    const retry = await post(restarted.app, body);
    expect(retry.status).toBe(202);
    expect(await readJob(retry)).toMatchObject({
      id: unknown.job.id,
      status: 'submission_unknown',
      results: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await (await restarted.app.request('/')).json()).jobs).toHaveLength(
      1,
    );
  });
});

describe('provider polling and error handling', () => {
  it('stores an upstream rejection with a safe error and prevents submission retries', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 401,
            message: `Invalid ${FIXTURE_KEY}`,
            metadata: { raw: 'provider-private-detail' },
          },
        },
        { status: 401 },
      ),
    );
    const { app } = fixture(fetch);
    const body = input();
    const response = await post(app, body);
    expect(response.status).toBe(502);
    const error = await response.json();
    expect(JSON.stringify(error)).not.toContain(FIXTURE_KEY);
    expect(JSON.stringify(error)).not.toContain('provider-private-detail');
    const list = await (await app.request('/')).json();
    expect(list.jobs).toHaveLength(1);
    expect(list.jobs[0]).toMatchObject({
      status: 'failed',
      results: null,
      error: expect.any(String),
    });
    const retry = await post(app, body);
    expect(retry.status).toBe(200);
    expect(await readJob(retry)).toMatchObject({
      id: list.jobs[0].id,
      status: 'failed',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps completed results to prompts by custom id, including per-request failures', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(
      Response.json(queuedBatch('batch_provider_1', 3), { status: 202 }),
    );
    fetch.mockResolvedValueOnce(
      Response.json({
        ...completedBatch(),
        request_counts: { total: 3, completed: 2, failed: 1 },
        results: [
          result('req-0003', 'Third answer'),
          {
            custom_id: 'req-0002',
            response: null,
            error: { code: 'invalid_request', message: FIXTURE_KEY },
          },
          result('req-0001', 'First answer'),
        ],
      }),
    );
    const { app } = fixture(fetch);
    const job = await readJob(
      await post(app, input(['First', 'Second', 'Third'])),
    );
    const response = await app.request(`/${job.id}`);
    expect(response.status).toBe(200);
    const completed = await readJob(response);
    expect(completed).toMatchObject({
      status: 'completed',
      requestCounts: { total: 3, completed: 2, failed: 1 },
    });
    expect(completed.results).toHaveLength(3);
    expect(
      completed.results?.find((item) => item.customId === 'req-0001'),
    ).toMatchObject({ prompt: 'First', text: 'First answer', statusCode: 200 });
    expect(
      completed.results?.find((item) => item.customId === 'req-0003'),
    ).toMatchObject({ prompt: 'Third', text: 'Third answer', statusCode: 200 });
    expect(
      completed.results?.find((item) => item.customId === 'req-0002'),
    ).toMatchObject({ prompt: 'Second', error: expect.any(String) });
    expect(JSON.stringify(completed)).not.toContain(FIXTURE_KEY);
    expect(String(fetch.mock.calls[1][0])).toBe(
      `${PROVIDER_URL}/batch_provider_1`,
    );
    expect(fetch.mock.calls[1][1]?.method ?? 'GET').toBe('GET');
  });

  it('caches completed results and treats duplicate terminal submissions as reads', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    const { app } = fixture(fetch);
    const body = input();
    const job = await readJob(await post(app, body));
    const completed = await readJob(await app.request(`/${job.id}`));
    expect(completed.results?.[0].text).toBe('Completed answer');
    expect(await readJob(await app.request(`/${job.id}`))).toEqual(completed);
    const retry = await post(app, body);
    expect(retry.status).toBe(200);
    expect(await readJob(retry)).toEqual(completed);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries retrieving results after a credits-blocked completed batch without resubmission', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(
      Response.json(
        {
          ...queuedBatch(),
          status: 'completed',
          request_counts: { total: 1, completed: 1, failed: 0 },
          results: null,
          error: {
            code: 402,
            message: `Provider credit details ${FIXTURE_KEY}`,
          },
        },
        { status: 402 },
      ),
    );
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const blocked = await app.request(`/${job.id}`);
    expect(blocked.status).toBe(402);
    const blockedBody = await blocked.json();
    expect(blockedBody).toMatchObject({
      error: expect.any(String),
      job: {
        id: job.id,
        status: 'completed',
        results: null,
        pollError: expect.any(String),
        requestCounts: { total: 1, completed: 1, failed: 0 },
      },
    });
    expect(JSON.stringify(blockedBody)).not.toContain(FIXTURE_KEY);
    const response = await app.request(`/${job.id}`);
    expect(response.status).toBe(200);
    const completed = await readJob(response);
    expect(completed.results?.[0].text).toBe('Completed answer');
    expect(completed.pollError).toBeNull();
    await app.request(`/${job.id}`);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  });

  it('keeps accepted jobs pollable after a safe upstream GET failure', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(
      new Response(`Raw proxy failure ${FIXTURE_KEY}`, { status: 502 }),
    );
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const failedPoll = await app.request(`/${job.id}`);
    expect(failedPoll.status).toBe(502);
    const error = await failedPoll.json();
    expect(error).toMatchObject({
      job: {
        id: job.id,
        status: 'validating',
        results: null,
        pollError: expect.any(String),
      },
    });
    expect(JSON.stringify(error)).not.toContain(FIXTURE_KEY);
    expect((await app.request(`/${job.id}`)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves an accepted batch across a temporary provider GET 404 and completes without resubmitting', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: 404, message: `Batch unavailable ${FIXTURE_KEY}` } },
        { status: 404 },
      ),
    );
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    const { app } = fixture(fetch);
    const body = input();
    const accepted = await readJob(await post(app, body));
    const unavailable = await app.request(`/${accepted.id}`);
    expect(unavailable.status).toBe(200);
    const saved = await readJob(unavailable);
    expect(saved).toMatchObject({
      id: accepted.id,
      requestId: accepted.requestId,
      model: accepted.model,
      baseModel: accepted.baseModel,
      status: accepted.status,
      prompts: accepted.prompts,
      requestCounts: accepted.requestCounts,
      maxTokens: accepted.maxTokens,
      results: accepted.results,
      error: accepted.error,
      pollError:
        'OpenRouter has not made this batch status available yet. This saved batch will be checked again; it has not been resubmitted.',
    });
    expect(JSON.stringify(saved)).not.toContain(FIXTURE_KEY);
    expect((await (await app.request('/')).json()).jobs).toEqual([saved]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const retry = await post(app, body);
    expect(retry.status).toBe(202);
    expect(await readJob(retry)).toEqual(saved);
    expect(fetch).toHaveBeenCalledTimes(2);

    const response = await app.request(`/${accepted.id}`);
    expect(response.status).toBe(200);
    const completed = await readJob(response);
    expect(completed).toMatchObject({
      id: accepted.id,
      requestId: accepted.requestId,
      model: accepted.model,
      baseModel: accepted.baseModel,
      prompts: accepted.prompts,
      status: 'completed',
      requestCounts: { total: 1, completed: 1, failed: 0 },
      results: [{ text: 'Completed answer', error: null, statusCode: 200 }],
      pollError: null,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetch.mock.calls.slice(1)) {
      expect(String(url)).toBe(`${PROVIDER_URL}/batch_provider_1`);
      expect(init?.method ?? 'GET').toBe('GET');
    }
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    expect(await readJob(await app.request(`/${accepted.id}`))).toEqual(
      completed,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('terminal deletion', () => {
  it('rejects deleting a pending job without contacting the provider', async () => {
    const { app, fetch } = fixture();
    const job = await readJob(await post(app));
    expect((await app.request(`/${job.id}`, { method: 'DELETE' })).status).toBe(
      409,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await (await app.request('/')).json()).jobs).toHaveLength(1);
  });

  it.each([200, 404])(
    'tombstones a terminal batch after provider deletion returns %i',
    async (providerStatus) => {
      const fetch = providerFetch();
      fetch.mockResolvedValueOnce(
        Response.json(queuedBatch(), { status: 202 }),
      );
      fetch.mockResolvedValueOnce(Response.json(completedBatch()));
      fetch.mockResolvedValueOnce(
        Response.json(
          { id: 'batch_provider_1', deleted: true },
          { status: providerStatus },
        ),
      );
      const { app } = fixture(fetch);
      const body = input();
      const job = await readJob(await post(app, body));
      await app.request(`/${job.id}`);
      const deletion = await app.request(`/${job.id}`, { method: 'DELETE' });
      expect(deletion.status).toBe(200);
      expect(await deletion.json()).toEqual({ deleted: true, id: job.id });
      expect(String(fetch.mock.calls[2][0])).toBe(
        `${PROVIDER_URL}/batch_provider_1`,
      );
      expect(fetch.mock.calls[2][1]?.method).toBe('DELETE');
      expect((await (await app.request('/')).json()).jobs).toEqual([]);
      expect((await app.request(`/${job.id}`)).status).toBe(410);
      expect((await post(app, body)).status).toBe(410);
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([undefined, 'deleted', 'unsupported', 'not_applicable'])(
    'accepts the documented deletion response with upstream outcome %s',
    async (upstreamStatus) => {
      const fetch = providerFetch();
      fetch.mockResolvedValueOnce(
        Response.json(queuedBatch(), { status: 202 }),
      );
      fetch.mockResolvedValueOnce(Response.json(completedBatch()));
      fetch.mockResolvedValueOnce(
        Response.json({
          id: 'batch_provider_1',
          object: 'batch',
          deletion: {
            openrouter: 'deleted',
            ...(upstreamStatus
              ? {
                  upstream: {
                    provider: 'Anthropic',
                    status: upstreamStatus,
                  },
                }
              : {}),
          },
        }),
      );
      const { app } = fixture(fetch);
      const body = input();
      const job = await readJob(await post(app, body));
      await app.request(`/${job.id}`);
      const deletion = await app.request(`/${job.id}`, { method: 'DELETE' });
      expect(deletion.status).toBe(200);
      expect(await deletion.json()).toEqual({ deleted: true, id: job.id });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(String(fetch.mock.calls[2][0])).toBe(
        `${PROVIDER_URL}/batch_provider_1`,
      );
      expect(fetch.mock.calls[2][1]?.method).toBe('DELETE');
      expect((await (await app.request('/')).json()).jobs).toEqual([]);
      expect((await app.request(`/${job.id}`)).status).toBe(410);
      expect((await post(app, body)).status).toBe(410);
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each(['empty', 'malformed'])(
    'confirms an unverified %s HTTP 200 deletion only after the stored provider id returns 404',
    async (payloadShape) => {
      const fetch = providerFetch();
      fetch.mockResolvedValueOnce(
        Response.json(queuedBatch(), { status: 202 }),
      );
      fetch.mockResolvedValueOnce(Response.json(completedBatch()));
      fetch.mockResolvedValueOnce(
        payloadShape === 'empty'
          ? new Response(null, { status: 200 })
          : Response.json({ id: 'batch_provider_1', object: 'batch' }),
      );
      fetch.mockResolvedValueOnce(
        Response.json(
          { error: { code: 404, message: 'Batch not found.' } },
          { status: 404 },
        ),
      );
      const { app } = fixture(fetch);
      const body = input();
      const job = await readJob(await post(app, body));
      await app.request(`/${job.id}`);
      const deletion = await app.request(`/${job.id}`, { method: 'DELETE' });
      expect(deletion.status).toBe(200);
      expect(await deletion.json()).toEqual({ deleted: true, id: job.id });
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(String(fetch.mock.calls[2][0])).toBe(
        `${PROVIDER_URL}/batch_provider_1`,
      );
      expect(fetch.mock.calls[2][1]?.method).toBe('DELETE');
      expect(String(fetch.mock.calls[3][0])).toBe(
        `${PROVIDER_URL}/batch_provider_1`,
      );
      expect(fetch.mock.calls[3][1]?.method ?? 'GET').toBe('GET');
      expect((await (await app.request('/')).json()).jobs).toEqual([]);
      expect((await app.request(`/${job.id}`)).status).toBe(410);
      expect((await post(app, body)).status).toBe(410);
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    ['malformed', { id: 'batch_provider_1', object: 'batch' }],
    [
      'foreign-id',
      {
        id: 'batch_foreign',
        object: 'batch',
        deletion: { openrouter: 'deleted' },
      },
    ],
  ])(
    'keeps the completed job after an unconfirmed %s deletion while the stored provider batch still exists',
    async (_label, payload) => {
      const fetch = providerFetch();
      fetch.mockResolvedValueOnce(
        Response.json(queuedBatch(), { status: 202 }),
      );
      fetch.mockResolvedValueOnce(Response.json(completedBatch()));
      fetch.mockResolvedValueOnce(Response.json(payload));
      fetch.mockResolvedValueOnce(Response.json(completedBatch()));
      const { app } = fixture(fetch);
      const job = await readJob(await post(app));
      const completed = await readJob(await app.request(`/${job.id}`));
      const deletion = await app.request(`/${job.id}`, { method: 'DELETE' });
      expect(deletion.status).toBe(502);
      expect(await deletion.json()).toMatchObject({
        error: expect.any(String),
      });
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(String(fetch.mock.calls[3][0])).toBe(
        `${PROVIDER_URL}/batch_provider_1`,
      );
      expect(fetch.mock.calls[3][1]?.method ?? 'GET').toBe('GET');
      expect((await (await app.request('/')).json()).jobs).toEqual([completed]);
      expect(await readJob(await app.request(`/${job.id}`))).toEqual(completed);
      expect(fetch).toHaveBeenCalledTimes(4);
    },
  );

  it('keeps completed results when an unconfirmed deletion cannot be verified because GET fails', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: 502, message: FIXTURE_KEY } },
        { status: 502 },
      ),
    );
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const completed = await readJob(await app.request(`/${job.id}`));
    const deletion = await app.request(`/${job.id}`, { method: 'DELETE' });
    expect(deletion.status).toBe(502);
    expect(await deletion.text()).not.toContain(FIXTURE_KEY);
    expect(String(fetch.mock.calls[3][0])).toBe(
      `${PROVIDER_URL}/batch_provider_1`,
    );
    expect((await (await app.request('/')).json()).jobs).toEqual([completed]);
    expect(await readJob(await app.request(`/${job.id}`))).toEqual(completed);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not use a GET fallback to hide a failed provider DELETE', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: 502, message: FIXTURE_KEY } },
        { status: 502 },
      ),
    );
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const completed = await readJob(await app.request(`/${job.id}`));
    const deletion = await app.request(`/${job.id}`, { method: 'DELETE' });
    expect(deletion.status).toBe(502);
    expect(await deletion.text()).not.toContain(FIXTURE_KEY);
    expect((await (await app.request('/')).json()).jobs).toEqual([completed]);
    expect(await readJob(await app.request(`/${job.id}`))).toEqual(completed);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retains the terminal job when provider deletion fails', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { code: 401, message: FIXTURE_KEY } },
        { status: 401 },
      ),
    );
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    await app.request(`/${job.id}`);
    const deletion = await app.request(`/${job.id}`, { method: 'DELETE' });
    expect(deletion.status).toBe(502);
    expect(await deletion.text()).not.toContain(FIXTURE_KEY);
    expect((await (await app.request('/')).json()).jobs).toHaveLength(1);
    expect((await app.request(`/${job.id}`)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('provider identity, durable deletion, and concurrent polling', () => {
  it('allows a new batch when an existing pending batch becomes terminal', async () => {
    const { app, fetch } = fixture();
    const first = await readJob(await post(app));
    await post(app);
    await post(app);
    expect((await post(app)).status).toBe(429);
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    expect((await app.request(`/${first.id}`)).status).toBe(200);
    expect((await post(app)).status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('does not retry an accepted submission whose provider response cannot identify the batch', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(
      Response.json({ object: 'batch', status: 'validating' }, { status: 202 }),
    );
    const { app } = fixture(fetch);
    const body = input();
    const response = await post(app, body);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      job: { status: 'submission_unknown', results: null },
    });
    expect((await post(app, body)).status).toBe(202);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider response for a different batch without exposing its results', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(
      Response.json(completedBatch('batch_foreign', 'Other workspace answer')),
    );
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const response = await app.request(`/${job.id}`);
    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload).toMatchObject({
      job: { id: job.id, status: 'validating', results: null },
    });
    expect(JSON.stringify(payload)).not.toContain('Other workspace answer');
  });

  it('rejects a body error inside an HTTP 200 result instead of displaying an answer', async () => {
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(
      Response.json({
        ...completedBatch(),
        results: [
          {
            custom_id: 'req-0001',
            response: {
              status_code: 200,
              body: { error: { code: 502, message: FIXTURE_KEY } },
            },
            error: null,
          },
        ],
      }),
    );
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const completed = await readJob(await app.request(`/${job.id}`));
    expect(completed.results?.[0]).toMatchObject({
      text: null,
      error: expect.any(String),
      statusCode: 200,
    });
    expect(JSON.stringify(completed)).not.toContain(FIXTURE_KEY);
  });

  it('does not overwrite completed results when an earlier concurrent poll fails late', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockImplementationOnce(() => pending);
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    const { app } = fixture(fetch);
    const job = await readJob(await post(app));
    const earlyPoll = app.request(`/${job.id}`);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const completed = await readJob(await app.request(`/${job.id}`));
    release(
      Response.json(
        { error: { code: 502, message: FIXTURE_KEY } },
        { status: 502 },
      ),
    );
    await earlyPoll;
    const finalJob = await readJob(await app.request(`/${job.id}`));
    expect(finalJob.status).toBe('completed');
    expect(finalJob.results).toEqual(completed.results);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves the tombstone across restart and never reuses the deleted request id', async () => {
    const path = temporaryDatabasePath();
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    fetch.mockResolvedValueOnce(
      Response.json({ id: 'batch_provider_1', deleted: true }),
    );
    const first = fixture(fetch, { database: openDatabase(path) });
    const body = input();
    const job = await readJob(await post(first.app, body));
    await first.app.request(`/${job.id}`);
    expect(
      (await first.app.request(`/${job.id}`, { method: 'DELETE' })).status,
    ).toBe(200);
    closeDatabase(first.database);
    const restarted = fixture(fetch, { database: openDatabase(path) });
    expect((await restarted.app.request(`/${job.id}`)).status).toBe(410);
    expect((await post(restarted.app, body)).status).toBe(410);
    expect((await (await restarted.app.request('/')).json()).jobs).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not resurrect a deleted job when a concurrent completed poll finishes late', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = providerFetch();
    fetch.mockResolvedValueOnce(Response.json(queuedBatch(), { status: 202 }));
    fetch.mockImplementationOnce(() => pending);
    fetch.mockResolvedValueOnce(Response.json(completedBatch()));
    fetch.mockResolvedValueOnce(
      Response.json({ id: 'batch_provider_1', deleted: true }),
    );
    const { app } = fixture(fetch);
    const body = input();
    const job = await readJob(await post(app, body));
    const earlyPoll = app.request(`/${job.id}`);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await app.request(`/${job.id}`);
    expect((await app.request(`/${job.id}`, { method: 'DELETE' })).status).toBe(
      200,
    );
    release(Response.json(completedBatch()));
    await earlyPoll;
    expect((await app.request(`/${job.id}`)).status).toBe(410);
    expect((await post(app, body)).status).toBe(410);
    expect((await (await app.request('/')).json()).jobs).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
