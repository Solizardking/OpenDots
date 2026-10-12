import { afterEach, expect, it, vi } from 'vitest';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { MintLayout, TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import bs58 from 'bs58';
import { Store } from '../src/server/store';
import { WorkspaceStore } from '../src/server/workspace';
import { JupiterService } from '../src/server/jupiter-service';
import {
  JupiterProvider,
  jupiterUnits,
  JUPITER_CU_PRICE_CEILING,
} from '../src/server/jupiter-provider';
import { jupiterSwapSchema } from '../src/shared/jupiter-types';
import { jupiterRoutes } from '../src/server/jupiter-routes';
import type { PlatformConfig } from '../src/server/platform-config';

const close: { close(): void }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  close.splice(0).forEach((db) => db.close());
});
const config: PlatformConfig = {
  baseUrl: '',
  runtimeUrl: '',
  voiceName: '',
  slackUsers: [],
};
const output = Keypair.generate().publicKey;
const input = jupiterSwapSchema.parse({
  inputMint: NATIVE_MINT.toBase58(),
  outputMint: output.toBase58(),
  amount: '0.1',
});
function fixture(
  options: {
    sponsored?: boolean;
    unknownSigner?: boolean;
    presigned?: boolean;
    mode?: 'order' | 'build';
  } = {},
) {
  const store = new Store(':memory:'),
    workspace = new WorkspaceStore(':memory:', 'owner');
  close.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.bindThread('jupiter-thread', dot.id, 'Jupiter');
  workspace.bindThread('other-thread', dot.id, 'Other');
  const taker = Keypair.generate(),
    maker = Keypair.generate(),
    blockhash = Keypair.generate().publicKey.toBase58();
  const ix = SystemProgram.transfer({
    fromPubkey: taker.publicKey,
    toPubkey: output,
    lamports: 100000000,
  });
  if (options.sponsored || options.unknownSigner || options.presigned)
    ix.keys.push({
      pubkey: maker.publicKey,
      isSigner: true,
      isWritable: false,
    });
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: options.sponsored ? maker.publicKey : taker.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
        ix,
      ],
    }).compileToV0Message(),
  );
  if (options.presigned) transaction.sign([maker]);
  const raw: Record<string, unknown> = {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inAmount: '100000000',
    outAmount: '12000000',
    otherAmountThreshold: '11900000',
    swapMode: 'ExactIn',
    slippageBps: 100,
    router: options.sponsored ? 'jupiterz' : 'metis',
    feeBps: 2,
    platformFee: { feeBps: 2, feeMint: input.inputMint },
    gasless: options.sponsored ?? false,
    signatureFeePayer: options.sponsored
      ? maker.publicKey.toBase58()
      : taker.publicKey.toBase58(),
    rentFeePayer: taker.publicKey.toBase58(),
    prioritizationFeePayer: taker.publicKey.toBase58(),
    priceImpact: 0.4,
    routePlan: [
      {
        percent: 100,
        swapInfo: {
          label: 'Fixture pool',
          inputMint: input.inputMint,
          outputMint: input.outputMint,
        },
      },
    ],
  };
  const execute = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'Success',
          code: 0,
          signature: bs58.encode(new Uint8Array(64).fill(1)),
        }),
        { status: 200 },
      ),
  );
  const transport = vi.fn(async (url: string | URL | Request) => {
    const value = new URL(String(url));
    if (value.pathname.endsWith('/execute')) return execute();
    if (value.pathname.endsWith('/build')) {
      const json = (instruction: typeof ix) => ({
        programId: instruction.programId.toBase58(),
        accounts: instruction.keys.map((a) => ({
          pubkey: a.pubkey.toBase58(),
          isSigner: a.isSigner,
          isWritable: a.isWritable,
        })),
        data: instruction.data.toString('base64'),
      });
      return new Response(
        JSON.stringify({
          ...raw,
          router: undefined,
          transactionVersion: 0,
          computeBudgetInstructions: [
            json(
              ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: JUPITER_CU_PRICE_CEILING + 1n,
              }),
            ),
          ],
          setupInstructions: [],
          swapInstruction: json(ix),
          cleanupInstruction: null,
          otherInstructions: [],
          tipInstruction: null,
          addressesByLookupTableAddress: {},
          blockhashWithMetadata: {
            blockhash: [...bs58.decode(blockhash)],
            lastValidBlockHeight: 200,
          },
        }),
      );
    }
    return new Response(
      JSON.stringify({
        ...raw,
        transaction: value.searchParams.has('taker')
          ? Buffer.from(transaction.serialize()).toString('base64')
          : null,
        taker: value.searchParams.get('taker'),
        ...(value.searchParams.has('taker')
          ? {
              requestId: 'provider-id',
              transactionVersion: 0,
              lastValidBlockHeight: '200',
              ...(options.sponsored
                ? {
                    maker: maker.publicKey.toBase58(),
                    expireAt: new Date(1_030_000).toISOString(),
                  }
                : {}),
            }
          : {}),
      }),
    );
  });
  const connection = new Connection('https://rpc.example');
  vi.spyOn(connection, 'getGenesisHash').mockResolvedValue(
    '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  );
  const mintData = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 100000000000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    mintData,
  );
  vi.spyOn(connection, 'getAccountInfo').mockResolvedValue({
    data: mintData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
    lamports: 1,
    rentEpoch: 0,
  });
  vi.spyOn(connection, 'getBalance').mockResolvedValue(1000000000);
  vi.spyOn(connection, 'getBlockHeight').mockResolvedValue(100);
  vi.spyOn(connection, 'isBlockhashValid').mockResolvedValue({
    context: { slot: 1 },
    value: true,
  });
  const simulate = vi
    .spyOn(connection, 'simulateTransaction')
    .mockResolvedValue({
      context: { slot: 1 },
      value: {
        err: null,
        logs: [],
        unitsConsumed: 100000,
        accounts: [
          {
            data: ['', 'base64'],
            owner: SystemProgram.programId.toBase58(),
            executable: false,
            lamports: 899995000,
            rentEpoch: 0,
          },
        ],
      },
    });
  vi.spyOn(connection, 'getFeeForMessage').mockResolvedValue({
    context: { slot: 1 },
    value: 5000,
  });
  const send = vi
    .spyOn(connection, 'sendRawTransaction')
    .mockImplementation(async (bytes) =>
      bs58.encode(
        VersionedTransaction.deserialize(Uint8Array.from(bytes)).signatures[0],
      ),
    );
  const statuses = vi
    .spyOn(connection, 'getSignatureStatuses')
    .mockResolvedValue({ context: { slot: 1 }, value: [null] });
  let now = 1_000_000;
  const provider = new JupiterProvider(
    'https://rpc.example',
    'fixture-key',
    transport as typeof fetch,
    connection,
    () => now,
  );
  const service = new JupiterService(
    store.database,
    workspace,
    config,
    () => store.settings().paused,
    provider,
    () => now,
  );
  return {
    store,
    workspace,
    dot,
    taker,
    maker,
    transaction,
    provider,
    service,
    transport,
    execute,
    send,
    statuses,
    simulate,
    raw,
    advance: () => {
      now += 80000;
    },
  };
}
const sign = (review: { transactionBase64: string }, wallet: Keypair) => {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(review.transactionBase64, 'base64'),
  );
  tx.sign([wallet]);
  return Buffer.from(tx.serialize()).toString('base64');
};
it('converts exact decimal units and validates UI slippage/build limits', () => {
  expect(jupiterUnits('1.1', 9)).toBe('1100000000');
  expect(() => jupiterUnits('0.0000001', 6)).toThrow('decimal places');
  expect(() => jupiterUnits('0', 9)).toThrow('positive');
  expect(() => jupiterUnits('18446744073709551616', 0)).toThrow('u64');
  expect(
    jupiterSwapSchema.safeParse({ ...input, slippageBps: 501 }).success,
  ).toBe(false);
  expect(
    jupiterSwapSchema.safeParse({ ...input, maxAccounts: 65 }).success,
  ).toBe(false);
});
it('renders safe quote-only schemas with optional platform fee amount and absent version/expiry', async () => {
  const f = fixture();
  const quote = await f.service.quote(input);
  expect(quote.executionAvailable).toBe(false);
  expect(quote.expectedOutput).toBe('12');
  expect(quote.platformFeeBps).toBe(2);
  expect(quote.platformFeeAmount).toBeUndefined();
  expect(quote.priceImpactPercent).toBe('0.4');
  expect(quote.transactionVersion).toBeUndefined();
  expect(JSON.stringify(quote)).not.toMatch(
    /transactionBase64|requestId|fixture-key|provider-id/,
  );
  const url = new URL(String(f.transport.mock.calls[0][0]));
  expect(url.origin).toBe('https://api.jup.ag');
  expect(url.searchParams.get('maxSupportedTransactionVersion')).toBe('0');
  expect(url.searchParams.has('taker')).toBe(false);
  expect(url.searchParams.has('slippageBps')).toBe(false);
  expect(f.execute).not.toHaveBeenCalled();
});
it('creates private context without model configuration and requires ownership for review', async () => {
  const f = fixture();
  expect(f.service.context(f.dot.id)).toEqual(f.service.context(f.dot.id));
  expect(() =>
    f.service.context(Keypair.generate().publicKey.toBase58()),
  ).toThrow('Select');
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  expect(() => f.service.list('missing')).toThrow();
  await expect(f.service.review('other-thread', review.id)).rejects.toThrow(
    'not found',
  );
  expect(f.execute).not.toHaveBeenCalled();
});
it('keeps paused read-only quote and context available while blocking preparation', async () => {
  const f = fixture();
  f.store.updateSettings({ paused: true });
  await expect(f.service.quote(input)).resolves.toHaveProperty(
    'source',
    'Jupiter',
  );
  expect(f.service.context(f.dot.id)).toBeDefined();
  await expect(
    f.service.prepare('jupiter-thread', input, f.taker.publicKey.toBase58()),
  ).rejects.toThrow('Resume');
});
it('partial taker signing allows declared JupiterZ deferred payer and never derives zero-payer txid', async () => {
  const f = fixture({ sponsored: true });
  f.execute.mockImplementation(async () => {
    throw Error('fixture network loss');
  });
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  expect(review.deferredSigners).toEqual([f.maker.publicKey.toBase58()]);
  expect(review.feePayer).toBe(f.maker.publicKey.toBase58());
  expect(review.expiresAt).toBe(1_028_000);
  const result = await f.service.submit(
    'jupiter-thread',
    review.id,
    review.transactionHash,
    sign(review, f.taker),
  );
  expect(result.status).toBe('submitted');
  expect(result.signature).toBeUndefined();
  expect(result.error).toMatch('not be submitted again');
  await f.service.submit(
    'jupiter-thread',
    review.id,
    review.transactionHash,
    sign(review, f.taker),
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
});
it('rejects unknown missing signers and unsupported transaction versions', async () => {
  const f = fixture({ unknownSigner: true });
  await expect(
    f.service.prepare('jupiter-thread', input, f.taker.publicKey.toBase58()),
  ).rejects.toThrow('unsupported additional signer');
  f.raw.transactionVersion = 1;
  await expect(f.service.quote(input)).rejects.toThrow('version 0');
});
it('preserves cryptographically verified provider signatures and rejects wallet message mutation', async () => {
  const f = fixture({ presigned: true });
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  const signed = VersionedTransaction.deserialize(
    Buffer.from(sign(review, f.taker), 'base64'),
  );
  signed.signatures[1].fill(0);
  await expect(
    f.service.submit(
      'jupiter-thread',
      review.id,
      review.transactionHash,
      Buffer.from(signed.serialize()).toString('base64'),
    ),
  ).rejects.toThrow('provider signature changed');
  signed.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  signed.sign([f.taker]);
  await expect(
    f.service.submit(
      'jupiter-thread',
      review.id,
      review.transactionHash,
      Buffer.from(signed.serialize()).toString('base64'),
    ),
  ).rejects.toThrow('exact reviewed');
  expect(f.execute).not.toHaveBeenCalled();
});
it('expires, declines and supersedes pending approvals before any execution', async () => {
  const f = fixture();
  const old = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  const current = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  expect((await f.service.review('jupiter-thread', old.id)).status).toBe(
    'expired',
  );
  expect(f.service.decline('jupiter-thread', current.id).status).toBe(
    'declined',
  );
  await expect(
    f.service.submit(
      'jupiter-thread',
      current.id,
      current.transactionHash,
      sign(current, f.taker),
    ),
  ).rejects.toThrow('declined');
  const timed = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  f.advance();
  await expect(
    f.service.submit(
      'jupiter-thread',
      timed.id,
      timed.transactionHash,
      sign(timed, f.taker),
    ),
  ).rejects.toThrow('expired');
  expect(f.execute).not.toHaveBeenCalled();
});
it('advanced Build clamps CU price, simulates sizing/final message, explicitly uses v0/fast/RTSE/accounts and own RPC', async () => {
  const f = fixture();
  const build = {
    ...input,
    mode: 'build' as const,
    fast: true,
    maxAccounts: 48,
  };
  const review = await f.service.prepare(
    'jupiter-thread',
    build,
    f.taker.publicKey.toBase58(),
  );
  expect(review.computeUnitLimit).toBe(120000);
  expect(review.computeUnitPriceMicroLamports).toBe(
    JUPITER_CU_PRICE_CEILING.toString(),
  );
  expect(review.simulation.status).toBe('passed');
  expect(f.simulate).toHaveBeenCalledTimes(2);
  const url = new URL(String(f.transport.mock.calls[0][0]));
  expect(url.searchParams.get('transactionVersion')).toBe('0');
  expect(url.searchParams.get('slippageBps')).toBe('rtse');
  expect(url.searchParams.get('mode')).toBe('fast');
  expect(url.searchParams.get('maxAccounts')).toBe('48');
  const result = await f.service.submit(
    'jupiter-thread',
    review.id,
    review.transactionHash,
    sign(review, f.taker),
  );
  expect(result.status).toBe('submitted');
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.execute).not.toHaveBeenCalled();
});
it('provider Success stays submitted until independent on-chain confirmation', async () => {
  const f = fixture();
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  const signature = bs58.encode(
    VersionedTransaction.deserialize(
      Buffer.from(sign(review, f.taker), 'base64'),
    ).signatures[0],
  );
  f.execute.mockResolvedValue(
    new Response(JSON.stringify({ status: 'Success', code: 0, signature })),
  );
  expect(
    (
      await f.service.submit(
        'jupiter-thread',
        review.id,
        review.transactionHash,
        sign(review, f.taker),
      )
    ).status,
  ).toBe('submitted');
  f.statuses.mockResolvedValue({
    context: { slot: 1 },
    value: [
      { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
    ],
  });
  expect((await f.service.review('jupiter-thread', review.id)).status).toBe(
    'confirmed',
  );
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('refuses stale blockhash, failed simulation, unfunded input and aborted preparation', async () => {
  const f = fixture();
  vi.spyOn(f.provider.connection, 'isBlockhashValid').mockResolvedValue({
    context: { slot: 1 },
    value: false,
  });
  await expect(
    f.service.prepare('jupiter-thread', input, f.taker.publicKey.toBase58()),
  ).rejects.toThrow('expired');
  vi.spyOn(f.provider.connection, 'isBlockhashValid').mockResolvedValue({
    context: { slot: 1 },
    value: true,
  });
  f.simulate.mockResolvedValue({
    context: { slot: 1 },
    value: { err: { InstructionError: [0, 'InvalidArgument'] }, logs: [] },
  });
  await expect(
    f.service.prepare('jupiter-thread', input, f.taker.publicKey.toBase58()),
  ).rejects.toThrow('failed simulation');
  vi.spyOn(f.provider.connection, 'getBalance').mockResolvedValue(1);
  await expect(
    f.service.prepare('jupiter-thread', input, f.taker.publicKey.toBase58()),
  ).rejects.toThrow('insufficient');
});
it('routes demand explicit confirmation and hide provider errors and credentials', async () => {
  const f = fixture();
  const app = jupiterRoutes(f.service);
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  const response = await app.request(
    `/conversations/jupiter-thread/jupiter/requests/${review.id}/submit`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        transactionHash: review.transactionHash,
        signedTransactionBase64: sign(review, f.taker),
      }),
    },
  );
  expect(response.status).toBe(400);
  expect(f.execute).not.toHaveBeenCalled();
  f.transport.mockRejectedValue(Error('fixture-key'));
  const quote = await app.request('/markets/jupiter/quote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  expect(quote.status).toBe(502);
  expect(await quote.text()).not.toContain('fixture-key');
});
it('binds deferred-payer provider receipts to the exact landed transaction before confirming', async () => {
  const f = fixture({ sponsored: true });
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  const complete = VersionedTransaction.deserialize(
    Buffer.from(sign(review, f.taker), 'base64'),
  );
  complete.sign([f.maker]);
  const signature = bs58.encode(complete.signatures[0]);
  f.execute.mockResolvedValue(
    new Response(JSON.stringify({ status: 'Success', code: 0, signature })),
  );
  f.statuses.mockResolvedValue({
    context: { slot: 1 },
    value: [
      { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
    ],
  });
  const transaction = vi
    .spyOn(f.provider.connection, 'getTransaction')
    .mockResolvedValue(null);
  expect(
    (
      await f.service.submit(
        'jupiter-thread',
        review.id,
        review.transactionHash,
        sign(review, f.taker),
      )
    ).status,
  ).toBe('submitted');
  transaction.mockResolvedValue({
    slot: 1,
    meta: null,
    blockTime: 0,
    transaction: {
      message: complete.message,
      signatures: complete.signatures.map((s) => bs58.encode(s)),
    },
    version: 0,
  });
  expect((await f.service.review('jupiter-thread', review.id)).status).toBe(
    'confirmed',
  );
});
it('does not save a preparation after the client aborts its changed draft', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.service.prepare(
      'jupiter-thread',
      input,
      f.taker.publicKey.toBase58(),
      controller.signal,
    ),
  ).rejects.toThrow('draft changed');
  expect(f.service.list('jupiter-thread')).toHaveLength(0);
  expect(f.execute).not.toHaveBeenCalled();
});
it('checks provider lookup table mappings against mainnet and rejects mismatches', async () => {
  const f = fixture();
  const table = Keypair.generate().publicKey;
  f.transport.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          ...f.raw,
          transactionVersion: 0,
          computeBudgetInstructions: [],
          setupInstructions: [],
          swapInstruction: {
            programId: SystemProgram.programId.toBase58(),
            accounts: [
              {
                pubkey: f.taker.publicKey.toBase58(),
                isSigner: true,
                isWritable: true,
              },
            ],
            data: '',
          },
          addressesByLookupTableAddress: {
            [table.toBase58()]: [output.toBase58()],
          },
          blockhashWithMetadata: {
            blockhash: [
              ...bs58.decode(Keypair.generate().publicKey.toBase58()),
            ],
            lastValidBlockHeight: 200,
          },
        }),
      ),
  );
  vi.spyOn(f.provider.connection, 'getAddressLookupTable').mockResolvedValue({
    context: { slot: 1 },
    value: null,
  });
  await expect(
    f.service.prepare(
      'jupiter-thread',
      { ...input, mode: 'build' },
      f.taker.publicKey.toBase58(),
    ),
  ).rejects.toThrow('lookup table differs');
  expect(f.simulate).not.toHaveBeenCalled();
});
it('single-use submission survives concurrent clicks and a service restart without another execute', async () => {
  const f = fixture();
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  const signed = sign(review, f.taker);
  const signature = bs58.encode(
    VersionedTransaction.deserialize(Buffer.from(signed, 'base64'))
      .signatures[0],
  );
  f.execute.mockResolvedValue(
    new Response(JSON.stringify({ status: 'Success', code: 0, signature })),
  );
  const results = await Promise.allSettled([
    f.service.submit(
      'jupiter-thread',
      review.id,
      review.transactionHash,
      signed,
    ),
    f.service.submit(
      'jupiter-thread',
      review.id,
      review.transactionHash,
      signed,
    ),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
  const restart = new JupiterService(
    f.store.database,
    f.workspace,
    config,
    () => false,
    f.provider,
    () => 1000000,
  );
  expect(
    (
      await restart.submit(
        'jupiter-thread',
        review.id,
        review.transactionHash,
        signed,
      )
    ).status,
  ).toBe('submitted');
  expect(f.execute).toHaveBeenCalledTimes(1);
});
it('a late read outage cannot regress a independently confirmed receipt back to submitted', async () => {
  const f = fixture();
  const review = await f.service.prepare(
    'jupiter-thread',
    input,
    f.taker.publicKey.toBase58(),
  );
  f.execute.mockImplementation(async () => {
    throw Error();
  });
  await f.service.submit(
    'jupiter-thread',
    review.id,
    review.transactionHash,
    sign(review, f.taker),
  );
  let finish: (
    value: Awaited<ReturnType<Connection['getSignatureStatuses']>>,
  ) => void = () => {};
  f.statuses.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.review('jupiter-thread', review.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.statuses.mockResolvedValue({
    context: { slot: 1 },
    value: [
      { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' },
    ],
  });
  expect((await f.service.review('jupiter-thread', review.id)).status).toBe(
    'confirmed',
  );
  finish({ context: { slot: 1 }, value: [null] });
  expect((await pending).status).toBe('confirmed');
});
