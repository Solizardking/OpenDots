import { z } from 'zod';

export const birdeyeWorkflows = [
  'portfolio',
  'pnl-comparison',
  'search',
  'investigation',
  'rug-check',
  'wash-trading',
  'cross-dex',
  'liquidity',
  'chart',
  'history',
  'price-stats',
  'trending',
  'screener',
  'new-listings',
  'watchlist',
  'whales',
  'smart-money',
  'wallet-history',
  'credits',
] as const;
export type BirdeyeWorkflow = (typeof birdeyeWorkflows)[number];
export const birdeyeAddressSchema = z
  .string()
  .trim()
  .regex(
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    'Enter a Solana mint or wallet address.',
  );
export const birdeyeIntervals = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1H',
  '2H',
  '4H',
  '6H',
  '8H',
  '12H',
  '1D',
  '3D',
  '1W',
  '1M',
] as const;
export const birdeyeQuerySchema = z
  .object({
    workflow: z.enum(birdeyeWorkflows),
    address: birdeyeAddressSchema.optional(),
    wallets: z.array(birdeyeAddressSchema).min(1).max(50).optional(),
    addresses: z.array(birdeyeAddressSchema).min(1).max(100).optional(),
    keyword: z.string().trim().min(1).max(100).optional(),
    interval: z.enum(birdeyeIntervals).optional(),
    timeFrom: z.number().int().min(0).max(10_000_000_000).optional(),
    timeTo: z.number().int().min(0).max(10_000_000_000).optional(),
    before: z.number().int().min(0).max(10_000_000_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
    minLiquidity: z.number().finite().min(0).max(1e12).optional(),
    minVolume: z.number().finite().min(0).max(1e12).optional(),
    minHolders: z.number().int().min(0).max(10_000_000).optional(),
    thresholdPercent: z.number().finite().min(0.1).max(1000).optional(),
    duration: z.enum(['1d', '7d', '30d', '90d', 'all']).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const tokenOrWallet = ![
      'search',
      'trending',
      'screener',
      'new-listings',
      'watchlist',
      'smart-money',
      'credits',
    ].includes(input.workflow);
    if (tokenOrWallet && !input.address)
      context.addIssue({
        code: 'custom',
        path: ['address'],
        message: 'This workflow requires a Solana address.',
      });
    if (input.workflow === 'search' && !input.keyword)
      context.addIssue({
        code: 'custom',
        path: ['keyword'],
        message: 'Enter a token name, symbol, or mint.',
      });
    if (input.workflow === 'pnl-comparison' && !input.wallets?.length)
      context.addIssue({
        code: 'custom',
        path: ['wallets'],
        message: 'Provide the wallets to compare.',
      });
    if (input.workflow === 'watchlist' && !input.addresses?.length)
      context.addIssue({
        code: 'custom',
        path: ['addresses'],
        message: 'Add at least one token mint.',
      });
    if (
      input.timeFrom !== undefined &&
      input.timeTo !== undefined &&
      input.timeFrom >= input.timeTo
    )
      context.addIssue({
        code: 'custom',
        path: ['timeFrom'],
        message: 'The start time must be earlier than the end time.',
      });
  });
export type BirdeyeQuery = z.infer<typeof birdeyeQuerySchema>;
export interface BirdeyeResult {
  source: 'Birdeye';
  workflow: BirdeyeWorkflow;
  observedAt: number;
  data: Record<string, unknown>;
  warnings: string[];
  partial?: boolean;
  /** Oldest provider response used in this view, including cached responses. */
  fetchedAt?: number;
  requestedAt?: number;
  cacheAgeMs?: number;
}
export interface BirdeyeStatus {
  configured: boolean;
  chain: 'solana';
  source: 'Birdeye';
  state:
    | 'ready'
    | 'missing-configuration'
    | 'quota-limited'
    | 'tier-unavailable'
    | 'authentication-error'
    | 'unavailable';
  message: string;
  walletLimits: { perSecond: 5; perMinute: 75 };
  credits?: { remaining: number | null; checkedAt: number; low: boolean };
  lastEndpointFailure?: { path: string; code: string; checkedAt: number };
}
