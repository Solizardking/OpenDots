export const DEFAULT_XAI_MODEL = 'grok-4.7';
export const DEFAULT_XAI_IMAGE_MODEL = 'grok-imagine-image-2.0';
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-haiku-5.5';

/** Provider credentials are resolved once, on the server, for every specialist. */
export function modelConfigFromEnv(env: Record<string, string | undefined>) {
  const provider = env.MODEL_PROVIDER?.trim() || 'openrouter';
  if (!['xai', 'openai', 'openrouter'].includes(provider))
    throw new Error('MODEL_PROVIDER must be xai, openai, or openrouter.');
  if (provider === 'openrouter') {
    const model =
      env.OPENROUTER_MODEL?.trim() ||
      env.OPENROUTER_CLAUDE_MODEL?.trim() ||
      DEFAULT_OPENROUTER_MODEL;
    if (model.endsWith(':batch'))
      throw new Error(
        'Live chat requires a model without :batch. Set OPENROUTER_MODEL for live chat; use OPENROUTER_CLAUDE_MODEL for batches.',
      );
    return {
      modelProvider: 'openrouter' as const,
      apiKey: env.OPENROUTER_API_KEY?.trim(),
      model,
      baseUrl: 'https://openrouter.ai/api/v1',
    };
  }
  return provider === 'xai'
    ? {
        modelProvider: 'xai' as const,
        apiKey: env.XAI_API_KEY?.trim(),
        model: env.XAI_MODEL?.trim() || DEFAULT_XAI_MODEL,
        baseUrl: 'https://api.x.ai/v1',
      }
    : {
        modelProvider: 'openai' as const,
        apiKey: env.OPENAI_API_KEY?.trim(),
        model: env.OPENAI_MODEL?.trim(),
        baseUrl: env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
      };
}
