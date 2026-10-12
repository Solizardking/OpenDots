import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JupiterQuote, JupiterReview } from '../src/shared/jupiter-types';

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  wallet: {} as Record<string, unknown>,
  verify: vi.fn(() => true),
}));
vi.mock('../src/client/api', () => ({ api: fixture.api }));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => fixture.wallet,
}));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletMultiButton: () => createElement('button', {}, 'Connect test wallet'),
}));
vi.mock('@noble/curves/ed25519.js', () => ({
  ed25519: { verify: fixture.verify },
}));
import { JupiterPanel } from '../src/client/JupiterPanel';
import { JupiterQuoteCard } from '../src/client/JupiterQuoteCard';
import { JupiterTransactionCard } from '../src/client/JupiterTransactionCard';

const payer = new PublicKey(new Uint8Array(32).fill(2));
const recipient = new PublicKey(new Uint8Array(32).fill(3));
let root: ReactTestRenderer | undefined;
let review: JupiterReview;
let quote: JupiterQuote;
const text = (node: { children: unknown[] }) =>
  node.children.filter((value) => typeof value === 'string').join('');
const button = (label: string) =>
  root!.root.findAllByType('button').find((node) => text(node) === label)!;
const hasButton = (label: string) =>
  root!.root.findAllByType('button').some((node) => text(node) === label);
const callsEnding = (suffix: string) =>
  fixture.api.mock.calls.filter((call) => String(call[0]).endsWith(suffix));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mountCard() {
  await act(async () => {
    root = create(
      createElement(JupiterTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    );
  });
}
async function mountPanel(
  props: Partial<Parameters<typeof JupiterPanel>[0]> = {},
) {
  await act(async () => {
    root = create(
      createElement(JupiterPanel, {
        threadId: 'thread',
        paused: false,
        ...props,
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
async function change(label: string, value: string) {
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': label })
      .props.onChange({ target: { value } }),
  );
}
async function requestQuote() {
  await act(async () =>
    root!.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.verify.mockReturnValue(true);
  const transaction = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payer,
      recentBlockhash: recipient.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payer,
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
  quote = {
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
    priceImpactPercent: '0.12',
    feeBps: 20,
    platformFeeBps: 5,
    feeMint: input.outputMint,
    gasless: false,
    signatureFeeLamports: '5000',
    prioritizationFeeLamports: '0',
    rentFeeLamports: '0',
    signatureFeePayer: payer.toBase58(),
    route: [],
    observedAt: Date.now(),
    expiresAt: Date.now() + 60000,
    executionAvailable: true,
  };
  review = {
    ...quote,
    id: 'cff3ca93-d6b3-4050-96d8-2bcccd8b5a93',
    threadId: 'thread',
    dotId: 'dot',
    address: payer.toBase58(),
    feePayer: payer.toBase58(),
    transactionVersion: 0,
    transactionBase64: Buffer.from(bytes).toString('base64'),
    transactionHash: createHash('sha256').update(bytes).digest('hex'),
    requiredSigners: [payer.toBase58()],
    deferredSigners: [],
    instructions: [],
    balanceSol: '1',
    inputBalance: '1',
    networkFeeSol: '0.000005',
    estimatedSolDebit: '0.100005',
    simulation: { status: 'passed' },
    computeUnitPriceCeilingMicroLamports: '1000000',
    status: 'prepared',
  };
  fixture.wallet = {
    publicKey: payer,
    connected: true,
    wallet: { adapter: { supportedTransactionVersions: new Set([0]) } },
    signTransaction: vi.fn(async (value: VersionedTransaction) => {
      // Mock bytes plus mocked verification; no private keys or real transaction signatures.
      value.signatures[0] = new Uint8Array(64).fill(42);
      return value;
    }),
  };
  fixture.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/status'))
      return {
        configured: true,
        source: 'Jupiter',
        supportedTransactionVersions: [0],
        message: 'Configured',
      };
    if (path.endsWith('/quote')) return quote;
    if (path.endsWith('/submit'))
      return {
        ...review,
        status: 'submitted',
        signature: 'mock-only-signature',
      };
    if (path.endsWith('/decline')) return { ...review, status: 'declined' };
    return review;
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('requires the explicit review checkbox and submits only mock-signed exact V0 bytes', async () => {
  await mountCard();
  expect(button('Sign & submit swap').props.disabled).toBe(true);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
  await checkReview();
  expect(button('Sign & submit swap').props.disabled).toBe(false);
  await act(async () => {
    button('Sign & submit swap').props.onClick();
    await vi.waitFor(() => expect(callsEnding('/submit')).toHaveLength(1));
  });
  expect(fixture.wallet.signTransaction).toHaveBeenCalledTimes(1);
  expect(callsEnding('/submit')).toHaveLength(1);
  const body = callsEnding('/submit')[0][2];
  expect(body).toMatchObject({
    confirm: true,
    transactionHash: review.transactionHash,
  });
  const signed = VersionedTransaction.deserialize(
    Buffer.from(body.signedTransactionBase64, 'base64'),
  );
  const original = VersionedTransaction.deserialize(
    Buffer.from(review.transactionBase64, 'base64'),
  );
  expect(signed.message.serialize()).toEqual(original.message.serialize());
  expect(
    root!.root.findAllByType('span').some((node) => text(node) === 'submitted'),
  ).toBe(true);
  expect(root!.root.findAllByProps({ type: 'password' })).toHaveLength(0);
});

it('resets review approval on a wallet change and blocks an expired review or a wallet without V0 support', async () => {
  await mountCard();
  await checkReview();
  fixture.wallet.publicKey = recipient;
  await act(async () =>
    root!.update(
      createElement(JupiterTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    ),
  );
  expect(hasButton('Sign & submit swap')).toBe(false);
  expect(callsEnding('/decline')).toHaveLength(1);
  await act(async () => root!.unmount());
  root = undefined;
  fixture.wallet.publicKey = payer;
  fixture.wallet.wallet = {
    adapter: { supportedTransactionVersions: new Set(['legacy']) },
  };
  await mountCard();
  await checkReview();
  expect(button('Sign & submit swap').props.disabled).toBe(true);
  await act(async () => root!.unmount());
  root = undefined;
  fixture.wallet.wallet = {
    adapter: { supportedTransactionVersions: new Set([0]) },
  };
  review = { ...review, expiresAt: Date.now() - 1 };
  await mountCard();
  expect(hasButton('Sign & submit swap')).toBe(false);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});

it('does not submit when a wallet changes the transaction or when the card closes during its prompt', async () => {
  fixture.wallet.signTransaction = vi.fn(
    async (transaction: VersionedTransaction) => {
      transaction.message.recentBlockhash = payer.toBase58();
      transaction.signatures[0] = new Uint8Array(64).fill(42);
      return transaction;
    },
  );
  await mountCard();
  await checkReview();
  await act(async () => {
    button('Sign & submit swap').props.onClick();
    await vi.waitFor(() =>
      expect(fixture.wallet.signTransaction).toHaveBeenCalled(),
    );
  });
  expect(callsEnding('/submit')).toHaveLength(0);
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'changed the reviewed transaction',
  );
  const signature = deferred<VersionedTransaction>();
  let requested!: VersionedTransaction;
  fixture.wallet.signTransaction = vi.fn(
    (transaction: VersionedTransaction) => {
      requested = transaction;
      return signature.promise;
    },
  );
  await act(async () =>
    root!.update(
      createElement(JupiterTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    ),
  );
  await act(async () => button('Sign & submit swap').props.onClick());
  await vi.waitFor(() => expect(requested).toBeDefined());
  await act(async () => root!.unmount());
  root = undefined;
  requested.signatures[0] = new Uint8Array(64).fill(42);
  await act(async () => signature.resolve(requested));
  expect(callsEnding('/submit')).toHaveLength(0);
  expect(callsEnding('/decline')).toHaveLength(1);
});

it('blocks submission when the inline tool completes while its wallet prompt is pending', async () => {
  const signature = deferred<VersionedTransaction>();
  let requested!: VersionedTransaction;
  fixture.wallet.signTransaction = vi.fn(
    (transaction: VersionedTransaction) => {
      requested = transaction;
      return signature.promise;
    },
  );
  await mountCard();
  await checkReview();
  await act(async () => {
    button('Sign & submit swap').props.onClick();
    await vi.waitFor(() => expect(requested).toBeDefined());
  });
  await act(async () =>
    root!.update(
      createElement(JupiterTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
        status: 'complete',
      }),
    ),
  );
  requested.signatures[0] = new Uint8Array(64).fill(42);
  await act(async () => signature.resolve(requested));
  expect(callsEnding('/submit')).toHaveLength(0);
  expect(hasButton('Sign & submit swap')).toBe(false);
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'No transaction was submitted',
  );
});

it('does not open a wallet prompt when the tool completes during transaction validation', async () => {
  const digest = deferred<ArrayBuffer>();
  const spy = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementationOnce(() => digest.promise);
  try {
    await mountCard();
    await checkReview();
    await act(async () => button('Sign & submit swap').props.onClick());
    await act(async () =>
      root!.update(
        createElement(JupiterTransactionCard, {
          args: { requestId: review.id },
          threadId: 'thread',
          status: 'complete',
        }),
      ),
    );
    const hash = Uint8Array.from(Buffer.from(review.transactionHash, 'hex'));
    await act(async () => digest.resolve(hash.buffer));
    expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
    expect(callsEnding('/submit')).toHaveLength(0);
  } finally {
    spy.mockRestore();
  }
});

it('invalidates a pending wallet prompt when the connected wallet changes', async () => {
  const signature = deferred<VersionedTransaction>();
  let requested!: VersionedTransaction;
  fixture.wallet.signTransaction = vi.fn(
    (transaction: VersionedTransaction) => {
      requested = transaction;
      return signature.promise;
    },
  );
  await mountCard();
  await checkReview();
  await act(async () => button('Sign & submit swap').props.onClick());
  await vi.waitFor(() => expect(requested).toBeDefined());
  fixture.wallet.publicKey = recipient;
  await act(async () =>
    root!.update(
      createElement(JupiterTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    ),
  );
  requested.signatures[0] = new Uint8Array(64).fill(42);
  await act(async () => signature.resolve(requested));
  expect(callsEnding('/submit')).toHaveLength(0);
  expect(callsEnding('/decline')).toHaveLength(1);
  expect(hasButton('Sign & submit swap')).toBe(false);
});

it('discards and declines a prepared initial GET that arrives after the trading wallet changes', async () => {
  const initial = deferred<JupiterReview>();
  const originalApi = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, ...args: unknown[]) =>
    path.endsWith(review.id) ? initial.promise : originalApi(path, ...args),
  );
  await mountCard();
  fixture.wallet.publicKey = recipient;
  await act(async () =>
    root!.update(
      createElement(JupiterTransactionCard, {
        args: { requestId: review.id },
        threadId: 'thread',
      }),
    ),
  );
  await act(async () => initial.resolve(review));
  expect(hasButton('Sign & submit swap')).toBe(false);
  expect(callsEnding('/decline')).toHaveLength(1);
  expect(callsEnding('/submit')).toHaveLength(0);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});

it('keeps an uncertain submission recorded and refreshes its status without submitting again', async () => {
  let submitted = false;
  const originalApi = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, ...args: unknown[]) => {
    if (path.endsWith('/submit')) {
      submitted = true;
      return Promise.reject(Error('Provider response was lost.'));
    }
    if (submitted && path.endsWith(review.id))
      return Promise.resolve({ ...review, status: 'submitted' });
    return originalApi(path, ...args);
  });
  await mountCard();
  await checkReview();
  await act(async () => button('Sign & submit swap').props.onClick());
  await vi.waitFor(() => expect(callsEnding('/submit')).toHaveLength(1));
  await act(async () => {});
  expect(hasButton('Sign & submit swap')).toBe(false);
  expect(root!.root.findByProps({ role: 'alert' }).children.join('')).toContain(
    'response was lost',
  );
  await act(async () => button('Refresh recorded status').props.onClick());
  expect(callsEnding('/submit')).toHaveLength(1);
  expect(fixture.wallet.signTransaction).toHaveBeenCalledTimes(1);
  expect(
    root!.root.findAllByType('span').some((node) => text(node) === 'submitted'),
  ).toBe(true);
});

it('renders a useful quote-only provider failure with no wallet-signing action', async () => {
  quote = {
    ...quote,
    executionAvailable: false,
    preparationError: 'Provider could not build a transaction.',
  };
  await act(async () => {
    root = create(
      createElement(JupiterQuoteCard, {
        name: 'jupiter_quote',
        toolCallId: 'call',
        status: 'complete',
        result: JSON.stringify(quote),
      }),
    );
  });
  expect(
    root!.root.findByProps({ 'aria-label': 'Jupiter quote' }),
  ).toBeDefined();
  expect(
    root!.root.findByProps({ role: 'status' }).children.join(''),
  ).toContain('could not build');
  expect(root!.root.findAllByType('dt').map(text)).toContain('Minimum output');
  expect(root!.root.findAllByType('button')).toHaveLength(0);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});

it('quotes without a conversation and preserves the first independently created preparation context', async () => {
  const context = deferred<string>();
  const onPrepare = vi.fn(() => context.promise);
  await mountPanel({ threadId: undefined, onPrepare });
  await requestQuote();
  expect(onPrepare).not.toHaveBeenCalled();
  expect(callsEnding('/quote')[0][2]).toMatchObject({
    input: { mode: 'order', slippageBps: 'rtse', fast: false, maxAccounts: 64 },
  });
  await act(async () => button('Prepare swap review').props.onClick());
  expect(onPrepare).toHaveBeenCalledTimes(1);
  review = { ...review, threadId: 'created-context' };
  await act(async () =>
    root!.update(
      createElement(JupiterPanel, {
        threadId: 'created-context',
        onPrepare,
        paused: false,
      }),
    ),
  );
  await act(async () => context.resolve('created-context'));
  expect(
    fixture.api.mock.calls.find(
      (call) => call[0] === '/conversations/created-context/jupiter/prepare',
    )?.[2],
  ).toMatchObject({ address: payer.toBase58(), input: { amount: '0.1' } });
  expect(
    root!.root.findByProps({ 'aria-label': 'Review Jupiter transaction' }),
  ).toBeDefined();
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});

it('aborts an edited quote and prevents its stale response from restoring the prior draft', async () => {
  const stale = deferred<JupiterQuote>();
  const originalApi = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, ...args: unknown[]) =>
    path.endsWith('/quote') ? stale.promise : originalApi(path, ...args),
  );
  await mountPanel();
  await requestQuote();
  const quoteSignal = callsEnding('/quote')[0][3] as AbortSignal;
  expect(quoteSignal.aborted).toBe(false);
  await change('Jupiter amount', '0.2');
  expect(quoteSignal.aborted).toBe(true);
  await act(async () => stale.resolve(quote));
  expect(
    root!.root.findAllByProps({ 'aria-label': 'Jupiter quote' }),
  ).toHaveLength(0);
  expect(
    root!.root.findByProps({ 'aria-label': 'Jupiter amount' }).props.value,
  ).toBe('0.2');
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});

it('declines a prepared review when its draft changes and declines a preparation returned after close', async () => {
  await mountPanel();
  await act(async () => button('Prepare swap review').props.onClick());
  expect(hasButton('Sign & submit swap')).toBe(true);
  await change('Jupiter amount', '0.2');
  expect(hasButton('Sign & submit swap')).toBe(false);
  expect(callsEnding('/decline')).toHaveLength(1);
  await act(async () => root!.unmount());
  root = undefined;
  fixture.api.mockClear();
  const stale = deferred<JupiterReview>();
  const originalApi = fixture.api.getMockImplementation()!;
  fixture.api.mockImplementation((path: string, ...args: unknown[]) =>
    path.endsWith('/prepare') ? stale.promise : originalApi(path, ...args),
  );
  await mountPanel();
  await act(async () => button('Prepare swap review').props.onClick());
  const prepareSignal = callsEnding('/prepare')[0][3] as AbortSignal;
  await act(async () => root!.unmount());
  root = undefined;
  expect(prepareSignal.aborted).toBe(true);
  await act(async () => stale.resolve(review));
  expect(callsEnding('/decline')).toHaveLength(1);
  expect(callsEnding('/submit')).toHaveLength(0);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});

it('bounds custom-build accounts and fixed slippage, and keeps fast routing limited to build mode', async () => {
  await mountPanel();
  await change('Jupiter mode', 'build');
  await change('Jupiter slippage policy', 'fixed');
  await change('Jupiter slippage', '0.12');
  await change('Jupiter max accounts', '65');
  await act(async () =>
    root!.root
      .findByProps({ type: 'checkbox' })
      .props.onChange({ target: { checked: true } }),
  );
  await requestQuote();
  expect(callsEnding('/quote')).toHaveLength(0);
  await change('Jupiter max accounts', '32');
  await requestQuote();
  expect(callsEnding('/quote')[0][2]).toMatchObject({
    input: { mode: 'build', fast: true, maxAccounts: 32, slippageBps: 12 },
  });
  await change('Jupiter mode', 'order');
  await requestQuote();
  expect(callsEnding('/quote')[1][2]).toMatchObject({
    input: { mode: 'order', fast: false, maxAccounts: 64, slippageBps: 12 },
  });
  await change('Jupiter slippage', '5.01');
  await requestQuote();
  expect(callsEnding('/quote')).toHaveLength(2);
});

it('declines the previous immutable request when the card conversation changes', async () => {
  await mountCard();
  await checkReview();
  await act(async () =>
    root!.update(
      createElement(JupiterTransactionCard, {
        args: { requestId: review.id },
        threadId: 'other-thread',
      }),
    ),
  );
  expect(
    fixture.api.mock.calls.some(
      (call) =>
        call[0] ===
        `/conversations/thread/jupiter/requests/${review.id}/decline`,
    ),
  ).toBe(true);
  expect(fixture.wallet.signTransaction).not.toHaveBeenCalled();
});
