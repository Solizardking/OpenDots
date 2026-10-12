import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { tradingStrategySchema } from '../shared/trading-types.js';
import type { TradingService } from './trading-service.js';
export function tradingTools(
  service: TradingService,
  dotId: string,
  check: () => void,
) {
  const guarded = async (work: () => Promise<unknown>) => {
    check();
    const result = await work();
    check();
    return result;
  };
  return [
    defineTool({
      name: 'save_trading_strategy',
      description:
        'Persist the user’s natural-language Pump.fun trading strategy for this Dot. Use the exact token mint and user limits. This does not start monitoring or sign a trade.',
      parameters: tradingStrategySchema,
      execute: (input) => guarded(() => service.save(dotId, input)),
    }),
    defineTool({
      name: 'trading_brain',
      description:
        'Use Supermemory graph recall and TypeSafe typed decisions to evaluate the saved strategy, compare both realtime feeds, recall prior decisions, or explain observed paper outcomes. Read-only. Never execute a trade. If gate is wallet_review, offer the existing Pump.fun panel and its explicit wallet approval.',
      parameters: z.object({ command: z.string().min(3).max(1000) }).strict(),
      execute: (input) => guarded(() => service.evaluate(dotId, input)),
    }),
    defineTool({
      name: 'trading_journal',
      description:
        'Inspect this Dot’s persisted strategy, decision evidence, private memory graph, and adaptive confidence threshold. Paper outcomes are price observations excluding fees and execution; they are not realized profit.',
      parameters: z.object({}).strict(),
      execute: () => guarded(() => service.view(dotId)),
    }),
    defineTool({
      name: 'monitor_trading_strategy',
      description:
        'Start or pause one hour of read-only monitoring of this Dot’s saved strategy. Only start when the user explicitly requests monitoring. Runs once a minute, at most 60 decisions per Dot per day, with provider usage. Continues while the app server runs after closing the panel. Does not sign or execute trades.',
      parameters: z.object({ enabled: z.boolean() }).strict(),
      execute: ({ enabled }) => guarded(() => service.monitor(dotId, enabled)),
    }),
  ];
}
