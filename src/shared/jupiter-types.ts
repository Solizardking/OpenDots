import { z } from 'zod';

const publicKey = z.string().trim().min(32).max(44);
export const jupiterSwapSchema = z
  .object({
    inputMint: publicKey,
    outputMint: publicKey,
    amount: z
      .string()
      .trim()
      .regex(/^\d+(?:\.\d{1,18})?$/)
      .max(60),
    mode: z.enum(['order', 'build']).default('order'),
    slippageBps: z
      .union([z.literal('rtse'), z.number().int().min(0).max(500)])
      .default('rtse'),
    fast: z.boolean().default(false),
    maxAccounts: z.number().int().min(1).max(64).default(64),
  })
  .strict();
export const jupiterQuoteSchema = z
  .object({ input: jupiterSwapSchema, address: publicKey.optional() })
  .strict();
export const jupiterPrepareSchema = z
  .object({ input: jupiterSwapSchema, address: publicKey })
  .strict();
export type JupiterSwap = z.infer<typeof jupiterSwapSchema>;
export type JupiterStatus =
  'prepared' | 'submitted' | 'confirmed' | 'failed' | 'expired' | 'declined';
export interface JupiterAvailability {
  configured: boolean;
  source: 'Jupiter';
  supportedTransactionVersions: [0];
  message: string;
}
export interface JupiterQuote {
  source: 'Jupiter';
  network: 'solana-mainnet';
  mode: 'order' | 'build';
  input: JupiterSwap;
  inputMint: string;
  outputMint: string;
  inputDecimals: number;
  outputDecimals: number;
  inputAmount: string;
  expectedOutput: string;
  minimumOutput: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  router: string;
  slippageBps: number;
  priceImpactPercent?: string;
  feeBps: number;
  feeMint?: string;
  platformFeeBps: number;
  platformFeeAmount?: string;
  gasless: boolean;
  signatureFeeLamports: string;
  prioritizationFeeLamports: string;
  rentFeeLamports: string;
  signatureFeePayer?: string;
  prioritizationFeePayer?: string;
  rentFeePayer?: string;
  route: {
    label: string;
    inputMint: string;
    outputMint: string;
    percent?: number;
  }[];
  observedAt: number;
  expiresAt: number;
  /** Quote cards never contain a signable transaction. */
  executionAvailable: boolean;
  transactionVersion?: 0;
  preparationError?: string;
}
export interface JupiterInstruction {
  program: string;
  accounts: { address: string; signer: boolean; writable: boolean }[];
  dataBase64: string;
}
export interface JupiterReview extends JupiterQuote {
  id: string;
  threadId: string;
  dotId: string;
  address: string;
  feePayer: string;
  transactionVersion: 0;
  transactionBase64: string;
  /** SHA-256 of the exact original serialized transaction, including existing signatures. */
  transactionHash: string;
  requiredSigners: string[];
  deferredSigners: string[];
  instructions: JupiterInstruction[];
  lastValidBlockHeight?: number;
  balanceSol: string;
  inputBalance: string;
  networkFeeSol: string;
  estimatedSolDebit: string;
  simulation: { status: 'passed'; unitsConsumed?: number };
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: string;
  computeUnitPriceCeilingMicroLamports: string;
  status: JupiterStatus;
  signature?: string;
  providerCode?: number;
  error?: string;
}
export const jupiterActionSchema = z
  .object({ requestId: z.string().uuid() })
  .strict();
export const jupiterActionTool = {
  name: 'review_jupiter_transaction',
  description:
    'Show the immutable Jupiter transaction prepared for the user’s connected wallet. Use only a requestId returned by prepare_jupiter_swap. The user must review and explicitly sign in their wallet. Never request wallet secrets. Submitted transactions require independent on-chain confirmation.',
  parameters: z.toJSONSchema(jupiterActionSchema),
};
