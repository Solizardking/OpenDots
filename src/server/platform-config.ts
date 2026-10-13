import type { WebConfig } from './parallel.js';
import type { BrowserUseConfig } from './browser-use-config.js';
import type { SetupStatus } from '../shared/types.js';
import type { Mem0Config } from './dot-memory.js';
import type { OpenMarketService } from './openmarket-service.js';
import type { BirdeyeService } from './birdeye-service.js';
import type { BirdeyeStream } from './birdeye-stream.js';
import type { BirdeyeMcpService } from './birdeye-mcp.js';
import type { BirdeyeMemeService } from './birdeye-meme.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;

export function intelligenceApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, INTELLIGENCE_API_KEY_ENV_NAMES);
}

export function intelligenceWsUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, [
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
  ]);
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface PlatformConfig
  extends WebConfig, BrowserUseConfig, Mem0Config {
  modelProvider?: 'xai' | 'openai' | 'openrouter';
  openrouterApiKey?: string;
  openrouterClaudeModel?: string;
  xaiApiKey?: string;
  xaiImageModel?: string;
  owsVaultPath?: string;
  /** Local desktop transaction approval only. Disabled on hosted workspaces. */
  pumpEnabled?: boolean;
  /** Server-only trading provider configuration. Never serialized to the client. */
  tradingEnv?: Record<string, string | undefined>;
  solanaRpcUrl?: string;
  computerProvider?: 'e2b' | 'openbot';
  e2bApiKey?: string;
  e2bTemplate?: string;
  e2bTimeoutMs?: number;
  intelligenceKey?: string;
  openMarket?: OpenMarketService;
  /** Account-scoped provider cache and rate budgets. Never serialized. */
  birdeye?: BirdeyeService;
  /** Account-scoped upstream socket; consumers remain workspace-scoped. */
  birdeyeStream?: BirdeyeStream;
  /** Fixed server-authenticated MCP and REST data reads. Never serialized. */
  birdeyeMcp?: BirdeyeMcpService;
  birdeyeMeme?: BirdeyeMemeService;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  browserUrl?: string;
  browserSecret?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
  /** Server-only boundary for public wallet users' connected MCP endpoints. */
  publicMcp?: boolean;
}
export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.apiKey &&
      (config.modelProvider === 'xai'
        ? 'XAI_API_KEY'
        : config.modelProvider === 'openrouter'
          ? 'OPENROUTER_API_KEY'
          : 'OPENAI_API_KEY'),
    !config.model &&
      (config.modelProvider === 'xai'
        ? 'XAI_MODEL'
        : config.modelProvider === 'openrouter'
          ? 'OPENROUTER_MUSEMODEL'
          : 'OPENAI_MODEL'),
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.intelligenceKey &&
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    intelligence: !!config.intelligenceKey,
    model: !!(config.apiKey && config.model),
    modelName: config.model,
    avatarGeneration: !!config.xaiApiKey,
    browser: !!(
      config.browserUseApiKey ||
      (config.browserUrl && config.browserSecret)
    ),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    slack,
    missing,
  };
}
