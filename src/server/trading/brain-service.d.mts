import type {
  TradingStrategyInput,
  TradingStrategy,
  TradingView,
  TradingRecord,
  TradingConfig,
} from '../../shared/trading-types.js';
export class BrainService {
  constructor(options: {
    store?: unknown;
    feeds?: unknown;
    providers?: unknown;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    allowed?: (scope: string) => boolean;
  });
  config(): TradingConfig;
  view(scope: string): Promise<TradingView>;
  save(scope: string, input: TradingStrategyInput): Promise<TradingStrategy>;
  monitor(
    scope: string,
    input: { enabled: boolean },
  ): Promise<{ strategy: TradingStrategy }>;
  evaluate(
    scope: string,
    input?: { requestId?: string; command?: string },
  ): Promise<TradingRecord>;
  start(): void;
  tick(): Promise<void>;
  sync(): Promise<void>;
  stop(): Promise<void>;
}
export function learning_state(
  records: TradingRecord[],
  strategy: TradingStrategy | null,
): unknown;
export function decision_gate(...args: unknown[]): unknown;
