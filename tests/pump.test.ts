import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { WalletService } from '../src/server/wallet-service';
import { WorkspaceStore } from '../src/server/workspace';
import { Store } from '../src/server/store';
import { PumpService } from '../src/server/pump-service';
import {
  PumpBuilder,
  PumpBuildError,
  pumpUnits,
  pumpDecimal,
  type PumpBuild,
} from '../src/server/pump-builder';
import { pumpRoutes } from '../src/server/pump-routes';
import {
  pumpLaunchSchema,
  pumpTradeSchema,
  pumpSlippageBps,
} from '../src/shared/pump-types';
import { companionAllows } from '../src/server/companion';
import type { PlatformConfig } from '../src/server/platform-config';
import type { WalletDescriptor } from '../src/shared/wallet-types';

let vault: string, wallets: WalletService, wallet: WalletDescriptor;
const password = 'fixture-pump-wallet-approval-only';
const databases: { close(): void }[] = [];
beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), 'pump-test-'));
  wallets = new WalletService(vault);
  wallet = wallets.create('Pump fixture', password);
});
afterEach(() => {
  vi.restoreAllMocks();
  databases.splice(0).forEach((db) => db.close());
});
afterAll(() => rmSync(vault, { recursive: true, force: true }));
const config: PlatformConfig = {
  pumpEnabled: true,
  baseUrl: '',
  runtimeUrl: '',
  voiceName: '',
  slackUsers: [],
};
const launch = {
  kind: 'launch' as const,
  input: pumpLaunchSchema.parse({
    name: 'Test',
    symbol: 'TEST',
    uri: 'ipfs://fixture',
  }),
};

function fixture() {
  const store = new Store(':memory:'),
    workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const dot = workspace.dots()[0];
  workspace.updateDot(dot.id, { ...dot, walletId: wallet.id });
  workspace.bindThread('pump-thread', dot.id, 'Pump chat');
  workspace.bindThread('other-thread', dot.id, 'Other chat');
  const address = wallet.accounts.find((account) =>
    account.chainId.startsWith('solana:'),
  )!.address;
  const mint = Keypair.generate();
  const tx = new Transaction({
    feePayer: new PublicKey(address),
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.createAccount({
      fromPubkey: new PublicKey(address),
      newAccountPubkey: mint.publicKey,
      lamports: 1,
      space: 0,
      programId: SystemProgram.programId,
    }),
  );
  tx.partialSign(mint);
  const built: PumpBuild = {
    network: 'solana-mainnet',
    kind: 'launch',
    venue: 'Pump bonding curve',
    mint: mint.publicKey.toBase58(),
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteLabel: 'SOL',
    inputAmount: '0',
    expectedOutput: '0',
    minimumOutput: '0',
    maximumQuote: '0',
    slippageBps: 100,
    networkFeeSol: '0.00001',
    estimatedSolDebit: '0.000010001',
    balanceSol: '1',
    lastValidBlockHeight: 200,
    transactionBase64: tx
      .serialize({ requireAllSignatures: false })
      .toString('base64'),
    instructions: [],
  };
  const builder = new PumpBuilder();
  vi.spyOn(builder, 'build').mockResolvedValue(built);
  vi.spyOn(builder, 'requireMainnet').mockResolvedValue();
  vi.spyOn(builder.connection, 'getBlockHeight').mockResolvedValue(100);
  const send = vi
    .spyOn(builder.connection, 'sendRawTransaction')
    .mockImplementation(async (bytes) =>
      bs58.encode(Transaction.from(bytes).signature!),
    );
  const status = vi
    .spyOn(builder.connection, 'getSignatureStatuses')
    .mockResolvedValue({
      context: { slot: 1 },
      value: [
        {
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: 'confirmed',
        },
      ],
    });
  let now = 1000000;
  const pump = new PumpService(
    store.database,
    workspace,
    wallets,
    config,
    () => store.settings().paused,
    builder,
    () => now,
  );
  return {
    store,
    workspace,
    dot,
    pump,
    builder,
    send,
    status,
    built,
    advance: () => {
      now += 76000;
    },
  };
}
it('prepares without signing and requires the reviewed hash; signs both payer and mint correctly with the real OWS signer', async () => {
  const f = fixture(),
    sign = vi.spyOn(wallets, 'sign');
  const review = await f.pump.prepare('pump-thread', launch);
  expect(sign).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  await expect(
    f.pump.approve('pump-thread', review.id, '0'.repeat(64), {
      type: 'owner',
      value: password,
    }),
  ).rejects.toThrow('does not match');
  const result = await f.pump.approve(
    'pump-thread',
    review.id,
    review.transactionHash,
    { type: 'owner', value: password },
  );
  expect(result.status).toBe('confirmed');
  const bytes = f.send.mock.calls[0][0];
  expect(Transaction.from(bytes).verifySignatures()).toBe(true);
  expect(sign).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(password);
  expect(
    f.store.database
      .prepare('SELECT review, signedTransaction FROM pump_requests')
      .get(),
  ).not.toEqual(
    expect.objectContaining({ review: expect.stringContaining(password) }),
  );
  await f.pump.approve('pump-thread', review.id, review.transactionHash, {
    type: 'owner',
    value: password,
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(sign).toHaveBeenCalledTimes(1);
});
it('allows only one concurrent approval and blocks cross-conversation requests', async () => {
  const f = fixture(),
    review = await f.pump.prepare('pump-thread', launch);
  await expect(f.pump.review('other-thread', review.id)).rejects.toThrow(
    'not found',
  );
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      f.pump.approve('pump-thread', review.id, review.transactionHash, {
        type: 'owner',
        value: password,
      }),
    ),
  );
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('expires stale blockhashes and quotes and never signs a declined or superseded request', async () => {
  const f = fixture(),
    old = await f.pump.prepare('pump-thread', launch);
  const current = await f.pump.prepare('pump-thread', launch);
  await expect(
    f.pump.approve('pump-thread', old.id, old.transactionHash, {
      type: 'owner',
      value: password,
    }),
  ).rejects.toThrow('expired');
  f.pump.decline('pump-thread', current.id);
  await expect(
    f.pump.approve('pump-thread', current.id, current.transactionHash, {
      type: 'owner',
      value: password,
    }),
  ).rejects.toThrow('declined');
  const next = await f.pump.prepare('pump-thread', launch);
  f.advance();
  await expect(
    f.pump.approve('pump-thread', next.id, next.transactionHash, {
      type: 'owner',
      value: password,
    }),
  ).rejects.toThrow('expired');
  const block = await f.pump.prepare('pump-thread', launch);
  vi.mocked(f.builder.connection.getBlockHeight).mockResolvedValue(201);
  await expect(
    f.pump.approve('pump-thread', block.id, block.transactionHash, {
      type: 'owner',
      value: password,
    }),
  ).rejects.toThrow('expired');
  expect(f.send).not.toHaveBeenCalled();
});
it('honors pause and changed wallet assignment at approval time', async () => {
  const f = fixture(),
    review = await f.pump.prepare('pump-thread', launch);
  f.store.updateSettings({ paused: true });
  await expect(
    f.pump.approve('pump-thread', review.id, review.transactionHash, {
      type: 'owner',
      value: password,
    }),
  ).rejects.toThrow('Resume');
  f.store.updateSettings({ paused: false });
  f.workspace.updateDot(f.dot.id, { ...f.dot, walletId: null });
  await expect(
    f.pump.approve('pump-thread', review.id, review.transactionHash, {
      type: 'owner',
      value: password,
    }),
  ).rejects.toThrow('Attach');
  expect(f.send).not.toHaveBeenCalled();
});
it('redacts wrong wallet credentials, leaves the request unsigned, and allows a deliberate retry', async () => {
  const f = fixture(),
    review = await f.pump.prepare('pump-thread', launch);
  await expect(
    f.pump.approve('pump-thread', review.id, review.transactionHash, {
      type: 'owner',
      value: 'wrong-secret-fixture',
    }),
  ).rejects.toThrow('Wallet unlock');
  expect((await f.pump.review('pump-thread', review.id)).status).toBe(
    'prepared',
  );
  expect(f.send).not.toHaveBeenCalled();
  expect(
    (
      await f.pump.approve('pump-thread', review.id, review.transactionHash, {
        type: 'owner',
        value: password,
      })
    ).status,
  ).toBe('confirmed');
});
it('keeps network submission ambiguity separate from confirmation and prevents rebroadcast after restarting', async () => {
  const f = fixture(),
    review = await f.pump.prepare('pump-thread', launch);
  f.send.mockRejectedValue(Error('connection lost'));
  f.status.mockResolvedValue({ context: { slot: 1 }, value: [null] });
  const result = await f.pump.approve(
    'pump-thread',
    review.id,
    review.transactionHash,
    { type: 'owner', value: password },
  );
  expect(result).toMatchObject({
    status: 'submitted',
    signature: expect.any(String),
  });
  const restarted = new PumpService(
    f.store.database,
    f.workspace,
    wallets,
    config,
    () => false,
    f.builder,
  );
  expect(
    (
      await restarted.approve(
        'pump-thread',
        review.id,
        review.transactionHash,
        { type: 'owner', value: password },
      )
    ).status,
  ).toBe('submitted');
  expect(f.send).toHaveBeenCalledTimes(1);
  f.status.mockResolvedValue({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        confirmations: 1,
        err: { InstructionError: [0, 'InvalidArgument'] },
        confirmationStatus: 'confirmed',
      },
    ],
  });
  expect((await restarted.review('pump-thread', review.id)).status).toBe(
    'failed',
  );
});
it('requires explicit route approval, rejects credential or raw transaction injection, and denies phone signing', async () => {
  const f = fixture(),
    app = pumpRoutes(f.pump),
    review = await f.pump.prepare('pump-thread', launch);
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(
    (
      await app.request(
        `/conversations/pump-thread/pump/requests/${review.id}/approve`,
        post({
          transactionHash: review.transactionHash,
          credential: { type: 'owner', value: password },
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    pumpLaunchSchema.safeParse({ ...launch.input, credential: password })
      .success,
  ).toBe(false);
  expect(
    pumpTradeSchema.safeParse({
      mint: review.mint,
      quoteMint: review.quoteMint,
      side: 'buy',
      amount: '1e3',
      transactionBase64: review.transactionBase64,
    }).success,
  ).toBe(false);
  expect(
    companionAllows(
      'POST',
      `/api/conversations/pump-thread/pump/requests/${review.id}/approve`,
    ),
  ).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});
it('uses exact decimal u64 arithmetic and rejects lost precision, zero output and excessive slippage', () => {
  expect(pumpSlippageBps('1.1')).toBe(110);
  expect(pumpSlippageBps('0.3')).toBe(30);
  expect(pumpSlippageBps('20.00')).toBe(2000);
  expect(() => pumpSlippageBps('0.29')).toThrow('0.1% steps');
  expect(() => pumpSlippageBps('1.001')).toThrow('0.1% steps');
  expect(pumpUnits('18446744073.709551615', 9).toString()).toBe(
    '18446744073709551615',
  );
  expect(() => pumpUnits('18446744073.709551616', 9)).toThrow('u64');
  expect(() => pumpUnits('0.0000000001', 9)).toThrow('decimal');
  expect(() => pumpUnits('0', 9)).toThrow('positive');
  expect(pumpDecimal(pumpUnits('1000.1', 9), 9)).toBe('1000.1');
  expect(pumpDecimal(1000, 0)).toBe('1000');
  expect(
    pumpLaunchSchema.safeParse({ ...launch.input, slippageBps: 2001 }).success,
  ).toBe(false);
  expect(
    pumpLaunchSchema.safeParse({ ...launch.input, cashback: true }).success,
  ).toBe(false);
});

async function connectedFixture() {
  const f = fixture(),
    payer = Keypair.generate(),
    mint = Keypair.generate();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: 1,
      space: 0,
      programId: SystemProgram.programId,
    }),
  );
  transaction.partialSign(mint);
  vi.mocked(f.builder.build).mockResolvedValue({
    ...f.built,
    mint: mint.publicKey.toBase58(),
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false })
      .toString('base64'),
  });
  // A hosted workspace has no local signing enabled or Dot wallet assigned.
  f.workspace.updateDot(f.dot.id, { ...f.dot, walletId: null });
  const pump = new PumpService(
    f.store.database,
    f.workspace,
    wallets,
    { ...config, pumpEnabled: false },
    () => f.store.settings().paused,
    f.builder,
    () => 1000000,
  );
  const review = await pump.prepareConnected(
    'pump-thread',
    launch,
    payer.publicKey.toBase58(),
  );
  const signed = Transaction.from(
    Buffer.from(review.transactionBase64, 'base64'),
  );
  signed.partialSign(payer);
  return {
    ...f,
    pump,
    payer,
    mint,
    review,
    signed,
    signedBase64: signed.serialize().toString('base64'),
  };
}
it('prepares for a connected wallet without a local Dot wallet or server signing, verifies all mint/payer signatures and submits once', async () => {
  const sign = vi.spyOn(wallets, 'sign'),
    f = await connectedFixture();
  expect(f.review).toMatchObject({
    signerMode: 'connected',
    address: f.payer.publicKey.toBase58(),
    status: 'prepared',
  });
  expect(sign).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(
    (
      await f.pump.submitConnected(
        'pump-thread',
        f.review.id,
        f.review.transactionHash,
        f.signedBase64,
      )
    ).status,
  ).toBe('confirmed');
  await f.pump.submitConnected(
    'pump-thread',
    f.review.id,
    f.review.transactionHash,
    f.signedBase64,
  );
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(sign).not.toHaveBeenCalled();
  expect(Buffer.from(f.send.mock.calls[0][0]).toString('base64')).toBe(
    f.signedBase64,
  );
});
it('opens a private reusable Pump.fun conversation without model configuration and rejects another owner’s Dot', async () => {
  const f = fixture(),
    app = pumpRoutes(f.pump);
  const context = f.pump.context(f.dot.id);
  expect(context).toMatchObject({
    dotId: f.dot.id,
    ownerId: 'owner',
    title: 'Pump.fun',
  });
  expect(f.pump.context(f.dot.id).id).toBe(context.id);
  expect(() => f.pump.context(Keypair.generate().publicKey.toBase58())).toThrow(
    'Select one of your Dots',
  );
  const response = await app.request('/markets/pump/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dotId: f.dot.id }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).id).toBe(context.id);
  expect(f.send).not.toHaveBeenCalled();
});
it('reads the requested signing-wallet balance precisely while paused without thread creation or signing, and rejects invalid addresses and non-mainnet RPC', async () => {
  const f = fixture(),
    app = pumpRoutes(f.pump),
    address = Keypair.generate().publicKey.toBase58();
  const sign = vi.spyOn(wallets, 'sign');
  vi.spyOn(f.builder.connection, 'getBalance').mockResolvedValue(1234567891);
  f.store.updateSettings({ paused: true });
  const response = await app.request(`/markets/pump/wallet/${address}/balance`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    address,
    network: 'solana-mainnet',
    lamports: '1234567891',
    balanceSol: '1.234567891',
    observedAt: 1000000,
  });
  expect(f.builder.connection.getBalance).toHaveBeenCalledWith(
    new PublicKey(address),
    'confirmed',
  );
  expect(f.workspace.conversations()).toHaveLength(2);
  expect(sign).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(
    (await app.request('/markets/pump/wallet/not-a-wallet/balance')).status,
  ).toBe(400);
  vi.mocked(f.builder.connection.getBalance).mockResolvedValue(
    Number.MAX_SAFE_INTEGER + 1,
  );
  expect(
    (await app.request(`/markets/pump/wallet/${address}/balance`)).status,
  ).toBe(502);
  vi.mocked(f.builder.requireMainnet).mockRejectedValue(
    new PumpBuildError('The configured RPC is not Solana mainnet.'),
  );
  expect(
    (await app.request(`/markets/pump/wallet/${address}/balance`)).status,
  ).toBe(502);
});
it('rejects modified messages, missing signatures, wrong review hashes and cross-conversation connected submissions', async () => {
  const f = await connectedFixture();
  const changed = Transaction.from(
    Buffer.from(f.review.transactionBase64, 'base64'),
  );
  changed.instructions[0].data[0] ^= 1;
  changed.partialSign(f.payer, f.mint);
  await expect(
    f.pump.submitConnected(
      'pump-thread',
      f.review.id,
      f.review.transactionHash,
      changed.serialize().toString('base64'),
    ),
  ).rejects.toThrow('exact reviewed');
  await expect(
    f.pump.submitConnected(
      'pump-thread',
      f.review.id,
      f.review.transactionHash,
      f.review.transactionBase64,
    ),
  ).rejects.toThrow('every required signature');
  await expect(
    f.pump.submitConnected(
      'pump-thread',
      f.review.id,
      '0'.repeat(64),
      f.signedBase64,
    ),
  ).rejects.toThrow('does not match');
  await expect(
    f.pump.submitConnected(
      'other-thread',
      f.review.id,
      f.review.transactionHash,
      f.signedBase64,
    ),
  ).rejects.toThrow('not found');
  expect((await f.pump.review('pump-thread', f.review.id)).status).toBe(
    'prepared',
  );
  expect(f.send).not.toHaveBeenCalled();
});
it('blocks stale, declined, superseded and paused connected approvals and concurrent duplicate broadcasts', async () => {
  const f = await connectedFixture();
  f.store.updateSettings({ paused: true });
  await expect(
    f.pump.submitConnected(
      'pump-thread',
      f.review.id,
      f.review.transactionHash,
      f.signedBase64,
    ),
  ).rejects.toThrow('Resume');
  f.store.updateSettings({ paused: false });
  vi.mocked(f.builder.connection.getBlockHeight).mockResolvedValue(201);
  await expect(
    f.pump.submitConnected(
      'pump-thread',
      f.review.id,
      f.review.transactionHash,
      f.signedBase64,
    ),
  ).rejects.toThrow('expired');
  vi.mocked(f.builder.connection.getBlockHeight).mockResolvedValue(100);
  const stale = await f.pump.prepareConnected(
    'pump-thread',
    launch,
    f.payer.publicKey.toBase58(),
  );
  const current = await f.pump.prepareConnected(
    'pump-thread',
    launch,
    f.payer.publicKey.toBase58(),
  );
  await expect(
    f.pump.submitConnected(
      'pump-thread',
      stale.id,
      stale.transactionHash,
      f.signedBase64,
    ),
  ).rejects.toThrow('expired');
  f.pump.decline('pump-thread', current.id);
  await expect(
    f.pump.submitConnected(
      'pump-thread',
      current.id,
      current.transactionHash,
      f.signedBase64,
    ),
  ).rejects.toThrow('declined');
  const final = await f.pump.prepareConnected(
    'pump-thread',
    launch,
    f.payer.publicKey.toBase58(),
  );
  await Promise.allSettled(
    [1, 2].map(() =>
      f.pump.submitConnected(
        'pump-thread',
        final.id,
        final.transactionHash,
        f.signedBase64,
      ),
    ),
  );
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('persists the connected signature before uncertain broadcast and restores its status without resubmission', async () => {
  const f = await connectedFixture();
  f.send.mockRejectedValue(Error('network down'));
  f.status.mockResolvedValue({ context: { slot: 1 }, value: [null] });
  const result = await f.pump.submitConnected(
    'pump-thread',
    f.review.id,
    f.review.transactionHash,
    f.signedBase64,
  );
  expect(result).toMatchObject({
    status: 'submitted',
    signature: bs58.encode(f.signed.signature!),
  });
  const restarted = new PumpService(
    f.store.database,
    f.workspace,
    wallets,
    { ...config, pumpEnabled: false },
    () => false,
    f.builder,
  );
  expect(
    (
      await restarted.submitConnected(
        'pump-thread',
        f.review.id,
        f.review.transactionHash,
        f.signedBase64,
      )
    ).status,
  ).toBe('submitted');
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('requires explicit connected route consent, rejects caller-supplied unsigned message injection and keeps companion signing denied', async () => {
  const f = await connectedFixture(),
    app = pumpRoutes(f.pump);
  const post = (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const path = `/conversations/pump-thread/pump/requests/${f.review.id}/submit`;
  expect(
    (
      await app.request(
        path,
        post({
          transactionHash: f.review.transactionHash,
          signedTransactionBase64: f.signedBase64,
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        '/conversations/pump-thread/pump/connected/launch',
        post({
          address: f.payer.publicKey.toBase58(),
          input: {
            ...launch.input,
            transactionBase64: f.review.transactionBase64,
          },
        }),
      )
    ).status,
  ).toBe(400);
  expect(companionAllows('POST', `/api${path}`)).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  expect(
    (
      await app.request(
        path,
        post({
          confirm: true,
          transactionHash: f.review.transactionHash,
          signedTransactionBase64: f.signedBase64,
        }),
      )
    ).status,
  ).toBe(200);
});
