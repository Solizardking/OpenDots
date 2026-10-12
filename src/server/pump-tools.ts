import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import {
  pumpLaunchSchema,
  pumpTradeSchema,
  pumpActionTool,
  type PumpReview,
} from '../shared/pump-types.js';
import type { PumpService } from './pump-service.js';

export const pumpReceipt = (review: PumpReview) => ({
  requestId: review.id,
  status: review.status,
  kind: review.kind,
  venue: review.venue,
  mint: review.mint,
  address: review.address,
  signerMode: review.signerMode ?? 'local',
  quoteMint: review.quoteMint,
  quoteLabel: review.quoteLabel,
  expectedOutput: review.expectedOutput,
  maximumQuote: review.maximumQuote,
  minimumOutput: review.minimumOutput,
  expiresAt: review.expiresAt,
  ...(review.signature ? { signature: review.signature } : {}),
  instruction: `Call ${pumpActionTool.name} with this requestId to show the exact transaction to the owner. Wait for wallet approval. Never request a passphrase, key or recovery phrase in chat.`,
});
export function pumpTools(
  pump: PumpService,
  threadId: string,
  check: () => void,
  approvalAvailable: boolean,
) {
  const unavailable = () => ({
    status: 'unavailable',
    message:
      'Open the Pump.fun panel in your workspace to review and approve a transaction.',
  });
  const guarded = async (work: () => Promise<unknown>) => {
    check();
    if (!approvalAvailable) return unavailable();
    try {
      const result = await work();
      check();
      return result;
    } catch {
      return {
        status: 'error',
        message:
          'Pump preparation failed. Check your signing wallet, funding, mint, metadata URI, amount and mainnet RPC. No transaction was signed or broadcast.',
      };
    }
  };
  return [
    defineTool({
      name: 'inspect_pump_token',
      description:
        'Read a Pump.fun coin’s actual quote asset, decimals, bonding curve or PumpSwap venue and wallet balance. Pass the user’s public connected Solana wallet address, or omit address to use the Dot’s encrypted local wallet. Never invent an address. Inspect before buying or selling. No signing.',
      parameters: z
        .object({
          mint: z.string().min(32).max(44),
          address: z.string().min(32).max(44).optional(),
        })
        .strict(),
      execute: ({ mint, address }) =>
        guarded(() =>
          address
            ? pump.connectedToken(threadId, mint, address)
            : pump.token(threadId, mint),
        ),
    }),
    defineTool({
      name: 'prepare_pump_launch',
      description:
        'Prepare a standard SOL-paired Token-2022 launch on Pump.fun. Pass the user’s public connected signing wallet address, or omit address for the Dot’s encrypted local wallet. Never invent an address or ask for wallet secrets. Requires a public metadata JSON URI. Optional initial buy and permanent holder rewards. No signing or broadcasting: call review_pump_transaction with the returned requestId and wait for the owner.',
      parameters: pumpLaunchSchema.extend({
        address: z.string().min(32).max(44).optional(),
      }),
      execute: ({ address, ...input }) =>
        guarded(async () =>
          pumpReceipt(
            await (address
              ? pump.prepareConnected(
                  threadId,
                  { kind: 'launch', input },
                  address,
                )
              : pump.prepare(threadId, { kind: 'launch', input })),
          ),
        ),
    }),
    defineTool({
      name: 'prepare_pump_trade',
      description:
        'Prepare a Pump.fun buy or sell. Pass the user’s public connected signing wallet address, or omit address for the Dot’s encrypted local wallet. Never invent an address. Inspect first and pass the actual quoteMint. Buy amount is in quote asset units; sell amount is in base token units. Uses current fees, slippage and migration state. No signing or broadcasting: call review_pump_transaction with the requestId.',
      parameters: pumpTradeSchema.extend({
        address: z.string().min(32).max(44).optional(),
      }),
      execute: ({ address, ...input }) =>
        guarded(async () =>
          pumpReceipt(
            await (address
              ? pump.prepareConnected(
                  threadId,
                  { kind: 'trade', input },
                  address,
                )
              : pump.prepare(threadId, { kind: 'trade', input })),
          ),
        ),
    }),
  ];
}
