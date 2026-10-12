import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
  ComputeBudgetProgram,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  OnlinePumpSdk,
  PUMP_SDK,
  PUMP_PROGRAM_ID,
  bondingCurvePda,
  canonicalPumpPoolPdaWithQuote,
  getBuyTokenAmountFromSolAmount,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
  newBondingCurve,
  holderRewardsPda,
} from '@pump-fun/pump-sdk';
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  buyQuoteInput,
  sellBaseInput,
  supportsTradeV2,
} from '@pump-fun/pump-swap-sdk';
import BN from 'bn.js';
import type {
  PumpIntent,
  PumpReview,
  PumpToken,
} from '../shared/pump-types.js';

export function pumpUnits(
  value: string,
  decimals: number,
  allowZero = false,
): BN {
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new PumpBuildError('Enter a decimal amount.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals)
    throw new PumpBuildError(`This token supports ${decimals} decimal places.`);
  const units = new BN(whole)
    .mul(new BN(10).pow(new BN(decimals)))
    .add(new BN(fraction.padEnd(decimals, '0') || '0'));
  if ((!allowZero && units.isZero()) || units.bitLength() > 64)
    throw new PumpBuildError(
      'Amount must be positive and fit in the token’s u64 range.',
    );
  return units;
}
export function pumpDecimal(
  units: BN | bigint | number,
  decimals: number,
): string {
  const digits = units.toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(
    /\.?0+$/,
    '',
  );
}
const lower = (amount: BN, bps: number) => amount.muln(10000 - bps).divn(10000);
const upper = (amount: BN, bps: number) =>
  amount.add(amount.muln(bps).divn(10000));
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const pumpQuoteLabel = (mint: PublicKey) =>
  mint.equals(NATIVE_MINT)
    ? 'SOL'
    : mint.toBase58() === USDC
      ? 'USDC'
      : mint.toBase58();
export type PumpBuild = Omit<
  PumpReview,
  | 'id'
  | 'threadId'
  | 'dotId'
  | 'walletId'
  | 'walletName'
  | 'address'
  | 'expiresAt'
  | 'status'
  | 'transactionHash'
>;
export class PumpBuildError extends Error {}

/** Official SDKs own account layouts, fee recipients, fee schedules and signed virtual reserves. */
export class PumpBuilder {
  readonly connection: Connection;
  readonly online: OnlinePumpSdk;
  readonly amm: OnlinePumpAmmSdk;
  constructor(rpcUrl = 'https://api.mainnet-beta.solana.com') {
    const url = new URL(rpcUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new PumpBuildError(
        'Pump requires an HTTPS Solana mainnet RPC URL.',
      );
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
    });
    this.online = new OnlinePumpSdk(this.connection);
    this.amm = new OnlinePumpAmmSdk(this.connection);
  }
  async requireMainnet() {
    if (
      (await this.connection.getGenesisHash()) !==
      '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    )
      throw new PumpBuildError('The configured RPC is not Solana mainnet.');
  }
  private async coin(mint: PublicKey) {
    const account = await this.connection.getAccountInfo(mint);
    if (
      !account ||
      (!account.owner.equals(TOKEN_PROGRAM_ID) &&
        !account.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      throw new PumpBuildError('Mint is not an SPL Token or Token-2022 mint.');
    const token = await getMint(
      this.connection,
      mint,
      'confirmed',
      account.owner,
    );
    const curveInfo = await this.connection.getAccountInfo(
      bondingCurvePda(mint),
    );
    if (!curveInfo || !curveInfo.owner.equals(PUMP_PROGRAM_ID))
      throw new PumpBuildError('This mint is not a Pump.fun coin.');
    const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
    const quoteMint = curve.quoteMint.equals(PublicKey.default)
      ? NATIVE_MINT
      : curve.quoteMint;
    const quote = quoteMint.equals(NATIVE_MINT)
      ? { decimals: 9 }
      : await getMint(
          this.connection,
          quoteMint,
          'confirmed',
          (await this.connection.getAccountInfo(quoteMint))?.owner,
        );
    return {
      token,
      tokenProgram: account.owner,
      curve,
      quoteMint,
      quoteDecimals: quote.decimals,
    };
  }
  async token(mintText: string, address: string): Promise<PumpToken> {
    await this.requireMainnet();
    const mint = new PublicKey(mintText),
      user = new PublicKey(address);
    const coin = await this.coin(mint);
    const ata = getAssociatedTokenAddressSync(
      mint,
      user,
      true,
      coin.tokenProgram,
    );
    const info = await this.connection.getAccountInfo(ata);
    const balance = info
      ? (await this.connection.getTokenAccountBalance(ata)).value.amount
      : '0';
    if (coin.curve.complete)
      await this.amm.fetchPool(
        canonicalPumpPoolPdaWithQuote(mint, coin.quoteMint),
      );
    return {
      mint: mint.toBase58(),
      quoteMint: coin.quoteMint.toBase58(),
      quoteLabel: pumpQuoteLabel(coin.quoteMint),
      decimals: coin.token.decimals,
      quoteDecimals: coin.quoteDecimals,
      venue: coin.curve.complete ? 'PumpSwap' : 'Pump bonding curve',
      balance: pumpDecimal(new BN(balance), coin.token.decimals),
      solBalance: pumpDecimal(await this.connection.getBalance(user), 9),
      address,
    };
  }
  async build(intent: PumpIntent, address: string): Promise<PumpBuild> {
    await this.requireMainnet();
    const user = new PublicKey(address);
    let mint: PublicKey;
    let signer: Keypair | undefined;
    let instructions: TransactionInstruction[];
    let venue: PumpReview['venue'] = 'Pump bonding curve';
    let quoteMint = NATIVE_MINT,
      quoteDecimals = 9,
      decimals = 6;
    let expected = new BN(0),
      minimum = new BN(0),
      maximum = new BN(0);
    let inputAmount: string;
    const bps = intent.input.slippageBps,
      slippage = bps / 100;
    if (intent.kind === 'launch') {
      const input = intent.input;
      // Pump validates these as UTF-8 byte lengths on-chain.
      if (
        Buffer.byteLength(input.name) > 32 ||
        Buffer.byteLength(input.symbol) > 13 ||
        Buffer.byteLength(input.uri) > 200
      )
        throw new PumpBuildError(
          'Name, symbol and metadata URI exceed Pump’s UTF-8 limits.',
        );
      const global = await this.online.fetchGlobal();
      if (!global.createV2Enabled)
        throw new PumpBuildError(
          'Pump.fun token creation is currently disabled on-chain.',
        );
      if (input.holderReward && !global.isHolderRewardEnabled)
        throw new PumpBuildError(
          'Holder reward creation is currently disabled on-chain.',
        );
      signer = Keypair.generate();
      mint = signer.publicKey;
      const quote = pumpUnits(input.initialBuySol, 9, true);
      inputAmount = input.initialBuySol;
      instructions = [
        await PUMP_SDK.createV2Instruction({
          mint,
          user,
          creator: user,
          name: input.name,
          symbol: input.symbol,
          uri: input.uri,
          mayhemMode: false,
          cashback: false,
          holderReward: input.holderReward,
        }),
      ];
      if (!quote.isZero()) {
        const feeConfig = await this.online.fetchFeeConfig();
        const curve = {
          ...newBondingCurve(global),
          creator: input.holderReward ? holderRewardsPda(mint) : user,
          isHolderReward: input.holderReward,
          isMayhemMode: false,
        };
        expected = getBuyV3TokenAmountFromQuoteAmount({
          global,
          feeConfig,
          mintSupply: global.tokenTotalSupply,
          bondingCurve: curve,
          amount: quote,
          curveBaseTokenBalance: global.tokenTotalSupply,
        });
        if (expected.isZero())
          throw new PumpBuildError('Initial buy is too small.');
        maximum = quote;
        minimum = lower(expected, bps);
        if (minimum.isZero())
          throw new PumpBuildError(
            'Initial buy is too small for the minimum output.',
          );
        instructions.push(
          ...(await PUMP_SDK.buyExactQuoteInV3Instructions({
            mint,
            user,
            bondingCurve: curve,
            associatedUserAccountInfo: null,
            amount: expected,
            quoteAmount: quote,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            slippage,
          })),
        );
      }
    } else {
      const input = intent.input;
      mint = new PublicKey(input.mint);
      const coin = await this.coin(mint);
      quoteMint = coin.quoteMint;
      quoteDecimals = coin.quoteDecimals;
      decimals = coin.token.decimals;
      if (new PublicKey(input.quoteMint).toBase58() !== quoteMint.toBase58())
        throw new PumpBuildError(
          `This coin trades against ${pumpQuoteLabel(quoteMint)}. Inspect it again and use the correct quote mint.`,
        );
      const amount = pumpUnits(
        input.amount,
        input.side === 'buy' ? quoteDecimals : decimals,
      );
      inputAmount = input.amount;
      if (input.side === 'sell') {
        const ata = getAssociatedTokenAddressSync(
          mint,
          user,
          true,
          coin.tokenProgram,
        );
        const balance = new BN(
          (await this.connection.getTokenAccountBalance(ata)).value.amount,
        );
        if (amount.gt(balance))
          throw new PumpBuildError(
            'The assigned wallet does not hold enough tokens to sell.',
          );
      }
      if (coin.curve.complete) {
        venue = 'PumpSwap';
        const state = await this.amm.swapSolanaState(
          canonicalPumpPoolPdaWithQuote(mint, quoteMint),
          user,
        );
        const params = {
          baseReserve: state.poolBaseAmount,
          quoteReserve: state.poolQuoteAmount,
          virtualQuoteReserves: state.pool.virtualQuoteReserves,
          feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees),
          globalConfig: state.globalConfig,
          baseMintAccount: state.baseMintAccount,
          baseMint: mint,
          coinCreator: state.pool.coinCreator,
          creator: state.pool.creator,
          feeConfig: state.feeConfig,
          quoteMint,
          isMayhemMode: state.pool.isMayhemMode,
          creatorFeeBps: state.pool.creatorFeeBps,
          slippage,
        };
        if (!state.feeConfig)
          throw new PumpBuildError(
            'PumpSwap fee configuration is unavailable.',
          );
        if (input.side === 'buy') {
          const quote = buyQuoteInput({ ...params, quote: amount });
          expected = quote.base;
          if (supportsTradeV2(state.pool)) {
            minimum = lower(expected, bps);
            maximum = amount;
            instructions = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(
              state,
              amount,
              minimum,
            );
          } else {
            minimum = expected;
            maximum = quote.maxQuote;
            instructions = await PUMP_AMM_SDK.buyQuoteInput(
              state,
              amount,
              slippage,
              { v2: true },
            );
          }
        } else {
          const quote = sellBaseInput({ ...params, base: amount });
          expected = quote.uiQuote;
          minimum = quote.minQuote;
          instructions = await PUMP_AMM_SDK.sellBaseInput(
            state,
            amount,
            slippage,
            { v2: true },
          );
        }
      } else {
        const global = await this.online.fetchGlobal(),
          feeConfig = await this.online.fetchFeeConfig();
        const state = await this.online.fetchBuyState(
          mint,
          user,
          coin.tokenProgram,
          quoteMint,
        );
        const common = {
          ...state,
          global,
          mint,
          user,
          tokenProgram: coin.tokenProgram,
          slippage,
        };
        if (input.side === 'buy') {
          if (state.bondingCurve.isCashbackCoin) {
            expected = getBuyTokenAmountFromSolAmount({
              global,
              feeConfig,
              mintSupply: new BN(coin.token.supply.toString()),
              bondingCurve: state.bondingCurve,
              amount,
              quoteMint,
            });
            minimum = expected;
            maximum = upper(amount, bps);
            instructions = await PUMP_SDK.buyV2Instructions({
              ...common,
              amount: expected,
              quoteAmount: amount,
            });
          } else {
            expected = getBuyV3TokenAmountFromQuoteAmount({
              global,
              feeConfig,
              mintSupply: new BN(coin.token.supply.toString()),
              bondingCurve: state.bondingCurve,
              amount,
              curveBaseTokenBalance: state.curveBaseTokenBalance,
            });
            minimum = lower(expected, bps);
            maximum = amount;
            instructions = await PUMP_SDK.buyExactQuoteInV3Instructions({
              ...common,
              amount: expected,
              quoteAmount: amount,
            });
          }
        } else {
          expected = getSellSolAmountFromTokenAmount({
            global,
            feeConfig,
            mintSupply: new BN(coin.token.supply.toString()),
            bondingCurve: state.bondingCurve,
            amount,
          });
          minimum = lower(expected, bps);
          instructions = state.bondingCurve.isCashbackCoin
            ? await PUMP_SDK.sellV2Instructions({
                ...common,
                amount,
                quoteAmount: expected,
              })
            : await PUMP_SDK.sellV3Instructions({
                ...common,
                amount,
                quoteAmount: expected,
              });
        }
      }
      if (expected.isZero() || minimum.isZero())
        throw new PumpBuildError(
          'Amount is too small to produce a positive slippage-protected output.',
        );
    }
    const block = await this.connection.getLatestBlockhash();
    const transaction = new Transaction({ feePayer: user, ...block }).add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: intent.kind === 'launch' ? 500000 : 300000,
      }),
      ...instructions,
    );
    if (signer) {
      transaction.partialSign(signer);
      signer.secretKey.fill(0);
    }
    const bytes = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    if (bytes.length > 1232)
      throw new PumpBuildError(
        'This transaction exceeds Solana’s packet limit. Launch without an initial buy, then buy in a separate request.',
      );
    const balance = await this.connection.getBalance(user);
    const fee = (
      await this.connection.getFeeForMessage(transaction.compileMessage())
    ).value;
    if (fee === null)
      throw new PumpBuildError(
        'The transaction blockhash expired. Prepare it again.',
      );
    // The exact partially signed transaction is simulated before review; wallet signing remains separate.
    // The legacy web3 simulation overload fetches a different blockhash. This overload preserves the exact reviewed bytes.
    const simulated = await this.connection.simulateTransaction(
      VersionedTransaction.deserialize(bytes),
      {
        commitment: 'confirmed',
        sigVerify: false,
        replaceRecentBlockhash: false,
        accounts: { encoding: 'base64', addresses: [user.toBase58()] },
      },
    );
    if (simulated.value.err)
      throw new PumpBuildError(
        `Transaction simulation failed: ${JSON.stringify(simulated.value.err)}. Check wallet funds and token state, then prepare again.`,
      );
    const after = simulated.value.accounts?.[0]?.lamports;
    const debit = after === undefined ? fee : Math.max(fee, balance - after);
    return {
      network: 'solana-mainnet',
      kind: intent.kind === 'launch' ? 'launch' : intent.input.side,
      venue,
      mint: mint.toBase58(),
      quoteMint: quoteMint.toBase58(),
      quoteLabel: pumpQuoteLabel(quoteMint),
      ...(intent.kind === 'launch'
        ? {
            name: intent.input.name,
            symbol: intent.input.symbol,
            uri: intent.input.uri,
            holderReward: intent.input.holderReward,
          }
        : {}),
      inputAmount,
      expectedOutput: pumpDecimal(
        expected,
        intent.kind === 'trade' && intent.input.side === 'sell'
          ? quoteDecimals
          : decimals,
      ),
      minimumOutput: pumpDecimal(
        minimum,
        intent.kind === 'trade' && intent.input.side === 'sell'
          ? quoteDecimals
          : decimals,
      ),
      maximumQuote: pumpDecimal(maximum, quoteDecimals),
      slippageBps: bps,
      networkFeeSol: pumpDecimal(fee, 9),
      estimatedSolDebit: pumpDecimal(debit, 9),
      balanceSol: pumpDecimal(balance, 9),
      lastValidBlockHeight: block.lastValidBlockHeight,
      transactionBase64: bytes.toString('base64'),
      instructions: transaction.instructions.map((ix) => ({
        program: ix.programId.toBase58(),
        accounts: ix.keys.map((key) => ({
          address: key.pubkey.toBase58(),
          signer: key.isSigner,
          writable: key.isWritable,
        })),
        dataBase64: ix.data.toString('base64'),
      })),
    };
  }
}
