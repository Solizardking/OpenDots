import { expect, it, vi } from 'vitest';
import { browserUseConfigFromEnv } from '../src/server/browser-use-config.js';
import { xaiResponse } from '../src/server/browser-use-xai-agent.js';

it('drives Browser Use with xAI grok-4.7 by default', () => {
  const config = browserUseConfigFromEnv({
    BROWSERUSE_API_KEY: 'bu',
    XAI_API_KEY: 'xai-key',
  });
  expect(config.browserUseLlmProvider).toBe('xai');
  expect(config.browserUseXaiModel).toBe('grok-4.7');
  expect(config.browserUseXaiApiKey).toBe('xai-key');
});
it('keeps the hosted Browser Use model when chosen explicitly', () => {
  const config = browserUseConfigFromEnv({
    BROWSER_USE_LLM_PROVIDER: 'browser-use',
    BROWSER_USE_MODEL: 'gpt-6-luna',
  });
  expect(config.browserUseLlmProvider).toBe('browser-use');
  expect(config.browserUseModel).toBe('gpt-6-luna');
  expect(
    browserUseConfigFromEnv({ BROWSER_USE_XAI_MODEL: 'grok-x' })
      .browserUseXaiModel,
  ).toBe('grok-x');
});
it('calls the xAI Responses API with encrypted reasoning and a cache key', async () => {
  const reasoning = { type: 'reasoning', encrypted_content: 'opaque' };
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ output: [reasoning] })),
  );
  const output = await xaiResponse(
    { apiKey: 'k', model: 'grok-4.7', fetch: fetchMock as typeof fetch },
    [{ role: 'user', content: 'hi' }],
    'session-1',
    new AbortController().signal,
  );
  expect(output).toEqual([reasoning]);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [
    string,
    RequestInit,
  ];
  expect(url).toBe('https://api.x.ai/v1/responses');
  const body = JSON.parse(String(init.body));
  expect(body).toMatchObject({
    model: 'grok-4.7',
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'session-1',
  });
});
