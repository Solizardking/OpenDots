import { z } from 'zod';

export const dflowQuoteInput = z
  .object({
    mint: z.string().trim().min(32).max(44),
    side: z.enum(['buy', 'sell']),
    amount: z
      .string()
      .trim()
      .regex(/^\d{1,12}(?:\.\d{1,18})?$/),
    slippageBps: z.number().int().min(1).max(500).default(50),
  })
  .strict();

export const dflowQuoteSchema = z.object({
  source: z.literal('DFlow'),
  mint: z.string(),
  side: z.enum(['buy', 'sell']),
  inputMint: z.string(),
  outputMint: z.string(),
  inputDecimals: z.number().int(),
  outputDecimals: z.number().int(),
  inAmount: z.string(),
  outAmount: z.string(),
  minimumOutput: z.string(),
  slippageBps: z.number().int(),
  platformFeeSol: z.string(),
  platformFeeBps: z.number().int(),
  observedAt: z.number(),
  expiresAt: z.number(),
  executionAvailable: z.literal(false),
});
export type DflowQuoteInput = z.infer<typeof dflowQuoteInput>;
export type DflowQuote = z.infer<typeof dflowQuoteSchema>;

export function percentageBasisPoints(value: string) {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value))
    throw new Error('Use a percentage with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function displayUnits(value: string, decimals: number) {
  const padded = value.padStart(decimals + 1, '0');
  return decimals
    ? `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`.replace(
        /\.?0+$/,
        '',
      )
    : padded;
}
