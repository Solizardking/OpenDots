import { defineTool, type ToolDefinition } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import { birdeyeQuerySchema } from '../shared/birdeye-types.js';
import { BirdeyeError, type BirdeyeService } from './birdeye-service.js';
import { birdeyeAlertSchema, type BirdeyeMonitor } from './birdeye-monitor.js';

export function birdeyeTools(
  service: BirdeyeService,
  check: () => void,
  signal?: AbortSignal,
  monitor?: BirdeyeMonitor,
  threadId?: string,
) {
  const allowed = () => {
    check();
    signal?.throwIfAborted();
  };
  const read = async (operation: () => Promise<unknown>) => {
    allowed();
    try {
      const result = await operation();
      allowed();
      return result;
    } catch (error) {
      allowed();
      return {
        source: 'Birdeye',
        error:
          error instanceof BirdeyeError
            ? error.message
            : 'Birdeye research is temporarily unavailable.',
        ...(error instanceof BirdeyeError
          ? { status: error.status, code: error.code }
          : {}),
      };
    }
  };
  const tools: ToolDefinition[] = [
    defineTool({
      name: 'birdeye_status',
      description:
        'Check the server-side Birdeye connection and last known credit/entitlement state. Does not expose credentials or spend credits. Configured does not prove access to a paid endpoint.',
      parameters: z.object({}).strict(),
      execute: async () => {
        allowed();
        return service.status();
      },
    }),
    defineTool({
      name: 'birdeye_research',
      description:
        'Research Solana with Birdeye. workflow search resolves keyword to canonical mints; never silently choose among ambiguous symbols. portfolio takes a public wallet address and returns holdings, net worth history and PnL; wallet-history verifies all-time cumulative track record and recent trades. pnl-comparison takes token address plus wallets. investigation fetches market/chart/ownership/behavior/traders/fees/security/supply with partial errors. rug-check and wash-trading return heuristic evidence with unavailable signals. cross-dex compares the deepest pools in USD against a consolidated mark and confirms several closed candles; liquidity aligns price with the deepest pool liquidity/balances and explains flagged drains. chart/history/price-stats take token address and interval/timeFrom/timeTo or before for older history. trending/screener/new-listings discover tokens, with server-side minLiquidity/minVolume/minHolders filters and risk gates on new listings. watchlist batches addresses (max100) and preserves unknown prices as null. whales takes token address and minVolume. smart-money returns a research watchlist sorted by net flow. credits reads account credit usage. Unix times use seconds; observedAt uses milliseconds. Never infer safety or fill/exit guarantees from a score or liquidity. This tool only reads data; trades still need explicit wallet review and approval.',
      parameters: birdeyeQuerySchema,
      execute: (input) => read(() => service.read(input, signal)),
    }),
  ];
  if (monitor && threadId) {
    tools.push(
      defineTool({
        name: 'birdeye_create_alert',
        description:
          'Only when the user explicitly requests it, save a persistent Solana price alert in this conversation. Absolute threshold is USD; percent is a signed percentage over timeframe or since baselineUnixTime. Alerts are debounced, skip stale quotes and confirm a closed candle before firing. The first check rebuilds crossing state without firing. Background monitoring starts for enabled alerts, consuming Birdeye credits. No trade execution or external notifications.',
        parameters: birdeyeAlertSchema.omit({ threadId: true }),
        execute: (input) =>
          read(async () => ({ alert: monitor.create({ ...input, threadId }) })),
      }),
      defineTool({
        name: 'birdeye_alerts',
        description:
          'Read this conversation’s saved Birdeye alerts, or check them now when requested. Events are data signals and never trading receipts.',
        parameters: z.object({ poll: z.boolean().default(false) }).strict(),
        execute: ({ poll }) =>
          read(async () =>
            poll
              ? monitor.poll(threadId)
              : {
                  source: 'Birdeye',
                  alerts: monitor.list(threadId),
                  events: monitor.events(threadId),
                },
          ),
      }),
      defineTool({
        name: 'birdeye_remove_alert',
        description:
          'Remove an alert from this conversation only when the user requests it. Use an id returned by birdeye_alerts.',
        parameters: z.object({ id: z.string().uuid() }).strict(),
        execute: ({ id }) =>
          read(async () => ({
            source: 'Birdeye',
            removed: monitor.remove(id, threadId),
          })),
      }),
    );
  }
  return tools;
}
