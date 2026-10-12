import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import type { PumpReview } from '../src/shared/pump-types';

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  wallet: {} as Record<string, unknown>,
}));
vi.mock('../src/client/api', () => ({ api: fixture.api }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => fixture.wallet,
}));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletMultiButton: () => createElement('button', {}, 'Connect test wallet'),
}));
import { PumpTransactionCard } from '../src/client/PumpTransactionCard';
import { PumpPanel } from '../src/client/PumpPanel';

let root: ReactTestRenderer | undefined;
let payer: Keypair;
let review: PumpReview;
const text = (node: { children: unknown[] }) =>
  node.children.filter((value) => typeof value === 'string').join('');
const button = (label: string) =>
  root!.root.findAllByType('button').find((node) => text(node) === label)!;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  payer = Keypair.generate();
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  );
  review = {
    id: '04cbd7cf-4dcb-4c83-9d31-cdf455ec05cf',
    threadId: 'thread',
    dotId: 'dot',
    walletId: `connected:${payer.publicKey}`,
    walletName: 'Connected wallet',
    address: payer.publicKey.toBase58(),
    signerMode: 'connected',
    network: 'solana-mainnet',
    kind: 'buy',
    venue: 'Pump bonding curve',
    mint: Keypair.generate().publicKey.toBase58(),
    quoteMint: 'So11111111111111111111111111111111111111112',
    quoteLabel: 'SOL',
    inputAmount: '0.01',
    expectedOutput: '10',
    minimumOutput: '9.9',
    maximumQuote: '0.01',
    slippageBps: 100,
    networkFeeSol: '0.000005',
    estimatedSolDebit: '0.010005',
    balanceSol: '1',
    expiresAt: Date.now() + 75000,
    lastValidBlockHeight: 100,
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false })
      .toString('base64'),
    transactionHash: 'a'.repeat(64),
    instructions: [],
    status: 'prepared',
  };
  fixture.wallet = {
    publicKey: payer.publicKey,
    connected: true,
    signTransaction: vi.fn(async (transaction: Transaction) => {
      transaction.partialSign(payer);
      return transaction;
    }),
  };
  fixture.api.mockImplementation(async (path: string) =>
    path.endsWith('/submit')
      ? { ...review, status: 'submitted', signature: 'fixture-signature' }
      : review,
  );
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
async function mountCard() {
  await act(async () => {
    root = create(
      createElement(PumpTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    );
  });
}
async function checkReview() {
  await act(async () =>
    root!.root
      .findByProps({ type: 'checkbox' })
      .props.onChange({ target: { checked: true } }),
  );
}
it('requires deliberate review before a mock connected wallet signature and posts only the signed exact transaction', async () => {
  await mountCard();
  expect(root!.root.findAllByProps({ type: 'password' })).toHaveLength(0);
  expect(button('Review in wallet & submit').props.disabled).toBe(true);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
  await checkReview();
  expect(button('Review in wallet & submit').props.disabled).toBe(false);
  await act(async () => button('Review in wallet & submit').props.onClick());
  expect(fixture.wallet.signTransaction).toHaveBeenCalledTimes(1);
  const submission = fixture.api.mock.calls.find((call) =>
    call[0].endsWith('/submit'),
  )!;
  expect(submission[2]).toMatchObject({
    confirm: true,
    transactionHash: review.transactionHash,
  });
  const transaction = Transaction.from(
    Buffer.from(submission[2].signedTransactionBase64, 'base64'),
  );
  expect(transaction.verifySignatures()).toBe(true);
  expect(
    transaction
      .serializeMessage()
      .equals(
        Transaction.from(
          Buffer.from(review.transactionBase64, 'base64'),
        ).serializeMessage(),
      ),
  ).toBe(true);
  expect(
    root!.root.findAllByType('span').some((node) => text(node) === 'submitted'),
  ).toBe(true);
});
it('leaves wallet rejection unsigned in the server and requires the reviewed payer wallet', async () => {
  vi.mocked(
    fixture.wallet.signTransaction as (
      transaction: Transaction,
    ) => Promise<Transaction>,
  ).mockRejectedValue(Error('Wallet declined this request.'));
  await mountCard();
  await checkReview();
  await act(async () => button('Review in wallet & submit').props.onClick());
  expect(
    fixture.api.mock.calls.some((call) => call[0].endsWith('/submit')),
  ).toBe(false);
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'Wallet declined',
  );
  fixture.wallet.publicKey = Keypair.generate().publicKey;
  await act(async () =>
    root!.update(
      createElement(PumpTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    ),
  );
  expect(button('Review in wallet & submit').props.disabled).toBe(true);
  expect(root!.root.findByProps({ type: 'checkbox' }).props.checked).toBe(
    false,
  );
});
it('prevents submission if a wallet rewrites the reviewed message or the review closes while a signature is pending', async () => {
  fixture.wallet.signTransaction = vi.fn(async (transaction: Transaction) => {
    transaction.instructions[0].data[0] ^= 1;
    transaction.partialSign(payer);
    return transaction;
  });
  await mountCard();
  await checkReview();
  await act(async () => button('Review in wallet & submit').props.onClick());
  expect(
    fixture.api.mock.calls.some((call) => call[0].endsWith('/submit')),
  ).toBe(false);
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'exact reviewed transaction',
  );
  let release!: (transaction: Transaction) => void;
  let pending!: Transaction;
  fixture.wallet.signTransaction = vi.fn((transaction: Transaction) => {
    pending = transaction;
    return new Promise<Transaction>((resolve) => {
      release = resolve;
    });
  });
  await act(async () =>
    root!.update(
      createElement(PumpTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    ),
  );
  await act(async () => {
    button('Review in wallet & submit').props.onClick();
  });
  await act(async () => root!.unmount());
  root = undefined;
  pending.partialSign(payer);
  await act(async () => release(pending));
  expect(
    fixture.api.mock.calls.some((call) => call[0].endsWith('/submit')),
  ).toBe(false);
});
it('opens a selected coin for a connected wallet and invalidates the prepared transaction whenever the trade amount changes', async () => {
  const token = {
    mint: review.mint,
    quoteMint: review.quoteMint,
    quoteLabel: 'SOL',
    decimals: 6,
    quoteDecimals: 9,
    venue: review.venue,
    balance: '10',
    solBalance: '1',
    address: review.address,
  };
  fixture.api.mockImplementation(async (path: string) =>
    path.endsWith('/requests')
      ? { requests: [] }
      : path.includes('/token/')
        ? token
        : path.endsWith('/decline')
          ? { ...review, status: 'declined' }
          : review,
  );
  await act(async () => {
    root = create(
      createElement(PumpPanel, {
        threadId: 'thread',
        paused: false,
        onClose: vi.fn(),
        initialMint: review.mint,
        initialMode: 'buy',
      }),
    );
  });
  expect(
    root!.root.findByProps({ 'aria-label': 'Pump token mint' }).props.value,
  ).toBe(review.mint);
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Pump slippage percent' })
      .props.onChange({ target: { value: '1.1' } }),
  );
  await act(async () => button('Inspect coin & balance').props.onClick());
  await act(async () =>
    root!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }),
  );
  expect(
    fixture.api.mock.calls.find((call) =>
      call[0].endsWith('/connected/trade'),
    )?.[2],
  ).toMatchObject({
    address: review.address,
    input: { amount: '0.01', quoteMint: review.quoteMint, slippageBps: 110 },
  });
  expect(button('Review in wallet & submit')).toBeDefined();
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Pump trade amount' })
      .props.onChange({ target: { value: '0.02' } }),
  );
  expect(
    root!.root
      .findAllByType('button')
      .some((node) => text(node) === 'Review in wallet & submit'),
  ).toBe(false);
  expect(
    fixture.api.mock.calls.some((call) =>
      call[0].endsWith(`/${review.id}/decline`),
    ),
  ).toBe(true);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});
