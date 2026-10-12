import type { TradingFeeds } from '../../shared/trading-types.js';
export class LaunchFeed {
  constructor(options?: unknown);
  snapshot(): TradingFeeds;
  start(): Promise<void>;
  stop(): void;
}
export function normalize_launch(...args: unknown[]): unknown;
