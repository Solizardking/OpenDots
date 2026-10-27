export interface BrowserUseConfig {
  browserUseApiKey?: string;
  clawdProfile?: string;
  cdpUrl?: string;
  browserUseWorkspaceId?: string;
  // Wallet-user runtimes keep provider files in their own persisted namespace.
  browserUseIsolatedWorkspace?: boolean;
  /** Hosted Browser Use Cloud model, used only when browserUseLlmProvider is 'browser-use'. */
  browserUseModel?: string;
  /** Who drives the browser: 'xai' (local agent, XAI_API_KEY, default) or 'browser-use' (hosted V4 agent). */
  browserUseLlmProvider?: 'xai' | 'browser-use';
  browserUseXaiApiKey?: string;
  browserUseXaiModel?: string;
}
export function browserUseConfigFromEnv(
  env: Record<string, string | undefined>,
): BrowserUseConfig {
  return {
    browserUseApiKey:
      env.BROWSERUSE_API_KEY?.trim() ||
      env.BROWSER_USE_API_KEY?.trim() ||
      undefined,
    clawdProfile: env.CLAWD_PROFILE?.trim() || undefined,
    cdpUrl: env.CDP_URL?.trim() || undefined,
    browserUseWorkspaceId: env.BROWSER_USE_WORKSPACE_ID?.trim() || undefined,
    browserUseModel: env.BROWSER_USE_MODEL?.trim() || 'gpt-6-luna',
    browserUseLlmProvider:
      env.BROWSER_USE_LLM_PROVIDER?.trim() === 'browser-use'
        ? 'browser-use'
        : 'xai',
    browserUseXaiApiKey: env.XAI_API_KEY?.trim() || undefined,
    browserUseXaiModel:
      env.BROWSER_USE_XAI_MODEL?.trim() || env.XAI_MODEL?.trim() || 'grok-4.7',
  };
}
