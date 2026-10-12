export interface CompanionState {
  remote?: { connected: boolean; id: string; origin: string };
  enabled: boolean;
  urls: string[];
  pairing: { code: string; token: string; expiresAt: number } | null;
  devices: {
    id: string;
    name: string;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
  }[];
  keepAwake: boolean;
}
export interface DesktopSettings {
  values: Record<string, string>;
  configured: string[];
  version: string;
}
export interface DesktopBridge {
  platform: string;
  session(): Promise<{ token: string }>;
  settings(): Promise<DesktopSettings>;
  saveSettings(values: Record<string, string>): Promise<void>;
  companion(action: string, value?: string): Promise<CompanionState>;
  keepAwake(enabled: boolean): Promise<CompanionState>;
  onAction(callback: (action: string) => void): () => void;
}
declare global {
  interface Window {
    solanaDots?: DesktopBridge;
  }
}
