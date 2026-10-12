import { createHash } from 'node:crypto';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { beforeEach, expect, it, vi } from 'vitest';
import type { JupiterReview } from '../src/shared/jupiter-types';

const fixture = vi.hoisted(() => ({ verify: vi.fn(() => true) }));
vi.mock('@noble/curves/ed25519.js', () => ({
  ed25519: { verify: fixture.verify },
}));
import {
  bytesBase64,
  decodeJupiterReview,
  validateJupiterSignature,
} from '../src/client/jupiter-signing';

const sponsor = new PublicKey(new Uint8Array(32).fill(1));
const taker = new PublicKey(new Uint8Array(32).fill(2));
const recipient = new PublicKey(new Uint8Array(32).fill(3));

function unsignedFixture(): {
  transaction: VersionedTransaction;
  review: JupiterReview;
} {
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: sponsor,
      recentBlockhash: recipient.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: taker,
          toPubkey: recipient,
          lamports: 1,
        }),
      ],
    }).compileToV0Message(),
  );
  const bytes = transaction.serialize();
  const input = {
    inputMint: 'So11111111111111111111111111111111111111112',
    outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '0.1',
    mode: 'order' as const,
    slippageBps: 'rtse' as const,
    fast: false,
    maxAccounts: 64,
  };
  const review: JupiterReview = {
    source: 'Jupiter',
    network: 'solana-mainnet',
    mode: 'order',
    input,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inputDecimals: 9,
    outputDecimals: 6,
    inputAmount: '0.1',
    expectedOutput: '10',
    minimumOutput: '9.9',
    inAmount: '100000000',
    outAmount: '10000000',
    otherAmountThreshold: '9900000',
    router: 'JupiterZ',
    slippageBps: 100,
    feeBps: 0,
    platformFeeBps: 0,
    gasless: true,
    signatureFeeLamports: '5000',
    prioritizationFeeLamports: '0',
    rentFeeLamports: '0',
    route: [],
    observedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    executionAvailable: true,
    id: 'cff3ca93-d6b3-4050-96d8-2bcccd8b5a93',
    threadId: 'thread',
    dotId: 'dot',
    address: taker.toBase58(),
    feePayer: sponsor.toBase58(),
    transactionVersion: 0,
    transactionBase64: bytesBase64(bytes),
    transactionHash: createHash('sha256').update(bytes).digest('hex'),
    requiredSigners: [sponsor.toBase58(), taker.toBase58()],
    deferredSigners: [sponsor.toBase58()],
    instructions: [],
    balanceSol: '1',
    inputBalance: '1',
    networkFeeSol: '0.000005',
    estimatedSolDebit: '0.1',
    simulation: { status: 'passed' },
    computeUnitPriceCeilingMicroLamports: '1000000',
    status: 'prepared',
  };
  return { transaction, review };
}
function clone(transaction: VersionedTransaction) {
  return VersionedTransaction.deserialize(transaction.serialize());
}
function mockTakerSignature(transaction: VersionedTransaction) {
  // Arbitrary bytes and mocked verification: these never form a real transaction signature.
  transaction.signatures[1] = new Uint8Array(64).fill(42);
  return transaction;
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.verify.mockReturnValue(true);
});

it('decodes only the exact reviewed V0 bytes and rejects a substituted hash or signer metadata', async () => {
  const { transaction, review } = unsignedFixture();
  expect((await decodeJupiterReview(review)).serialize()).toEqual(
    transaction.serialize(),
  );
  await expect(
    decodeJupiterReview({ ...review, transactionHash: '0'.repeat(64) }),
  ).rejects.toThrow();
  await expect(
    decodeJupiterReview({ ...review, feePayer: taker.toBase58() }),
  ).rejects.toThrow();
  await expect(
    decodeJupiterReview({ ...review, requiredSigners: [taker.toBase58()] }),
  ).rejects.toThrow();
  await expect(
    decodeJupiterReview({ ...review, address: recipient.toBase58() }),
  ).rejects.toThrow();
});

it('permits only explicitly deferred managed-order signatures while requiring the connected taker', () => {
  const { transaction, review } = unsignedFixture();
  const signed = mockTakerSignature(clone(transaction));
  expect(() =>
    validateJupiterSignature(transaction, signed, review),
  ).not.toThrow();
  expect(() =>
    validateJupiterSignature(transaction, signed, {
      ...review,
      deferredSigners: [],
    }),
  ).toThrow();
  expect(() =>
    validateJupiterSignature(transaction, clone(transaction), review),
  ).toThrow();
  expect(() =>
    validateJupiterSignature(transaction, signed, { ...review, mode: 'build' }),
  ).toThrow();
});

it('rejects message changes and replacement of any original provider signature', () => {
  const { transaction, review } = unsignedFixture();
  transaction.signatures[0] = new Uint8Array(64).fill(17);
  const signed = mockTakerSignature(clone(transaction));
  expect(() =>
    validateJupiterSignature(transaction, signed, review),
  ).not.toThrow();
  signed.signatures[0] = new Uint8Array(64).fill(18);
  expect(() => validateJupiterSignature(transaction, signed, review)).toThrow();
  const changed = mockTakerSignature(clone(transaction));
  changed.message.recentBlockhash = taker.toBase58();
  expect(() =>
    validateJupiterSignature(transaction, changed, review),
  ).toThrow();
});

it('rejects cryptographically invalid signature bytes even when the message is unchanged', () => {
  const { transaction, review } = unsignedFixture();
  fixture.verify.mockReturnValue(false);
  expect(() =>
    validateJupiterSignature(
      transaction,
      mockTakerSignature(clone(transaction)),
      review,
    ),
  ).toThrow();
});
