import { z } from 'zod';

/** Convert user percentages without floating-point multiplication. */
export function pumpSlippageBps(value: string) {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(value.trim());
  const bps = match
    ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
    : NaN;
  if (!Number.isInteger(bps) || bps < 0 || bps > 2000 || bps % 10)
    throw Error('Use slippage from 0% to 20% in 0.1% steps.');
  return bps;
}

const decimal = z
  .string()
  .trim()
  .regex(
    /^\d+(?:\.\d{1,18})?$/,
    'Enter a decimal amount without exponent notation.',
  )
  .max(60);
const pubkey = z.string().trim().min(32).max(44);
export const pumpLaunchSchema = z
  .object({
    name: z.string().trim().min(1).max(32),
    symbol: z.string().trim().min(1).max(13),
    uri: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine(
        (value) => /^(https:\/\/|ipfs:\/\/|ar:\/\/)/i.test(value),
        'Use an HTTPS, IPFS or Arweave metadata URI.',
      ),
    initialBuySol: decimal.default('0'),
    holderReward: z.boolean().default(false),
    slippageBps: z.number().int().min(0).max(2000).multipleOf(10).default(100),
  })
  .strict();
export const pumpTradeSchema = z
  .object({
    mint: pubkey,
    side: z.enum(['buy', 'sell']),
    amount: decimal,
    // Buying uses units of the coin's quote asset, selling uses units of its base token.
    quoteMint: pubkey,
    slippageBps: z.number().int().min(0).max(2000).multipleOf(10).default(100),
  })
  .strict();
export type PumpLaunch = z.infer<typeof pumpLaunchSchema>;
export type PumpTrade = z.infer<typeof pumpTradeSchema>;
export type PumpIntent =
  { kind: 'launch'; input: PumpLaunch } | { kind: 'trade'; input: PumpTrade };
export type PumpStatus =
  | 'prepared'
  | 'signing'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'declined';
export interface PumpReview {
  id: string;
  threadId: string;
  dotId: string;
  walletId: string;
  walletName: string;
  address: string;
  /** Legacy records use the encrypted local Dot wallet. Connected wallets sign only in the browser. */
  signerMode?: 'local' | 'connected';
  network: 'solana-mainnet';
  kind: 'launch' | 'buy' | 'sell';
  venue: 'Pump bonding curve' | 'PumpSwap';
  mint: string;
  quoteMint: string;
  quoteLabel: string;
  name?: string;
  symbol?: string;
  uri?: string;
  holderReward?: boolean;
  inputAmount: string;
  expectedOutput: string;
  minimumOutput: string;
  maximumQuote: string;
  slippageBps: number;
  networkFeeSol: string;
  estimatedSolDebit: string;
  balanceSol: string;
  expiresAt: number;
  lastValidBlockHeight: number;
  transactionBase64: string;
  transactionHash: string;
  instructions: {
    program: string;
    accounts: { address: string; signer: boolean; writable: boolean }[];
    dataBase64: string;
  }[];
  status: PumpStatus;
  signature?: string;
  error?: string;
}
export interface PumpToken {
  mint: string;
  quoteMint: string;
  quoteLabel: string;
  decimals: number;
  quoteDecimals: number;
  venue: PumpReview['venue'];
  balance: string;
  solBalance: string;
  address: string;
}
export const pumpActionSchema = z
  .object({ requestId: z.string().uuid() })
  .strict();
export const pumpActionTool = {
  name: 'review_pump_transaction',
  description:
    'Show the owner the exact prepared Pump.fun launch or trade. Use only a requestId returned by prepare_pump_launch or prepare_pump_trade. The owner reviews and approves in their connected wallet, or unlocks their encrypted local Dot wallet in this card. Never ask for wallet secrets in chat. Wait for its result; a prepared or submitted transaction is not confirmed.',
  parameters: z.toJSONSchema(pumpActionSchema),
};
