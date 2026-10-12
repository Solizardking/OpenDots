import {
  Connection,
  PublicKey,
  type AddressLookupTableAccount,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import type {
  JupiterSwap,
  JupiterQuote,
  JupiterReview,
} from '../shared/jupiter-types.js';

export class JupiterError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const ORIGIN = 'https://api.jup.ag/swap/v2';
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const MAX_CU = 1_400_000;
export const JUPITER_CU_PRICE_CEILING = 10_000_000n;
const uint = z
  .union([
    z.string().regex(/^\d+$/).max(20),
    z.number().int().nonnegative().refine(Number.isSafeInteger),
  ])
  .transform(String)
  .refine((value) => BigInt(value) <= (1n << 64n) - 1n);
const instructionSchema = z.object({
  programId: z.string(),
  accounts: z
    .array(
      z.object({
        pubkey: z.string(),
        isSigner: z.boolean(),
        isWritable: z.boolean(),
      }),
    )
    .max(64),
  data: z.string().max(4096),
});
const responseSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: uint,
  outAmount: uint,
  otherAmountThreshold: uint,
  swapMode: z.literal('ExactIn'),
  slippageBps: z.number().int().min(0).max(10000),
  router: z.string().optional(),
  transaction: z.string().max(1644).nullable().optional(),
  transactionVersion: z.number().optional(),
  requestId: z.string().max(256).optional(),
  taker: z.string().nullable().optional(),
  maker: z.string().optional(),
  lastValidBlockHeight: uint.optional(),
  expireAt: z.string().optional(),
  feeBps: z.number().nonnegative().max(10000).optional(),
  feeMint: z.string().optional(),
  platformFee: z
    .object({
      feeBps: z.number().nonnegative().max(10000),
      feeMint: z.string().optional(),
      amount: uint.optional(),
    })
    .nullable()
    .optional(),
  signatureFeeLamports: uint.optional(),
  prioritizationFeeLamports: uint.optional(),
  rentFeeLamports: uint.optional(),
  signatureFeePayer: z.string().nullable().optional(),
  prioritizationFeePayer: z.string().nullable().optional(),
  rentFeePayer: z.string().nullable().optional(),
  gasless: z.boolean().optional(),
  priceImpact: z.union([z.string(), z.number()]).optional(),
  priceImpactPct: z.union([z.string(), z.number()]).optional(),
  errorCode: z.number().optional(),
  routePlan: z
    .array(
      z.object({
        percent: z.number().optional(),
        swapInfo: z.object({
          label: z.string().optional(),
          inputMint: z.string(),
          outputMint: z.string(),
        }),
      }),
    )
    .max(64),
  computeBudgetInstructions: z.array(instructionSchema).max(8).optional(),
  setupInstructions: z.array(instructionSchema).max(32).optional(),
  swapInstruction: instructionSchema.optional(),
  cleanupInstruction: instructionSchema.nullable().optional(),
  otherInstructions: z.array(instructionSchema).max(32).optional(),
  tipInstruction: instructionSchema.nullable().optional(),
  addressesByLookupTableAddress: z
    .record(z.string(), z.array(z.string()).max(256))
    .nullable()
    .optional(),
  blockhashWithMetadata: z
    .object({
      blockhash: z.array(z.number().int().min(0).max(255)).length(32),
      lastValidBlockHeight: z
        .number()
        .int()
        .nonnegative()
        .refine(Number.isSafeInteger),
    })
    .optional(),
});
export type JupiterBuilt = {
  review: Omit<
    JupiterReview,
    'id' | 'threadId' | 'dotId' | 'transactionHash' | 'status'
  >;
  providerRequestId?: string;
};
export function jupiterDecimal(units: bigint | string, decimals: number) {
  const digits = String(units).padStart(decimals + 1, '0');
  return decimals
    ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(
        /\.?0+$/,
        '',
      )
    : digits;
}
export function jupiterUnits(amount: string, decimals: number) {
  if (!/^\d+(?:\.\d+)?$/.test(amount))
    throw new JupiterError('Enter a positive decimal amount.');
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals)
    throw new JupiterError(
      `The input token supports ${decimals} decimal places.`,
    );
  const value =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0');
  if (value <= 0n || value > (1n << 64n) - 1n)
    throw new JupiterError(
      'Amount must be positive and fit in the token’s u64 range.',
    );
  return value.toString();
}
export function jupiterAddress(value: string, signing = false) {
  try {
    const key = new PublicKey(value);
    if (signing && !PublicKey.isOnCurve(key.toBytes())) throw Error();
    return key;
  } catch {
    throw new JupiterError(
      signing
        ? 'Connect a valid Solana signing wallet.'
        : 'Enter a valid Solana mint address.',
    );
  }
}
const exactNumber = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new JupiterError(
      'RPC returned an amount outside supported exact precision.',
      502,
    );
  return BigInt(value);
};
const nonzero = (signature: Uint8Array) =>
  signature.some((value) => value !== 0);
export function verifyJupiterSignatures(
  original: VersionedTransaction,
  signed: VersionedTransaction,
  address: string,
  deferred: string[],
) {
  if (
    signed.version !== 0 ||
    !Buffer.from(signed.message.serialize()).equals(
      Buffer.from(original.message.serialize()),
    )
  )
    throw new JupiterError(
      'Sign the exact reviewed version 0 transaction.',
      409,
    );
  const keys = original.message.staticAccountKeys.slice(
    0,
    original.message.header.numRequiredSignatures,
  );
  if (!keys.some((key) => key.toBase58() === address))
    throw new JupiterError(
      'The connected wallet is not a required transaction signer.',
      409,
    );
  for (let i = 0; i < keys.length; i++) {
    const before = original.signatures[i],
      after = signed.signatures[i],
      key = keys[i].toBase58();
    if (nonzero(before) && !Buffer.from(before).equals(Buffer.from(after)))
      throw new JupiterError('A provider signature changed after review.', 409);
    if (!nonzero(after)) {
      if (key === address || !deferred.includes(key))
        throw new JupiterError(
          'The connected wallet must sign every required wallet signature.',
          409,
        );
    } else if (
      !ed25519.verify(after, signed.message.serialize(), keys[i].toBytes())
    )
      throw new JupiterError('A transaction signature is invalid.', 409);
  }
}
export class JupiterProvider {
  readonly connection: Connection;
  constructor(
    rpcUrl = process.env.SOLANA_RPC_URL ||
      'https://api.mainnet-beta.solana.com',
    private apiKey = process.env.JUPITER_API_KEY,
    private transport: typeof fetch = fetch,
    connection?: Connection,
    private now = Date.now,
  ) {
    const url = new URL(rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new JupiterError('Jupiter requires an HTTPS mainnet RPC.', 503);
    this.connection =
      connection ??
      new Connection(rpcUrl, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
      });
  }
  get configured() {
    return Boolean(this.apiKey?.trim());
  }
  async requireMainnet() {
    if ((await this.connection.getGenesisHash()) !== MAINNET)
      throw new JupiterError('The configured RPC is not Solana mainnet.', 503);
  }
  private async request(
    path: 'order' | 'build' | 'execute',
    params?: URLSearchParams,
    body?: object,
  ) {
    if (!this.configured)
      throw new JupiterError('Jupiter is not configured on this server.', 503);
    try {
      const response = await this.transport(
        `${ORIGIN}/${path}${params ? `?${params}` : ''}`,
        {
          method: body ? 'POST' : 'GET',
          headers: {
            'x-api-key': this.apiKey!,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
        },
      );
      const reader = response.body?.getReader();
      if (!reader) throw Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw Error();
        }
        chunks.push(value);
      }
      const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (path === 'execute') return { ok: response.ok, json };
      if (!response.ok)
        throw new JupiterError(
          response.status === 429
            ? 'Jupiter rate limit reached. Wait before requesting another quote.'
            : 'Jupiter could not provide this route. Check token liquidity and try again.',
          response.status === 429 ? 429 : 502,
        );
      return { ok: true, json };
    } catch (error) {
      if (error instanceof JupiterError) throw error;
      throw new JupiterError(
        'Jupiter is temporarily unavailable. No automatic submission retry was attempted.',
        502,
      );
    }
  }
  private async mint(value: string) {
    const key = jupiterAddress(value);
    if (key.equals(NATIVE_MINT))
      return { key, decimals: 9, program: TOKEN_PROGRAM_ID };
    const account = await this.connection.getAccountInfo(key, 'confirmed');
    if (
      !account ||
      (!account.owner.equals(TOKEN_PROGRAM_ID) &&
        !account.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      throw new JupiterError('Select an SPL Token or Token-2022 mint.');
    const mint = unpackMint(key, account, account.owner);
    if (!mint.isInitialized)
      throw new JupiterError('The mint is not initialized.');
    return { key, decimals: mint.decimals, program: account.owner };
  }
  private async response(
    input: JupiterSwap,
    address?: string,
    prepare = false,
  ) {
    if (!this.configured)
      throw new JupiterError('Jupiter is not configured on this server.', 503);
    await this.requireMainnet();
    if (input.mode === 'order' && (input.fast || input.maxAccounts !== 64))
      throw new JupiterError(
        'Fast mode and account limits apply to advanced Build only.',
      );
    if (input.mode === 'build' && !address)
      throw new JupiterError('Connect a wallet for an advanced Build quote.');
    const [from, to] = await Promise.all([
      this.mint(input.inputMint),
      this.mint(input.outputMint),
    ]);
    if (from.key.equals(to.key))
      throw new JupiterError('Choose two different tokens.');
    const amount = jupiterUnits(input.amount, from.decimals);
    const params = new URLSearchParams({
      inputMint: from.key.toBase58(),
      outputMint: to.key.toBase58(),
      amount,
      swapMode: 'ExactIn',
    });
    if (input.mode === 'build' || prepare)
      params.set('taker', jupiterAddress(address!, true).toBase58());
    if (input.slippageBps !== 'rtse')
      params.set('slippageBps', String(input.slippageBps));
    if (input.mode === 'order')
      params.set('maxSupportedTransactionVersion', '0');
    else {
      params.set('transactionVersion', '0');
      params.set('slippageBps', String(input.slippageBps));
      params.set('maxAccounts', String(input.maxAccounts));
      if (input.fast) params.set('mode', 'fast');
    }
    const raw = responseSchema.safeParse(
      (await this.request(input.mode, params)).json,
    );
    if (!raw.success)
      throw new JupiterError(
        'Jupiter returned an unsupported response. Request a new quote.',
        502,
      );
    const data = raw.data;
    if (
      data.inputMint !== from.key.toBase58() ||
      data.outputMint !== to.key.toBase58() ||
      data.inAmount !== amount ||
      BigInt(data.outAmount) <= 0n ||
      BigInt(data.otherAmountThreshold) > BigInt(data.outAmount) ||
      (input.slippageBps !== 'rtse' && data.slippageBps > input.slippageBps)
    )
      throw new JupiterError(
        'Jupiter returned amounts or tokens that differ from this request.',
        502,
      );
    if (data.transactionVersion !== undefined && data.transactionVersion !== 0)
      throw new JupiterError(
        'This wallet integration supports Solana version 0 only.',
        502,
      );
    const impact =
      data.priceImpact !== undefined
        ? Number(data.priceImpact)
        : data.priceImpactPct !== undefined
          ? Number(data.priceImpactPct) * 100
          : undefined;
    const quote: JupiterQuote = {
      source: 'Jupiter',
      network: 'solana-mainnet',
      mode: input.mode,
      input,
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inputDecimals: from.decimals,
      outputDecimals: to.decimals,
      inputAmount: jupiterDecimal(amount, from.decimals),
      expectedOutput: jupiterDecimal(data.outAmount, to.decimals),
      minimumOutput: jupiterDecimal(data.otherAmountThreshold, to.decimals),
      inAmount: amount,
      outAmount: data.outAmount,
      otherAmountThreshold: data.otherAmountThreshold,
      router: data.router ?? 'metis',
      slippageBps: data.slippageBps,
      ...(impact !== undefined && Number.isFinite(impact)
        ? { priceImpactPercent: String(impact) }
        : {}),
      feeBps: data.feeBps ?? data.platformFee?.feeBps ?? 0,
      feeMint: data.feeMint ?? data.platformFee?.feeMint,
      platformFeeBps: data.platformFee?.feeBps ?? 0,
      platformFeeAmount: data.platformFee?.amount,
      gasless: data.gasless ?? false,
      signatureFeeLamports: data.signatureFeeLamports ?? '0',
      prioritizationFeeLamports: data.prioritizationFeeLamports ?? '0',
      rentFeeLamports: data.rentFeeLamports ?? '0',
      signatureFeePayer: data.signatureFeePayer ?? undefined,
      prioritizationFeePayer: data.prioritizationFeePayer ?? undefined,
      rentFeePayer: data.rentFeePayer ?? undefined,
      route: data.routePlan.map(({ swapInfo, percent }) => ({
        label: swapInfo.label ?? 'Solana pool',
        inputMint: swapInfo.inputMint,
        outputMint: swapInfo.outputMint,
        percent,
      })),
      observedAt: this.now(),
      expiresAt: this.now() + 30_000,
      executionAvailable: false,
      ...(data.transactionVersion === 0
        ? { transactionVersion: 0 as const }
        : {}),
      ...(data.transaction === '' || data.errorCode !== undefined
        ? {
            preparationError:
              'Jupiter cannot build this wallet’s transaction. Check token balance, SOL for fees and gasless eligibility.',
          }
        : {}),
    };
    return { data, quote, from, to };
  }
  async quote(input: JupiterSwap, address?: string) {
    return (await this.response(input, address)).quote;
  }
  private toInstruction(raw: z.infer<typeof instructionSchema>) {
    const data = Buffer.from(raw.data, 'base64');
    if (data.toString('base64') !== raw.data)
      throw new JupiterError('Unsupported instruction encoding.', 502);
    return new TransactionInstruction({
      programId: jupiterAddress(raw.programId),
      keys: raw.accounts.map((a) => ({
        pubkey: jupiterAddress(a.pubkey),
        isSigner: a.isSigner,
        isWritable: a.isWritable,
      })),
      data,
    });
  }
  private async tables(transaction: VersionedTransaction) {
    const tables: AddressLookupTableAccount[] = [];
    for (const lookup of transaction.message.addressTableLookups) {
      const table = (
        await this.connection.getAddressLookupTable(lookup.accountKey)
      ).value;
      if (!table)
        throw new JupiterError(
          'A transaction lookup table is unavailable.',
          502,
        );
      tables.push(table);
    }
    return tables;
  }
  private computePrice(instructions: TransactionInstruction[], clamp: boolean) {
    let price = 0n,
      limit: number | undefined;
    const result: TransactionInstruction[] = [];
    for (const instruction of instructions) {
      if (instruction.programId.equals(ComputeBudgetProgram.programId)) {
        if (instruction.data[0] === 3 && instruction.data.length === 9) {
          price = instruction.data.readBigUInt64LE(1);
          if (price > JUPITER_CU_PRICE_CEILING && !clamp)
            throw new JupiterError(
              'Jupiter’s priority fee exceeds this app’s compute price ceiling. Prepare a new route.',
            );
          if (clamp && price > JUPITER_CU_PRICE_CEILING)
            price = JUPITER_CU_PRICE_CEILING;
          result.push(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
          );
        } else if (instruction.data[0] === 2 && instruction.data.length === 5) {
          limit = instruction.data.readUInt32LE(1);
          if (!clamp) result.push(instruction);
        } else if (!clamp) result.push(instruction);
        else
          throw new JupiterError('Unexpected compute budget instruction.', 502);
      } else result.push(instruction);
    }
    if (limit !== undefined && (limit <= 0 || limit > MAX_CU))
      throw new JupiterError('Unsupported compute unit limit.', 502);
    return { instructions: result, price, limit };
  }
  async prepare(
    input: JupiterSwap,
    addressText: string,
  ): Promise<JupiterBuilt> {
    const address = jupiterAddress(addressText, true).toBase58(),
      user = new PublicKey(address);
    const { data, quote, from } = await this.response(input, address, true);
    if (quote.preparationError) throw new JupiterError(quote.preparationError);
    const balance = exactNumber(
      await this.connection.getBalance(user, 'confirmed'),
    );
    const ata = getAssociatedTokenAddressSync(
      from.key,
      user,
      false,
      from.program,
    );
    const account = from.key.equals(NATIVE_MINT)
      ? null
      : await this.connection.getAccountInfo(ata);
    const inputBalance = from.key.equals(NATIVE_MINT)
      ? balance.toString()
      : account
        ? (await this.connection.getTokenAccountBalance(ata)).value.amount
        : '0';
    if (BigInt(inputBalance) < BigInt(quote.inAmount))
      throw new JupiterError(
        'The connected wallet has insufficient input tokens.',
      );
    let transaction: VersionedTransaction,
      lastValidBlockHeight: number | undefined,
      computeUnitLimit: number | undefined;
    let expiresAt = this.now() + 60_000;
    if (input.mode === 'order') {
      if (!data.transaction || data.taker !== address || !data.requestId)
        throw new JupiterError(
          'Jupiter did not return a signable order for this wallet.',
          502,
        );
      const bytes = Buffer.from(data.transaction, 'base64');
      if (bytes.length > 1232 || bytes.toString('base64') !== data.transaction)
        throw new JupiterError('Unsupported transaction bytes.', 502);
      transaction = VersionedTransaction.deserialize(bytes);
      if (data.lastValidBlockHeight !== undefined) {
        lastValidBlockHeight = Number(data.lastValidBlockHeight);
        if (!Number.isSafeInteger(lastValidBlockHeight))
          throw new JupiterError('Unsupported transaction expiry.', 502);
      }
      if (data.expireAt) {
        const expiry = Date.parse(data.expireAt);
        if (!Number.isFinite(expiry))
          throw new JupiterError('Unsupported order expiry.', 502);
        expiresAt = Math.min(expiresAt, expiry - 2000);
      }
      if (!data.expireAt && lastValidBlockHeight === undefined)
        throw new JupiterError(
          'The signable order has no verified expiry.',
          502,
        );
    } else {
      if (!data.swapInstruction || !data.blockhashWithMetadata)
        throw new JupiterError(
          'Jupiter did not return build instructions.',
          502,
        );
      if (data.tipInstruction)
        throw new JupiterError(
          'This RPC build does not request a Jupiter tip. Request a new route.',
          502,
        );
      const all = [
        ...(data.computeBudgetInstructions ?? []),
        ...(data.setupInstructions ?? []),
        data.swapInstruction,
        ...(data.cleanupInstruction ? [data.cleanupInstruction] : []),
        ...(data.otherInstructions ?? []),
      ].map((ix) => this.toInstruction(ix));
      const priced = this.computePrice(all, true);
      const tables: AddressLookupTableAccount[] = [];
      for (const [key, expected] of Object.entries(
        data.addressesByLookupTableAddress ?? {},
      )) {
        const table = (
          await this.connection.getAddressLookupTable(jupiterAddress(key))
        ).value;
        if (
          !table ||
          expected.length > table.state.addresses.length ||
          expected.some(
            (value, i) => value !== table.state.addresses[i].toBase58(),
          )
        )
          throw new JupiterError(
            'Jupiter’s lookup table differs from Solana mainnet.',
            502,
          );
        tables.push(table);
      }
      const blockhash = bs58.encode(
        Uint8Array.from(data.blockhashWithMetadata.blockhash),
      );
      lastValidBlockHeight = data.blockhashWithMetadata.lastValidBlockHeight;
      const compile = (limit: number) =>
        new VersionedTransaction(
          new TransactionMessage({
            payerKey: user,
            recentBlockhash: blockhash,
            instructions: [
              ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
              ...priced.instructions,
            ],
          }).compileToV0Message(tables),
        );
      transaction = compile(MAX_CU);
      const estimate = await this.connection.simulateTransaction(transaction, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
      });
      if (estimate.value.err || !estimate.value.unitsConsumed)
        throw new JupiterError(
          'The advanced route did not pass compute estimation. Check wallet funding and token accounts.',
        );
      computeUnitLimit = Math.min(
        MAX_CU,
        Math.ceil(estimate.value.unitsConsumed * 1.2),
      );
      transaction = compile(computeUnitLimit);
    }
    if (transaction.version !== 0)
      throw new JupiterError(
        'This app supports Solana version 0 transactions only.',
        502,
      );
    if (
      expiresAt <= this.now() ||
      (lastValidBlockHeight !== undefined &&
        (await this.connection.getBlockHeight('confirmed')) >
          lastValidBlockHeight) ||
      !(
        await this.connection.isBlockhashValid(
          transaction.message.recentBlockhash,
          { commitment: 'confirmed' },
        )
      ).value
    )
      throw new JupiterError(
        'The route expired. Prepare a fresh transaction.',
        409,
      );
    const signerKeys = transaction.message.staticAccountKeys
      .slice(0, transaction.message.header.numRequiredSignatures)
      .map((key) => key.toBase58());
    if (!signerKeys.includes(address))
      throw new JupiterError(
        'This order does not require the connected wallet’s signature.',
        502,
      );
    const allowedDeferred = new Set(
      [
        ...(data.router === 'jupiterz' ? [data.maker] : []),
        ...(data.gasless
          ? [
              data.signatureFeePayer,
              data.prioritizationFeePayer,
              data.rentFeePayer,
              'gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB',
            ]
          : []),
      ].filter(Boolean),
    );
    const deferredSigners: string[] = [];
    for (let i = 0; i < signerKeys.length; i++) {
      if (nonzero(transaction.signatures[i])) {
        if (
          !ed25519.verify(
            transaction.signatures[i],
            transaction.message.serialize(),
            transaction.message.staticAccountKeys[i].toBytes(),
          )
        )
          throw new JupiterError('A provider signature is invalid.', 502);
      } else if (signerKeys[i] !== address) {
        if (input.mode !== 'order' || !allowedDeferred.has(signerKeys[i]))
          throw new JupiterError(
            'The route requires an unsupported additional signer.',
            502,
          );
        deferredSigners.push(signerKeys[i]);
      }
    }
    const tables = await this.tables(transaction);
    const decompiled = TransactionMessage.decompile(transaction.message, {
      addressLookupTableAccounts: tables,
    });
    const computed = this.computePrice(decompiled.instructions, false);
    const bytes = transaction.serialize();
    if (bytes.length > 1232)
      throw new JupiterError(
        'This route exceeds the version 0 transaction size limit. Reduce maximum accounts.',
      );
    const simulation = await this.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: false,
      commitment: 'confirmed',
      accounts: { encoding: 'base64', addresses: [address] },
    });
    if (simulation.value.err)
      throw new JupiterError(
        'The exact transaction failed simulation. Check wallet funding, token restrictions and route freshness.',
      );
    const after = simulation.value.accounts?.[0];
    if (!after)
      throw new JupiterError(
        'RPC did not return a wallet balance simulation.',
        502,
      );
    const postBalance = exactNumber(after.lamports);
    const fee = (
      await this.connection.getFeeForMessage(transaction.message, 'confirmed')
    ).value;
    if (fee === null)
      throw new JupiterError(
        'The transaction’s network fee is unavailable.',
        502,
      );
    const feeLamports = exactNumber(fee);
    const debit = balance > postBalance ? balance - postBalance : 0n;
    const priority =
      (computed.price * BigInt(computeUnitLimit ?? computed.limit ?? MAX_CU) +
        999999n) /
      1000000n;
    return {
      providerRequestId: input.mode === 'order' ? data.requestId : undefined,
      review: {
        ...quote,
        ...(input.mode === 'build'
          ? {
              prioritizationFeeLamports: priority.toString(),
              signatureFeeLamports: (feeLamports > priority
                ? feeLamports - priority
                : 0n
              ).toString(),
              signatureFeePayer: address,
              prioritizationFeePayer: address,
              rentFeePayer: address,
            }
          : {}),
        executionAvailable: true,
        address,
        feePayer: signerKeys[0],
        transactionVersion: 0,
        transactionBase64: Buffer.from(bytes).toString('base64'),
        requiredSigners: signerKeys,
        deferredSigners,
        instructions: decompiled.instructions.map((ix) => ({
          program: ix.programId.toBase58(),
          accounts: ix.keys.map((key) => ({
            address: key.pubkey.toBase58(),
            signer: key.isSigner,
            writable: key.isWritable,
          })),
          dataBase64: ix.data.toString('base64'),
        })),
        lastValidBlockHeight,
        expiresAt,
        balanceSol: jupiterDecimal(balance, 9),
        inputBalance: jupiterDecimal(inputBalance, from.decimals),
        networkFeeSol: jupiterDecimal(feeLamports, 9),
        estimatedSolDebit: jupiterDecimal(debit, 9),
        simulation: {
          status: 'passed',
          unitsConsumed: simulation.value.unitsConsumed,
        },
        computeUnitLimit: computeUnitLimit ?? computed.limit,
        computeUnitPriceMicroLamports: computed.price.toString(),
        computeUnitPriceCeilingMicroLamports:
          JUPITER_CU_PRICE_CEILING.toString(),
      },
    };
  }
  async execute(
    signedTransaction: string,
    requestId: string,
    lastValidBlockHeight?: number,
  ) {
    const response = await this.request('execute', undefined, {
      signedTransaction,
      requestId,
      ...(lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: String(lastValidBlockHeight) }
        : {}),
    });
    const parsed = z
      .object({
        status: z.enum(['Success', 'Failed']),
        code: z.number().int(),
        signature: z.string().optional(),
      })
      .safeParse(response.json);
    if (!parsed.success)
      throw new JupiterError(
        'Jupiter submission could not be verified. Do not submit this order again.',
        502,
      );
    if (parsed.data.signature) {
      try {
        if (bs58.decode(parsed.data.signature).length !== 64) throw Error();
      } catch {
        throw new JupiterError(
          'Jupiter returned an invalid receipt signature.',
          502,
        );
      }
    }
    return parsed.data;
  }
}
