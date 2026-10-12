export interface BrowserUseConfig {
  browserUseApiKey?: string;
  clawdProfile?: string;
  cdpUrl?: string;
  browserUseWorkspaceId?: string;
  // Wallet-user runtimes keep provider files in their own persisted namespace.
  browserUseIsolatedWorkspace?: boolean;
  browserUseModel?: string;
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
  };
}
