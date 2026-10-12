import { z } from 'zod';
import { defineTool } from '@copilotkit/runtime/v2';
import {
  jupiterSwapSchema,
  jupiterPrepareSchema,
  jupiterActionTool,
} from '../shared/jupiter-types.js';
import type { JupiterService } from './jupiter-service.js';
export function jupiterTools(
  service: JupiterService,
  threadId: string,
  check: () => void,
  approvalAvailable: boolean,
) {
  const tools = [
    defineTool({
      name: 'jupiter_quote',
      description:
        'Read a current Jupiter managed swap quote without signing or broadcasting. Amount is in input token decimal units. Successful results are automatically rendered as an inline quote card, so the user can inspect them in chat. Managed Order uses all routers and automatic slippage by default. Quotes contain no signable transaction. Advanced Build requires a connected public address explicitly supplied by the user. Never invent an address.',
      parameters: jupiterSwapSchema.extend({
        address: z.string().min(32).max(44).optional(),
      }),
      execute: async ({ address, ...input }) => {
        check();
        try {
          const quote = await service.quote(input, address);
          check();
          return quote;
        } catch {
          return {
            status: 'error',
            message:
              'Jupiter quote is unavailable. Check mints, amount, liquidity and provider availability.',
          };
        }
      },
    }),
  ];
  if (approvalAvailable)
    return [
      ...tools,
      defineTool({
        name: 'prepare_jupiter_swap',
        description:
          'Prepare an immutable Jupiter swap for the user’s connected public Solana signing address. Never invent an address or ask for wallet secrets. Managed order uses Jupiter execution; advanced build supports fast mode, automatic RTSE or fixed slippage and maximum accounts. Version 0 only. Does not sign or submit: call review_jupiter_transaction with the returned requestId and wait for explicit wallet approval.',
        parameters: jupiterPrepareSchema,
        execute: async ({ input, address }) => {
          check();
          try {
            const review = await service.prepare(threadId, input, address);
            check();
            return {
              requestId: review.id,
              status: review.status,
              source: review.source,
              address: review.address,
              mode: review.mode,
              inputAmount: review.inputAmount,
              expectedOutput: review.expectedOutput,
              minimumOutput: review.minimumOutput,
              expiresAt: review.expiresAt,
              instruction: `Call ${jupiterActionTool.name} with this requestId. Wait for the user to review and sign in their connected wallet. Prepared and submitted are not confirmed.`,
            };
          } catch {
            return {
              status: 'error',
              message:
                'Swap preparation failed. Check wallet funding, mint addresses and mainnet RPC. No transaction was signed or submitted.',
            };
          }
        },
      }),
    ];
  return tools;
}
