export interface CloudBrowser {
  id: string;
  status: 'active' | 'stopped';
  liveUrl?: string | null;
  recordingUrl?: string | null;
  recordingAvailable?: boolean;
  timeoutAt: string;
}
export interface CloudRun {
  id: string;
  sessionId: string;
  workspaceId: string | null;
  status:
    'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: string | null;
  error?: string | null;
  totalCostUsd?: string;
  browser?: CloudBrowser;
}
export interface BrowserUseState {
  enabled: boolean;
  browser?: CloudBrowser;
  run?: CloudRun;
}
export interface BrowserUseStatus extends BrowserUseState {
  configured: boolean;
  model: string;
  profileConfigured: boolean;
  suppliedCdpConfigured: boolean;
}
export const cloudRunFinished = (status: CloudRun['status']) =>
  ['completed', 'failed', 'cancelled'].includes(status);
