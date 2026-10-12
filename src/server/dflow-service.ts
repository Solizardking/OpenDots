import { Connection, PublicKey } from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  dflowQuoteInput,
  type DflowQuote,
  type DflowQuoteInput,
  displayUnits,
} from '../shared/dflow-types.js';

export class DflowError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

function integer(value: unknown): value is string {
  return (
    typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) > 0n
  );
}
export function atomicAmount(value: string, decimals: number) {
  const [whole, fraction = ''] = value.split('.');
  if (!/^\d+(?:\.\d+)?$/.test(value) || fraction.length > decimals)
    throw new DflowError(
      `Use at most ${decimals} decimal places for this asset.`,
      400,
    );
  const amount = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (amount <= 0n || amount > 18446744073709551615n)
    throw new DflowError(
      'Enter a positive amount within the token limit.',
      400,
    );
  return amount.toString();
}

async function readJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new DflowError('DFlow returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 1_000_000)
        throw new DflowError('DFlow response exceeds the supported size.');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as Record<
      string,
      unknown
    >;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Authenticated provider access stays server-side. This class only returns quotes. */
export class DflowService {
  private readonly timeout: number;
  private connection?: Connection;
  private mainnet?: Promise<void>;
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetcher: typeof fetch = fetch,
    private readonly decimalsForMint?: (mint: PublicKey) => Promise<number>,
    private readonly now = Date.now,
  ) {
    if (
      env.DFLOW_QUOTE_API_URL &&
      env.DFLOW_QUOTE_API_URL !== 'https://quote-api.dflow.net'
    )
      throw new DflowError('Use the official DFlow Trading API origin.', 503);
    this.timeout = Number(env.DFLOW_TIMEOUT_MS || 8000);
    if (
      !Number.isInteger(this.timeout) ||
      this.timeout < 1000 ||
      this.timeout > 30000
    )
      throw new DflowError('DFlow timeout is not configured correctly.', 503);
  }
  get enabled() {
    return !!this.env.DFLOW_API_KEY?.trim();
  }
  private async decimals(mint: PublicKey) {
    if (this.decimalsForMint) return this.decimalsForMint(mint);
    const connection = (this.connection ??= new Connection(
      this.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: (input, init) =>
          this.fetcher(input, {
            ...init,
            signal: AbortSignal.timeout(this.timeout),
          }),
      },
    ));
    if (!this.mainnet)
      this.mainnet = connection
        .getGenesisHash()
        .then((hash) => {
          if (hash !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
            throw new DflowError(
              'DFlow quotes require a Solana mainnet RPC.',
              503,
            );
        })
        .catch((error) => {
          this.mainnet = undefined;
          throw error;
        });
    await this.mainnet;
    const account = await connection.getAccountInfo(mint);
    if (
      !account ||
      ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(
        account.owner.toBase58(),
      )
    )
      throw new DflowError('This address is not a Solana token mint.', 400);
    return unpackMint(mint, account, account.owner).decimals;
  }
  private async order(query: Record<string, string>, signal?: AbortSignal) {
    if (!this.enabled)
      throw new DflowError('DFlow is not configured on this server.', 503);
    let response: Response;
    try {
      response = await this.fetcher(
        `https://quote-api.dflow.net/order?${new URLSearchParams(query)}`,
        {
          headers: { 'x-api-key': this.env.DFLOW_API_KEY! },
          redirect: 'error',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.timeout)])
            : AbortSignal.timeout(this.timeout),
        },
      );
    } catch {
      throw new DflowError('DFlow could not be reached. Retry the quote.');
    }
    if (!response.ok)
      throw new DflowError(
        `DFlow quote is unavailable (HTTP ${response.status}).`,
        response.status === 429 ? 429 : 502,
      );
    return readJson(response);
  }
  private validate(
    order: Record<string, unknown>,
    parameters: Record<string, string>,
  ) {
    if (
      order.inputMint !== parameters.inputMint ||
      order.outputMint !== parameters.outputMint ||
      order.inAmount !== parameters.amount ||
      Number(order.slippageBps) !== Number(parameters.slippageBps) ||
      order.executionMode !== 'sync' ||
      !integer(order.outAmount) ||
      !integer(order.minOutAmount) ||
      order.minOutAmount !== order.otherAmountThreshold ||
      BigInt(order.minOutAmount) > BigInt(order.outAmount)
    )
      throw new DflowError(
        'DFlow returned a quote that does not match this request.',
      );
  }
  async quote(raw: DflowQuoteInput, signal?: AbortSignal): Promise<DflowQuote> {
    const input = dflowQuoteInput.parse(raw);
    if (!this.enabled)
      throw new DflowError('DFlow is not configured on this server.', 503);
    let mint: PublicKey;
    try {
      mint = new PublicKey(input.mint);
    } catch {
      throw new DflowError('Enter a valid token mint.', 400);
    }
    if (mint.equals(NATIVE_MINT))
      throw new DflowError('Choose a token other than SOL.', 400);
    const decimals = await this.decimals(mint);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
      throw new DflowError('Unsupported token decimals.', 400);
    const sol = NATIVE_MINT.toBase58(),
      buy = input.side === 'buy';
    const parameters = {
      inputMint: buy ? sol : mint.toBase58(),
      outputMint: buy ? mint.toBase58() : sol,
      amount: atomicAmount(input.amount, buy ? 9 : decimals),
      slippageBps: String(input.slippageBps),
      allowAsyncExec: 'false',
      allowSyncExec: 'true',
      transactionVersion: 'v0',
      priceImpactTolerancePct: '10',
    };
    const probe = await this.order(parameters, signal);
    this.validate(probe, parameters);
    const target = BigInt(
      atomicAmount(this.env.DFLOW_PUBLIC_SPOT_FEE_SOL || '0.006942', 9),
    );
    const notional = BigInt(buy ? parameters.amount : String(probe.outAmount));
    const feeBps = Number((target * 10000n) / notional);
    const maximum = Number(this.env.DFLOW_PUBLIC_SPOT_MAX_FEE_BPS || 1000);
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000)
      throw new DflowError('DFlow fee limit is not configured correctly.', 503);
    if (feeBps < 1 || feeBps > maximum)
      throw new DflowError(
        'This amount is outside the DFlow platform fee limit. Adjust the amount or use the direct Pump.fun route.',
        400,
      );
    const receiver = this.env.DFLOW_PUBLIC_SPOT_SOL_FEE_ACCOUNT;
    try {
      const account = new PublicKey(receiver!);
      const owner = new PublicKey(this.env.DFLOW_PUBLIC_SPOT_FEE_OWNER!);
      if (
        !getAssociatedTokenAddressSync(NATIVE_MINT, owner, true).equals(account)
      )
        throw new Error('Incorrect fee account.');
    } catch {
      throw new DflowError('DFlow fee receiver is not configured.', 503);
    }
    const mode = buy ? 'inputMint' : 'outputMint';
    const order = await this.order(
      {
        ...parameters,
        platformFeeBps: String(feeBps),
        platformFeeMode: mode,
        feeAccount: receiver!,
      },
      signal,
    );
    this.validate(order, parameters);
    const fee = order.platformFee as
      { amount?: unknown; feeBps?: unknown; mode?: unknown } | undefined;
    const overage = Number(
      this.env.DFLOW_PUBLIC_SPOT_MAX_FEE_OVERAGE_BPS || 100,
    );
    if (!Number.isInteger(overage) || overage < 0 || overage > 1000)
      throw new DflowError(
        'DFlow fee overage is not configured correctly.',
        503,
      );
    if (
      !fee ||
      fee.feeBps !== feeBps ||
      fee.mode !== mode ||
      !integer(fee.amount) ||
      BigInt(fee.amount) > (target * BigInt(10000 + overage)) / 10000n
    )
      throw new DflowError(
        'DFlow platform fee could not be verified within the configured limit.',
      );
    const observedAt = this.now();
    // Explicit whitelist: provider transaction bytes, wallets and credentials never enter a quote card/model.
    return {
      source: 'DFlow',
      mint: mint.toBase58(),
      side: input.side,
      inputMint: parameters.inputMint,
      outputMint: parameters.outputMint,
      inputDecimals: buy ? 9 : decimals,
      outputDecimals: buy ? decimals : 9,
      inAmount: parameters.amount,
      outAmount: String(order.outAmount),
      minimumOutput: String(order.minOutAmount),
      slippageBps: input.slippageBps,
      platformFeeSol: displayUnits(fee.amount, 9),
      platformFeeBps: feeBps,
      observedAt,
      expiresAt: observedAt + 30000,
      executionAvailable: false,
    };
  }
}
