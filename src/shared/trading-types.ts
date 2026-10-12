import { z } from 'zod';
export const tradingStrategySchema = z
  .object({
    prompt: z.string().trim().min(10).max(2000),
    mint: z.string().min(32).max(44),
    maxSol: z.number().min(0.001).max(0.1),
    minLiquidityUsd: z.number().min(20000).max(100000000),
    confidence: z.number().min(0.8).max(0.99),
  })
  .strict();
export type TradingStrategyInput = z.infer<typeof tradingStrategySchema>;
export interface TradingStrategy extends TradingStrategyInput {
  version: string;
  savedAt: number;
  monitorUntil: number | null;
}
export interface TradingAnswers {
  action: {
    choice: 'buy' | 'sell' | 'wait' | 'avoid';
    confidence: number;
    probabilities: Record<string, number>;
  };
  risk: { normalized: number; confidence: number };
  strategy_match: { noul: number };
  evidence_sufficient: { noul: number };
}
export interface TradingLearning {
  samples: number;
  losses: number;
  threshold: number;
  method: string;
  modelTraining: false;
}
export interface TradingRecord {
  id: string;
  type: string;
  created_at: number;
  sync_status: string;
  data: {
    mint?: string;
    answers?: TradingAnswers;
    gate?: string;
    reasons?: string[];
    model?: string;
    evaluatedAt?: number;
    strategyVersion?: string;
    command?: string;
    dispatch?: { function: string; confidence: number; result?: unknown };
    market?: {
      mint: string;
      priceUsd: number;
      liquidityUsd: number;
      observedAt: number;
    };
    learning?: TradingLearning;
    directionalReturnPct?: number;
    realizedProfit?: boolean;
    [key: string]: unknown;
  };
}
export interface TradingView {
  strategy: TradingStrategy | null;
  records: TradingRecord[];
  learning: TradingLearning;
  graph: {
    nodes: { id: string; label: string; type: string }[];
    edges: { from: string; to: string; kind: string }[];
  };
}
export interface TradingFeeds {
  sources: {
    id: string;
    url: string;
    status: string;
    healthStatus: string | null;
    lastEventAt: number | null;
    message: string;
  }[];
  events: {
    id: string;
    source: string;
    type: string;
    mint: string;
    name: string;
    symbol: string;
    receivedAt: number;
  }[];
}
export interface TradingConfig {
  memoryConfigured: boolean;
  decisionsConfigured: boolean;
  persistenceConfigured: boolean;
  autoExecute: false;
  model: string;
  feeds: TradingFeeds;
}
