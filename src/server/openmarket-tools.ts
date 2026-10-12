import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  openMarketService,
  OpenMarketError,
  type OpenMarketService,
} from './openmarket-service.js';

export function openMarketTools(
  check: () => void,
  signal?: AbortSignal,
  service: OpenMarketService = openMarketService,
) {
  return [
    defineTool({
      name: 'openmarket_data',
      description:
        'Read OpenMarket crypto and Polymarket analytics. Research only. Use status to check configuration, markets with type and coin to discover an exact exchange/rawSymbol, then points with type, exchange/rawSymbol (or coin for Hyperliquid), interval MINUTE/HOUR/DAY, from UNIX seconds and period seconds. At most 200 candles or 20 heatmap snapshots. Orderbook needs block-sizes discovery, blockSize and maxDepth up to 1000. Cross-exchange volume uses comma-separated exchange IDs, coin and transform.groupBy.type=GROUP_BY_TYPE_SUM, returns USD volume rather than price OHLC. Polymarket leaderboard supports winRate, minTotalTradeCount, maxTotalTradeCount, openPositionCount, primaryCategory, sortBy ROI/REALIZED_PNL/TOTAL_SIZE/TOTAL_POSITION_COUNT, sortDirection SORT_DIRECTION_ASC/SORT_DIRECTION_DESC, limit 1–100, offset; trader-profile needs full userWallet. Always report source and observation time. Permission/quota errors are actual provider limits. No signing, order execution or account changes.',
      parameters: z.object({
        route: z.enum([
          'status',
          'markets',
          'points',
          'block-sizes',
          'leaderboard',
          'trader-profile',
          'positions',
          'market-summary',
          'user-categories',
          'platform-summary',
          'platform-distribution',
        ]),
        query: z.record(z.string(), z.string()).default({}),
      }),
      execute: async ({ route, query }) => {
        check();
        if (signal?.aborted)
          throw new Error('The market-data request was cancelled.');
        try {
          const result = await service.read(route, new URLSearchParams(query));
          check();
          if (signal?.aborted)
            throw new Error('The market-data request was cancelled.');
          return result;
        } catch (error) {
          check();
          return {
            error:
              error instanceof OpenMarketError
                ? error.message
                : 'OpenMarket is unavailable.',
            source: 'OpenMarket',
            ...(error instanceof OpenMarketError
              ? { status: error.status }
              : {}),
          };
        }
      },
    }),
  ];
}
