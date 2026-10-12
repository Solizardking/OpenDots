import { expect, it } from 'vitest';
import { modelConfigFromEnv } from '../src/server/model-config.js';
import { setupStatus } from '../src/server/platform-config.js';
it('routes Claude chat to OpenRouter and keeps its key out of setup status', () => {
  const config = modelConfigFromEnv({
    MODEL_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'private-openrouter-key',
    OPENROUTER_CLAUDE_MODEL: 'anthropic/claude-haiku-5.5',
  });
  expect(config).toEqual({
    modelProvider: 'openrouter',
    apiKey: 'private-openrouter-key',
    model: 'anthropic/claude-haiku-5.5',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
  const status = setupStatus({
    ...config,
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
  });
  expect(status.model).toBe(true);
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
it('prevents accidentally routing async batch models through live chat', () => {
  expect(() =>
    modelConfigFromEnv({
      MODEL_PROVIDER: 'openrouter',
      OPENROUTER_CLAUDE_MODEL: 'anthropic/claude-haiku-5.5:batch',
    }),
  ).toThrow('Live chat requires');
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
it('defaults every Dot to Claude through OpenRouter and keeps alternative keys separate', () => {
  const config = modelConfigFromEnv({
    OPENROUTER_API_KEY: 'private-router-key',
    XAI_API_KEY: 'different-provider-key',
    OPENAI_API_KEY: 'another-provider-key',
  });
  expect(config).toEqual({
    modelProvider: 'openrouter',
    model: 'anthropic/claude-haiku-5.5',
    apiKey: 'private-router-key',
    baseUrl: 'https://openrouter.ai/api/v1',
  });
});
it('reports an OpenRouter key requirement and preserves the explicit OpenAI alternative', () => {
  const config = modelConfigFromEnv({});
  expect(config).toMatchObject({
    modelProvider: 'openrouter',
    model: 'anthropic/claude-haiku-5.5',
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
