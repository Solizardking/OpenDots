import { afterEach, expect, it, vi } from 'vitest';
import BN from 'bn.js';
import { BorshInstructionCoder } from '@coral-xyz/anchor';
import {
  Keypair,
  PublicKey,
  Transaction,
  type AccountInfo,
} from '@solana/web3.js';
import {
  MintLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  PUMP_PROGRAM_ID,
  getPumpProgram,
  newBondingCurve,
  bondingCurvePda,
  canonicalPumpPoolPdaWithQuote,
  type Global,
  type FeeConfig,
} from '@pump-fun/pump-sdk';
import {
  OFFLINE_PUMP_AMM_PROGRAM,
  PUMP_AMM_PROGRAM_ID,
  POOL_ACCOUNT_NEW_SIZE,
  pumpPoolAuthorityPda,
  type SwapSolanaState,
  type GlobalConfig,
} from '@pump-fun/pump-swap-sdk';
import { PumpBuilder, pumpUnits } from '../src/server/pump-builder';
import { pumpLaunchSchema, pumpTradeSchema } from '../src/shared/pump-types';

afterEach(() => vi.restoreAllMocks());
const pk = () => Keypair.generate().publicKey;
const bn = (n = 0) => new BN(n);
const info = (data: Buffer, owner: PublicKey): AccountInfo<Buffer> => ({
  data,
  owner,
  executable: false,
  lamports: 2000000,
});
const global: Global = {
  initialized: true,
  authority: pk(),
  feeRecipient: pk(),
  initialVirtualTokenReserves: new BN('1073000000000000'),
  initialVirtualSolReserves: new BN('30000000000'),
  initialRealTokenReserves: new BN('793100000000000'),
  tokenTotalSupply: new BN('1000000000000000'),
  feeBasisPoints: bn(100),
  withdrawAuthority: pk(),
  enableMigrate: true,
  poolMigrationFee: bn(15000000),
  creatorFeeBasisPoints: bn(50),
  feeRecipients: Array.from({ length: 7 }, pk),
  setCreatorAuthority: pk(),
  adminSetCreatorAuthority: pk(),
  createV2Enabled: true,
  whitelistPda: pk(),
  reservedFeeRecipient: pk(),
  mayhemModeEnabled: false,
  reservedFeeRecipients: [pk()],
  isCashbackEnabled: false,
  buybackFeeRecipients: Array.from({ length: 8 }, pk),
  buybackBasisPoints: bn(2000),
  initialVirtualQuoteReserves: new BN('30000000000'),
  whitelistedQuoteMints: [],
  creatorFeeConfigurable: false,
  maxConfigurableCreatorFeeBps: bn(0),
  holderRewardClaimAuthority: pk(),
  isHolderRewardEnabled: true,
  maxCurveDepth: 1,
};
const fees = {
  lpFeeBps: bn(20),
  protocolFeeBps: bn(100),
  creatorFeeBps: bn(50),
};
const feeConfig: FeeConfig = {
  admin: pk(),
  flatFees: fees,
  feeTiers: [{ marketCapLamportsThreshold: bn(), fees }],
  stableFeeTiers: [{ marketCapLamportsThreshold: bn(), fees }],
  exoticFlatFees: fees,
};
function mintBytes() {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: BigInt('1000000000000000'),
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}
async function fixture({
  complete = false,
  cashback = false,
  legacy = false,
  quoteMint = NATIVE_MINT,
  negative = false,
} = {}) {
  const builder = new PumpBuilder(),
    user = Keypair.generate(),
    mint = pk();
  vi.spyOn(builder.connection, 'getGenesisHash').mockResolvedValue(
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  );
  vi.spyOn(builder.connection, 'getLatestBlockhash').mockResolvedValue({
    blockhash: pk().toBase58(),
    lastValidBlockHeight: 1000,
  });
  vi.spyOn(builder.connection, 'getBalance').mockResolvedValue(2000000000);
  vi.spyOn(builder.connection, 'getFeeForMessage').mockResolvedValue({
    context: { slot: 1 },
    value: 10000,
  });
  vi.spyOn(builder.connection, 'simulateTransaction').mockResolvedValue({
    context: { slot: 1 },
    value: {
      err: null,
      logs: [],
      accounts: [
        {
          lamports: 1990000000,
          owner: PublicKey.default.toBase58(),
          data: ['', 'base64'],
          executable: false,
          rentEpoch: 0,
        },
      ],
    },
  });
  vi.spyOn(builder.online, 'fetchGlobal').mockResolvedValue(global);
  vi.spyOn(builder.online, 'fetchFeeConfig').mockResolvedValue(feeConfig);
  const curve = {
    ...newBondingCurve(global),
    creator: pk(),
    complete,
    isCashbackCoin: cashback,
    quoteMint: quoteMint.equals(NATIVE_MINT) ? PublicKey.default : quoteMint,
  };
  const curveInfo = info(
    await getPumpProgram(builder.connection).coder.accounts.encode(
      'bondingCurve',
      curve,
    ),
    PUMP_PROGRAM_ID,
  );
  const tokenProgram = legacy ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  vi.spyOn(builder.connection, 'getAccountInfo').mockImplementation(
    async (key) =>
      key.equals(mint)
        ? info(mintBytes(), tokenProgram)
        : key.equals(bondingCurvePda(mint))
          ? curveInfo
          : key.equals(quoteMint)
            ? info(mintBytes(), TOKEN_2022_PROGRAM_ID)
            : null,
  );
  vi.spyOn(builder.connection, 'getTokenAccountBalance').mockResolvedValue({
    context: { slot: 1 },
    value: {
      amount: '100000000000',
      decimals: 6,
      uiAmount: 100000,
      uiAmountString: '100000',
    },
  });
  vi.spyOn(builder.online, 'fetchBuyState').mockResolvedValue({
    quoteMint,
    quoteTokenProgram: quoteMint.equals(NATIVE_MINT)
      ? TOKEN_PROGRAM_ID
      : TOKEN_2022_PROGRAM_ID,
    bondingCurve: curve,
    bondingCurveAccountInfo: curveInfo,
    associatedUserAccountInfo: null,
    curveBaseTokenBalance: global.tokenTotalSupply,
  });
  const poolKey = canonicalPumpPoolPdaWithQuote(mint, quoteMint);
  const globalConfig: GlobalConfig = {
    admin: pk(),
    lpFeeBasisPoints: bn(20),
    protocolFeeBasisPoints: bn(100),
    disableFlags: 0,
    protocolFeeRecipients: [pk()],
    coinCreatorFeeBasisPoints: bn(50),
    adminSetCoinCreatorAuthority: pk(),
    whitelistPda: pk(),
    reservedFeeRecipient: pk(),
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
    isCashbackEnabled: false,
    buybackFeeRecipients: [pk()],
    buybackBasisPoints: bn(2000),
    boostAuthority: PublicKey.default,
    boostEnabled: false,
    creatorFeeConfigurable: false,
    maxConfigurableCreatorFeeBps: bn(),
  };
  const state: SwapSolanaState = {
    globalConfig,
    feeConfig,
    poolKey,
    poolAccountInfo: info(
      Buffer.alloc(POOL_ACCOUNT_NEW_SIZE),
      PUMP_AMM_PROGRAM_ID,
    ),
    pool: {
      poolBump: 255,
      index: 0,
      creator: pumpPoolAuthorityPda(mint),
      baseMint: mint,
      quoteMint,
      lpMint: pk(),
      poolBaseTokenAccount: pk(),
      poolQuoteTokenAccount: pk(),
      lpSupply: bn(),
      coinCreator: pk(),
      isMayhemMode: false,
      isCashbackCoin: cashback,
      virtualQuoteReserves: negative ? bn(-2000000000) : bn(),
      creatorFeeBps: bn(),
      canEditCreatorFee: false,
      isHolderReward: false,
      protocolFees: negative ? bn(1000000000) : bn(),
      creatorFees: negative ? bn(1000000000) : bn(),
    },
    poolBaseAmount: new BN('500000000000000'),
    poolQuoteAmount: new BN('30000000000'),
    baseTokenProgram: tokenProgram,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
    baseMint: mint,
    baseMintAccount: {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: BigInt('1000000000000000'),
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    user: user.publicKey,
    userBaseTokenAccount: getAssociatedTokenAddressSync(
      mint,
      user.publicKey,
      true,
      tokenProgram,
    ),
    userQuoteTokenAccount: getAssociatedTokenAddressSync(
      quoteMint,
      user.publicKey,
    ),
    userBaseAccountInfo: null,
    userQuoteAccountInfo: null,
  };
  vi.spyOn(builder.amm, 'swapSolanaState').mockResolvedValue(state);
  vi.spyOn(builder.amm, 'fetchPool').mockResolvedValue(state.pool);
  return { builder, user, mint, curve, state, tokenProgram };
}
function pumpInstruction(base64: string, amm = false) {
  const tx = Transaction.from(Buffer.from(base64, 'base64'));
  const ix = tx.instructions.find((instruction) =>
    instruction.programId.equals(amm ? PUMP_AMM_PROGRAM_ID : PUMP_PROGRAM_ID),
  )!;
  const decoded = new BorshInstructionCoder(
    (amm
      ? OFFLINE_PUMP_AMM_PROGRAM
      : getPumpProgram(new PumpBuilder().connection)
    ).idl,
  ).decode(ix.data)!;
  return { tx, ix, decoded };
}
it('builds a real create_v2 with a mint signature and optional atomic initial buy below the packet limit', async () => {
  const f = await fixture();
  for (const initialBuySol of ['0', '0.01']) {
    const input = pumpLaunchSchema.parse({
      name: 'Fixture coin',
      symbol: 'FIX',
      uri: 'ipfs://fixture-metadata',
      initialBuySol,
      holderReward: true,
    });
    const review = await f.builder.build(
      { kind: 'launch', input },
      f.user.publicKey.toBase58(),
    );
    const { tx, decoded } = pumpInstruction(review.transactionBase64);
    const simulated = vi
      .mocked(f.builder.connection.simulateTransaction)
      .mock.calls.at(-1)!;
    expect(Buffer.from(simulated[0].serialize()).toString('base64')).toBe(
      review.transactionBase64,
    );
    expect(simulated[1]).toMatchObject({
      sigVerify: false,
      replaceRecentBlockhash: false,
      accounts: { addresses: [f.user.publicKey.toBase58()] },
    });
    expect(decoded.name).toBe('createV2');
    expect(
      (decoded.data as { isCashbackEnabled: { 0: boolean } }).isCashbackEnabled,
    ).toEqual({ 0: false });
    expect(
      Buffer.from(review.transactionBase64, 'base64').length,
    ).toBeLessThanOrEqual(1232);
    tx.partialSign(f.user);
    expect(tx.verifySignatures()).toBe(true);
    expect(review.maximumQuote).toBe(initialBuySol);
    if (initialBuySol !== '0') {
      expect(
        tx.instructions.filter((ix) => ix.programId.equals(PUMP_PROGRAM_ID)),
      ).toHaveLength(2);
      expect(Number(review.minimumOutput)).toBeGreaterThan(0);
    }
  }
});
it.each([false, true])(
  'uses the mint’s actual token program on v3 bonding curve buys and sells (legacy=%s)',
  async (legacy) => {
    const f = await fixture({ legacy });
    for (const side of ['buy', 'sell'] as const) {
      const input = pumpTradeSchema.parse({
        mint: f.mint.toBase58(),
        quoteMint: NATIVE_MINT.toBase58(),
        side,
        amount: side === 'buy' ? '0.01' : '100',
      });
      const review = await f.builder.build(
        { kind: 'trade', input },
        f.user.publicKey.toBase58(),
      );
      const { decoded, ix } = pumpInstruction(review.transactionBase64);
      expect(decoded.name).toBe(
        side === 'buy' ? 'buyExactQuoteInV3' : 'sellV3',
      );
      expect(ix.keys).toHaveLength(17);
      expect(ix.keys[3].pubkey.toBase58()).toBe(f.tokenProgram.toBase58());
      if (side === 'buy')
        expect(
          (
            decoded.data as { spendableQuoteIn: BN }
          ).spendableQuoteIn.toString(),
        ).toBe(pumpUnits('0.01', 9).toString());
      expect(Number(review.minimumOutput)).toBeGreaterThan(0);
    }
  },
);
it('preserves cashback compatibility through v2 curve trades and v1 AMM trades', async () => {
  for (const complete of [false, true]) {
    const f = await fixture({ complete, cashback: true });
    for (const side of ['buy', 'sell'] as const) {
      const review = await f.builder.build(
        {
          kind: 'trade',
          input: pumpTradeSchema.parse({
            mint: f.mint.toBase58(),
            quoteMint: NATIVE_MINT.toBase58(),
            side,
            amount: side === 'buy' ? '0.01' : '100',
          }),
        },
        f.user.publicKey.toBase58(),
      );
      const decoded = pumpInstruction(
        review.transactionBase64,
        complete,
      ).decoded;
      expect(decoded.name).toBe(
        complete ? side : side === 'buy' ? 'buyV2' : 'sellV2',
      );
    }
  }
});
it('routes migrated tokens to PumpSwap v2 and prices negative virtual reserves without counting retained fees as liquidity', async () => {
  const normal = await fixture({ complete: true }),
    negative = await fixture({ complete: true, negative: true });
  for (const side of ['buy', 'sell'] as const) {
    const build = async (f: typeof normal) =>
      f.builder.build(
        {
          kind: 'trade',
          input: pumpTradeSchema.parse({
            mint: f.mint.toBase58(),
            quoteMint: NATIVE_MINT.toBase58(),
            side,
            amount: side === 'buy' ? '0.01' : '100',
          }),
        },
        f.user.publicKey.toBase58(),
      );
    const a = await build(normal),
      b = await build(negative);
    expect(b.venue).toBe('PumpSwap');
    expect(pumpInstruction(b.transactionBase64, true).decoded.name).toBe(
      side === 'buy' ? 'buyExactQuoteInV2' : 'sellV2',
    );
    expect(Number(b.minimumOutput)).toBeGreaterThan(0);
    expect(
      side === 'buy'
        ? Number(b.expectedOutput) > Number(a.expectedOutput)
        : Number(b.expectedOutput) < Number(a.expectedOutput),
    ).toBe(true);
  }
});
it('checks quote denomination, network identity, UTF-8 limits, simulation failure and on-chain feature gates', async () => {
  const f = await fixture();
  await expect(
    f.builder.build(
      {
        kind: 'trade',
        input: pumpTradeSchema.parse({
          mint: f.mint.toBase58(),
          quoteMint: pk().toBase58(),
          side: 'buy',
          amount: '1',
        }),
      },
      f.user.publicKey.toBase58(),
    ),
  ).rejects.toThrow('correct quote mint');
  const input = pumpLaunchSchema.parse({
    name: '🚀'.repeat(9),
    symbol: 'TEST',
    uri: 'ipfs://fixture',
  });
  await expect(
    f.builder.build({ kind: 'launch', input }, f.user.publicKey.toBase58()),
  ).rejects.toThrow('UTF-8');
  vi.mocked(f.builder.online.fetchGlobal).mockResolvedValue({
    ...global,
    createV2Enabled: false,
  });
  await expect(
    f.builder.build(
      { kind: 'launch', input: { ...input, name: 'Test' } },
      f.user.publicKey.toBase58(),
    ),
  ).rejects.toThrow('disabled');
  vi.mocked(f.builder.online.fetchGlobal).mockResolvedValue(global);
  vi.mocked(f.builder.connection.simulateTransaction).mockResolvedValue({
    context: { slot: 1 },
    value: { err: 'InsufficientFundsForFee', logs: [] },
  });
  await expect(
    f.builder.build(
      { kind: 'launch', input: { ...input, name: 'Test' } },
      f.user.publicKey.toBase58(),
    ),
  ).rejects.toThrow('simulation failed');
  vi.mocked(f.builder.connection.getGenesisHash).mockResolvedValue('devnet');
  await expect(
    f.builder.token(f.mint.toBase58(), f.user.publicKey.toBase58()),
  ).rejects.toThrow('not Solana mainnet');
});
