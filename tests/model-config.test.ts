import { expect, it } from 'vitest';
import { modelConfigFromEnv } from '../src/server/model-config.js';
import { setupStatus } from '../src/server/platform-config.js';
it('routes Muse chat to OpenRouter and keeps its key out of setup status', () => {
  const config = modelConfigFromEnv({
    MODEL_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'private-openrouter-key',
    OPENROUTER_MUSEMODEL: 'meta/muse-wonder',
  });
  expect(config).toEqual({
    modelProvider: 'openrouter',
    apiKey: 'private-openrouter-key',
    model: 'meta/muse-wonder',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  const status = setupStatus({
    ...config,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  expect(status.model).toBe(true);
  expect(status.modelName).toBe('meta/muse-wonder');
  expect(JSON.stringify(status)).not.toContain('private-openrouter-key');
  expect(
    setupStatus({
      ...config,
      apiKey: undefined,
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
    }).missing,
  ).toContain('OPENROUTER_API_KEY');
});
it.each(['OPENROUTER_MUSEMODEL', 'OPENROUTER_MODEL'])(
  'rejects an async batch model in the live %s setting',
  (name) => {
    expect(() =>
      modelConfigFromEnv({ [name]: 'anthropic/claude-haiku-5.5:batch' }),
    ).toThrow('Live chat requires');
  },
);
it('keeps the Claude batch model independent of live chat', () => {
  expect(
    modelConfigFromEnv({
      OPENROUTER_CLAUDE_MODEL: 'anthropic/claude-haiku-5.5:batch',
    }).model,
  ).toBe('meta/muse-wonder');
  expect(
    modelConfigFromEnv({
      MODEL_PROVIDER: 'openrouter',
      OPENROUTER_MODEL: 'anthropic/claude-haiku-5.5',
      OPENROUTER_CLAUDE_MODEL: 'anthropic/claude-haiku-5.5:batch',
    }).model,
  ).toBe('anthropic/claude-haiku-5.5');
});
it('uses Grok 4.7 for every Dot when an xAI key is configured', () => {
  const config = modelConfigFromEnv({
    MODEL_PROVIDER: 'xai',
    XAI_API_KEY: 'private-xai-key',
    OPENAI_API_KEY: 'another-key',
  });
  expect(config).toEqual({
    modelProvider: 'xai',
    apiKey: 'private-xai-key',
    model: 'grok-4.7',
    baseUrl: 'https://api.x.ai/v1',
  });
  const status = setupStatus({
    ...config,
    intelligenceKey: 'project',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  expect(status.model).toBe(true);
  expect(status.modelName).toBe('grok-4.7');
  expect(JSON.stringify(status)).not.toContain('private-xai-key');
});
it('defaults every Dot to Muse through OpenRouter and keeps alternative keys separate', () => {
  const config = modelConfigFromEnv({
    OPENROUTER_API_KEY: 'private-router-key',
    XAI_API_KEY: 'different-provider-key',
    OPENAI_API_KEY: 'another-provider-key',
  });
  expect(config).toEqual({
    modelProvider: 'openrouter',
    model: 'meta/muse-wonder',
    apiKey: 'private-router-key',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
});
it('reports an OpenRouter key requirement and preserves the explicit OpenAI alternative', () => {
  const config = modelConfigFromEnv({});
  expect(config).toMatchObject({
    modelProvider: 'openrouter',
    model: 'meta/muse-wonder',
  });
  expect(
    setupStatus({
      ...config,
      voiceName: 'marin',
      slackUsers: [],
      runtimeUrl: '',
    }).missing,
  ).toContain('OPENROUTER_API_KEY');
  expect(
    modelConfigFromEnv({
      MODEL_PROVIDER: 'openai',
      XAI_API_KEY: 'x',
      OPENAI_API_KEY: 'o',
      OPENAI_MODEL: 'custom',
      OPENAI_BASE_URL: 'https://provider.invalid/v1',
    }),
  ).toMatchObject({
    apiKey: 'o',
    model: 'custom',
    baseUrl: 'https://provider.invalid/v1',
  });
  expect(() => modelConfigFromEnv({ MODEL_PROVIDER: 'other' })).toThrow(
    'MODEL_PROVIDER',
  );
});

it('prefers the trimmed Muse setting and retains legacy live model overrides', () => {
  expect(
    modelConfigFromEnv({
      OPENROUTER_MUSEMODEL: ' meta/muse-wonder ',
      OPENROUTER_MODEL: 'legacy-live-model',
      OPENROUTER_CLAUDE_MODEL: 'batch-only-model:batch',
      OPENROUTER_API_KEY: ' private-router-key ',
    }),
  ).toMatchObject({
    model: 'meta/muse-wonder',
    apiKey: 'private-router-key',
  });
  expect(
    modelConfigFromEnv({
      OPENROUTER_MUSEMODEL: '   ',
      OPENROUTER_MODEL: ' legacy-live-model ',
    }).model,
  ).toBe('legacy-live-model');
  expect(
    modelConfigFromEnv({
      OPENROUTER_MUSEMODEL: '   ',
      OPENROUTER_MODEL: '   ',
      OPENROUTER_CLAUDE_MODEL: 'anthropic/claude-haiku-5.5',
    }).model,
  ).toBe('meta/muse-wonder');
});

it('preserves explicit provider and model choices when Muse is configured', () => {
  expect(
    modelConfigFromEnv({
      MODEL_PROVIDER: 'xai',
      OPENROUTER_MUSEMODEL: 'meta/muse-wonder',
      OPENROUTER_API_KEY: 'router-key',
      XAI_API_KEY: 'xai-key',
      XAI_MODEL: 'custom-xai-model',
    }),
  ).toMatchObject({
    modelProvider: 'xai',
    apiKey: 'xai-key',
    model: 'custom-xai-model',
  });
});
