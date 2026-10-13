import { createElement } from 'react';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BirdeyeResult, BirdeyeStatus } from '../src/shared/birdeye-types';

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  authHeaders: vi.fn(() => ({ Authorization: 'Bearer fixture-owner' })),
}));
vi.mock('../src/client/api', () => fixture);
import { BirdeyePanel, birdeyeChatGPTUrl } from '../src/client/BirdeyePanel';
import {
  BirdeyeChart,
  BirdeyeResultView,
  BirdeyeToolCard,
  birdeyeChartPoints,
} from '../src/client/BirdeyeToolCard';

const mint = 'So11111111111111111111111111111111111111112';
const wallet = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let root: ReactTestRenderer | undefined;
let status: BirdeyeStatus;
let answer: BirdeyeResult;
const onAskDot = vi.fn();
const visible = () => JSON.stringify(root!.toJSON());
const queryCalls = () =>
  fixture.api.mock.calls.filter(([path]) => path === '/birdeye/query');
function children(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : children(child)))
    .join('');
}
function button(label: string) {
  return root!.root
    .findAllByType('button')
    .find((node) => children(node).trim() === label)!;
}
async function click(label: string) {
  await act(async () => {
    await button(label).props.onClick();
  });
}
async function mount() {
  await act(async () => {
    root = create(
      createElement(BirdeyePanel, {
        threadId: 'thread-one',
        connectedAddress: wallet,
        paused: false,
        onClose: vi.fn(),
        onAskDot,
      }),
    );
  });
}
async function select(workflow: string) {
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': 'Birdeye research workflow' })
      .props.onChange({ target: { value: workflow } }),
  );
}
async function field(label: string, value: string) {
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': label })
      .props.onChange({ target: { value } }),
  );
}
async function submit() {
  await act(async () => {
    root!.root
      .findByProps({ className: 'birdeye-query' })
      .props.onSubmit({ preventDefault() {} });
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { hidden: false });
  fixture.api.mockReset();
  onAskDot.mockReset();
  status = {
    configured: true,
    chain: 'solana',
    source: 'Birdeye',
    state: 'ready',
    message: 'Server connection configured. Provider access varies by plan.',
    walletLimits: { perSecond: 5, perMinute: 75 },
  };
  answer = {
    source: 'Birdeye',
    workflow: 'portfolio',
    observedAt: Date.now(),
    warnings: [],
    data: {
      totalValue: 1100,
      holdings: [
        {
          symbol: 'SOL',
          address: mint,
          amount: 5,
          balance: 5000000000,
          rawBalance: '5000000000',
          value: 1100,
          price: 220,
        },
      ],
      equityCurve: [
        { unix_time: 1781000000, net_worth: 1000 },
        { unix_time: 1781086400, net_worth: 1100 },
      ],
      pnlSummary: {
        pnl: { realized_profit_usd: 20, unrealized_usd: null, total_usd: 20 },
        counts: { win_rate: 0.6 },
        unique_tokens: 2,
      },
      tokenPnl: [],
    },
  };
  fixture.api.mockImplementation(async (path: string) => {
    if (path.startsWith('/birdeye/status')) return status;
    if (path === '/birdeye/query') return answer;
    if (path.startsWith('/birdeye/alerts?'))
      return { source: 'Birdeye', alerts: [], events: [] };
    if (path === '/birdeye/alerts')
      return { source: 'Birdeye', alert: { id: 'alert-one' } };
    throw new Error(`Unexpected test route ${path}`);
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('starts with connection state only and reads an explicitly selected wallet at limit 100', async () => {
  await mount();
  expect(queryCalls()).toHaveLength(0);
  expect(
    root!.root.findByProps({ 'aria-label': 'Birdeye wallet address' }).props
      .value,
  ).toBe('');
  await click('Use connected wallet');
  await submit();
  expect(queryCalls()[0][2]).toMatchObject({
    threadId: 'thread-one',
    workflow: 'portfolio',
    address: wallet,
    limit: 100,
    duration: '30d',
  });
  expect(visible()).toContain('$1,100.00');
  expect(visible()).toContain('60.00%');
  const tables = root!.root.findAllByType('table').map(children).join('');
  expect(tables).toContain('Amount');
  expect(tables).toContain('Value Usd');
  expect(tables).toContain('$1,100.00');
  expect(tables).not.toContain('Raw balance');
  expect(tables).not.toContain('5,000,000,000');
  expect(visible()).toContain('Unavailable');
  expect(
    root!.root.findAllByType('svg').some((node) => node.props.role === 'img'),
  ).toBe(true);
  await click('Ask Dot about this');
  expect(onAskDot).toHaveBeenCalledWith(
    expect.stringContaining(`"address":"${wallet}"`),
  );
});

it('blocks missing and invalid input before calling a provider and shows missing configuration honestly', async () => {
  status.configured = false;
  status.state = 'missing-configuration';
  status.message = 'Add the Birdeye server connection.';
  await mount();
  expect(button('Run research').props.disabled).toBe(true);
  await field('Birdeye wallet address', 'invalid-wallet');
  await submit();
  expect(queryCalls()).toHaveLength(0);
  expect(visible()).toContain('Solana mint or wallet');
  expect(visible()).toContain('Add the Birdeye server connection.');
});

it('shows duplicate-symbol candidates until the user selects a full canonical mint', async () => {
  answer = {
    ...answer,
    workflow: 'search',
    data: {
      items: [
        { symbol: 'DUP', name: 'First token', address: mint },
        { symbol: 'DUP', name: 'Second token', address: wallet },
      ],
    },
  };
  await mount();
  await select('search');
  await act(async () =>
    root!.root
      .findByProps({ placeholder: 'Search, then select the exact token' })
      .props.onChange({ target: { value: 'DUP' } }),
  );
  await submit();
  expect(queryCalls()).toHaveLength(1);
  expect(visible()).toContain('First token');
  expect(visible()).toContain('Second token');
  answer = {
    ...answer,
    workflow: 'investigation',
    data: { address: wallet, panels: {} },
  };
  await act(async () =>
    root!.root
      .findByProps({ 'aria-label': `Investigate token ${wallet}` })
      .props.onClick(),
  );
  expect(queryCalls()[1][2]).toMatchObject({
    workflow: 'investigation',
    address: wallet,
  });
});

it('keeps wallet research private and exports only a public token query after an explicit share step', async () => {
  expect(
    birdeyeChatGPTUrl({ workflow: 'portfolio', address: wallet }),
  ).toBeNull();
  expect(
    birdeyeChatGPTUrl({
      workflow: 'pnl-comparison',
      address: mint,
      wallets: [wallet],
    }),
  ).toBeNull();
  await mount();
  await click('Use connected wallet');
  await submit();
  expect(root!.root.findAllByType('a')).toHaveLength(0);
  await select('rug-check');
  await field('Birdeye token or wallet address', mint);
  answer = {
    ...answer,
    workflow: 'rug-check',
    data: { address: mint, gate: 'unknown', checks: [] },
  };
  await submit();
  expect(root!.root.findAllByType('a')).toHaveLength(0);
  await click('Open in ChatGPT');
  const external = root!.root.findByType('a');
  expect(external.props.rel).toBe('noopener noreferrer');
  const prompt = new URL(external.props.href).searchParams.get('q')!;
  expect(prompt).toContain(mint);
  expect(prompt).not.toContain(wallet);
  expect(prompt).not.toContain('holdings');
  expect(prompt).not.toContain('transcript');
});

it('ignores late results after a workflow changes and aborts the obsolete request', async () => {
  const late = deferred<BirdeyeResult>();
  await mount();
  fixture.api.mockImplementation((path: string) =>
    path === '/birdeye/query' ? late.promise : Promise.resolve(status),
  );
  await click('Use connected wallet');
  await submit();
  const signal = queryCalls()[0][3] as AbortSignal;
  await select('credits');
  expect(signal.aborted).toBe(true);
  await act(async () => late.resolve(answer));
  expect(visible()).not.toContain('Wallet equity');
  expect(button('Run research').props.disabled).toBe(false);
});

it('shows tier failures and partial evidence without reporting a clean risk result', async () => {
  await mount();
  await select('rug-check');
  await field('Birdeye token or wallet address', mint);
  fixture.api.mockRejectedValueOnce(
    new Error('Holder profiling is unavailable on this Birdeye plan.'),
  );
  await submit();
  expect(visible()).toContain('unavailable on this Birdeye plan');
  answer = {
    ...answer,
    workflow: 'rug-check',
    partial: true,
    warnings: ['Some checks are unavailable.'],
    data: {
      gate: 'unknown',
      checks: [{ name: 'Mint authority', state: 'unknown' }],
      panels: {
        ownership: { status: 'error', error: 'Plan upgrade required.' },
      },
    },
  };
  fixture.api.mockResolvedValue(answer);
  await submit();
  expect(visible()).toContain('Partial coverage');
  expect(visible()).toContain('unknown');
  expect(visible()).toContain('Plan upgrade required.');
});

it('distinguishes known security ratios and renounced authorities from missing evidence', async () => {
  const data = {
    address: mint,
    panels: {
      security: {
        status: 'ready',
        data: {
          ownerAddress: null,
          freezeAuthority: null,
          top10HolderPercent: 0.1,
          creatorPercentage: 0.02,
          mutableMetadata: null,
        },
      },
      ownership: { status: 'ready', data: { percent_of_supply: 15 } },
    },
  };
  await act(async () => {
    root = create(
      createElement(BirdeyeResultView, {
        result: { ...answer, workflow: 'investigation', data },
      }),
    );
  });
  const metricText = root!.root
    .findAllByProps({ className: 'birdeye-metrics' })
    .map(children)
    .join(' ');
  expect(metricText).toContain('Top10Holder Percent10.00%');
  expect(metricText).toContain('Creator Percentage2.00%');
  expect(metricText).toContain('Owner AddressRenounced');
  expect(metricText).toContain('Freeze AuthorityRenounced');
  expect(metricText).toContain('Mutable MetadataUnavailable');
  expect(metricText).toContain('Percent of supply15.00%');
  await act(async () =>
    root!.update(
      createElement(BirdeyeResultView, {
        result: {
          ...answer,
          workflow: 'investigation',
          partial: true,
          warnings: ['Security coverage is incomplete.'],
          data: {
            panels: {
              security: { status: 'error', error: 'Security unavailable.' },
            },
          },
        },
      }),
    ),
  );
  expect(visible()).toContain('Security unavailable.');
  expect(visible()).not.toContain('Renounced');
});

it('loads cumulative wallet track records using the explicit wallets parameter', async () => {
  await mount();
  await select('smart-money');
  await act(async () =>
    root!.root
      .findByProps({ placeholder: 'One public wallet address per line' })
      .props.onChange({ target: { value: wallet } }),
  );
  answer = {
    ...answer,
    workflow: 'smart-money',
    data: {
      items: [],
      trackRecords: {
        [wallet]: {
          status: 'ready',
          data: {
            scope: 'all-time cumulative',
            summary: {
              pnl: {
                realized_profit_usd: 80,
                unrealized_usd: 20,
                total_usd: 100,
              },
              counts: { win_rate: 0.75 },
            },
            tokens: [],
          },
        },
      },
    },
  };
  await submit();
  expect(queryCalls()[0][2]).toMatchObject({
    workflow: 'smart-money',
    wallets: [wallet],
    duration: 'all',
  });
  expect(queryCalls()[0][2]).not.toHaveProperty('address');
  expect(visible()).toContain('All-time cumulative history');
  expect(visible()).toContain('75.00%');
});

it('accepts a negative percent alert and keeps a degraded poll message visible', async () => {
  await mount();
  await select('chart');
  await field('Birdeye token or wallet address', mint);
  await click('Watch & alerts');
  const watch = root!.root.findByProps({
    'aria-label': 'Birdeye alerts and live watch',
  });
  await act(async () =>
    watch
      .findAllByType('select')[0]
      .props.onChange({ target: { value: 'percent' } }),
  );
  await act(async () =>
    watch
      .findAllByType('select')[1]
      .props.onChange({ target: { value: 'below' } }),
  );
  await act(async () =>
    watch
      .findByProps({ type: 'number' })
      .props.onChange({ target: { value: '-10' } }),
  );
  await act(async () =>
    watch.findByType('form').props.onSubmit({ preventDefault() {} }),
  );
  expect(fixture.api).toHaveBeenCalledWith(
    '/birdeye/alerts',
    'POST',
    expect.objectContaining({
      threadId: 'thread-one',
      address: mint,
      threshold: -10,
      direction: 'below',
      kind: 'percent',
      timeframe: '24h',
    }),
  );
  fixture.api.mockImplementation(async (path: string) =>
    path === '/birdeye/alerts/poll'
      ? {
          source: 'Birdeye',
          state: 'degraded',
          alerts: [],
          events: [],
          error: 'Closed candle unavailable; not confirmed.',
        }
      : { alerts: [], events: [] },
  );
  await click('Check saved alerts');
  expect(visible()).toContain('Closed candle unavailable; not confirmed.');
});

it('orders and deduplicates actual chart samples without inventing missing prices', async () => {
  const items = [
    { unix_time: 2, c: 5 },
    { unix_time: 1, c: 4 },
    { unix_time: 2, c: 6 },
    { unix_time: 3, c: null },
    { unix_time: 4, c: 'NaN' },
  ];
  expect(birdeyeChartPoints(items)).toEqual([
    { time: 1, close: 4 },
    { time: 2, close: 6 },
  ]);
  await act(async () => {
    root = create(
      createElement(BirdeyeChart, { items, label: 'Price in USD' }),
    );
  });
  expect(
    children(root!.root.findByProps({ className: 'birdeye-chart-scale' })),
  ).toContain('2 actual observations');
  expect(visible()).toContain('$6.00');
});

it('renders tool results with null watchlist prices and informative failures', async () => {
  await act(async () => {
    root = create(
      createElement(BirdeyeToolCard, {
        name: 'birdeye_watchlist',
        toolCallId: 'one',
        status: 'complete',
        result: JSON.stringify({
          ...answer,
          workflow: 'watchlist',
          data: {
            items: [{ address: mint, priceUsd: null, unavailable: true }],
          },
        }),
      }),
    );
  });
  expect(visible()).toContain('Unavailable');
  expect(visible()).not.toContain('$0.00');
  await act(async () =>
    root!.update(
      createElement(BirdeyeToolCard, {
        name: 'birdeye_investigation',
        toolCallId: 'two',
        status: 'complete',
        result: { status: 'error', error: 'Birdeye credit budget exhausted.' },
      }),
    ),
  );
  expect(visible()).toContain('Birdeye credit budget exhausted.');
});

it('keeps USD-normalized pool spread confirmation and liquidity drain evidence visible', async () => {
  answer = {
    ...answer,
    workflow: 'cross-dex',
    data: {
      anchor: { value: 1 },
      weightedPriceUsd: 1.01,
      pools: [
        {
          address: mint,
          source: 'Pool A',
          priceUsd: 1.03,
          deviationPercent: 3,
          confirmed: false,
        },
        {
          address: wallet,
          source: 'Pool B',
          priceUsd: 1.1,
          deviationPercent: 10,
          confirmed: true,
        },
      ],
    },
  };
  await act(async () => {
    root = create(createElement(BirdeyeResultView, { result: answer }));
  });
  expect(visible()).toContain('Confirmed');
  expect(visible()).toContain('unconfirmed');
  expect(visible()).toContain('Pool A');
  await act(async () =>
    root!.update(
      createElement(BirdeyeResultView, {
        result: {
          ...answer,
          workflow: 'liquidity',
          data: {
            pool: { address: mint, source: 'Raydium' },
            series: [
              {
                unix_time: 1781000000,
                open_liquidity_usd: 100000,
                close_liquidity_usd: 50000,
                priceClose: 1,
                cause: 'withdrawal',
                flagged: true,
              },
            ],
            flagged: [{}],
          },
        },
      }),
    ),
  );
  expect(visible()).toContain('Aligned token price in USD');
  expect(visible()).toContain('withdrawal');
  expect(visible()).toContain('Raydium');
});

it('opens one authenticated live feed, bounds observations and aborts when stopped', async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
  });
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  vi.stubGlobal('fetch', fetch);
  await mount();
  await select('chart');
  await field('Birdeye token or wallet address', mint);
  await click('Watch & alerts');
  await click('Start live feed');
  expect(fetch).toHaveBeenCalledWith(
    '/api/birdeye/stream',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        Authorization: 'Bearer fixture-owner',
      }),
    }),
  );
  const init = fetch.mock.calls[0][1] as RequestInit;
  expect(JSON.parse(String(init.body))).toMatchObject({
    threadId: 'thread-one',
    prices: [mint],
    wallets: [],
    minVolume: 10000,
  });
  expect(JSON.stringify(init)).not.toContain('x-api-key');
  await act(async () =>
    streamController.enqueue(encoder.encode('event: heartbeat\ndata: {}\n\n')),
  );
  expect(visible()).not.toContain('Recent live observations');
  await act(async () =>
    streamController.enqueue(
      encoder.encode(
        Array.from(
          { length: 70 },
          (_, index) =>
            `event: birdeye\ndata: ${JSON.stringify({ id: String(index), kind: 'price', observedAt: Date.now(), state: 'connected', data: { address: mint, price: index + 1 } })}\n\n`,
        ).join(''),
      ),
    ),
  );
  expect(
    children(
      root!.root
        .findAllByType('summary')
        .find((item) => children(item).includes('Recent live observations'))!,
    ),
  ).toContain('50/50');
  await click('Stop live feed');
  expect(init.signal!.aborted).toBe(true);
  await act(async () => streamController.close());
  expect(visible()).toContain('Stopped');
});

it('backfills chart history before its oldest sample and refreshes only when enabled and visible', async () => {
  vi.useFakeTimers();
  answer = {
    ...answer,
    workflow: 'chart',
    data: {
      address: mint,
      hasMore: true,
      nextBefore: 1781000000,
      items: [
        { unix_time: 1781000000, c: 4 },
        { unix_time: 1781086400, c: 5 },
      ],
    },
  };
  await mount();
  await select('chart');
  await field('Birdeye token or wallet address', mint);
  await submit();
  await click('Load earlier history');
  expect(queryCalls()[1][2]).toMatchObject({
    before: 1781000000,
    timeTo: 1780999999,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
  });
  expect(queryCalls()).toHaveLength(2);
  await act(async () =>
    root!.root
      .findByProps({ type: 'checkbox' })
      .props.onChange({ target: { checked: true } }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(queryCalls()).toHaveLength(3);
  vi.stubGlobal('document', { hidden: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
  });
  expect(queryCalls()).toHaveLength(3);
  await select('credits');
  vi.stubGlobal('document', { hidden: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120000);
  });
  expect(queryCalls()).toHaveLength(3);
});

it('refreshes verified provider state once after research and adopts the low-credit cadence without a query loop', async () => {
  vi.useFakeTimers();
  let provider = structuredClone(status);
  answer = {
    ...answer,
    workflow: 'chart',
    data: { address: mint, items: [{ unix_time: 1781000000, c: 4 }] },
  };
  fixture.api.mockImplementation(async (path: string) => {
    if (path.startsWith('/birdeye/status')) return structuredClone(provider);
    if (path === '/birdeye/query') {
      provider = {
        ...status,
        message: 'Birdeye access verified. Credit budget low.',
        credits: { remaining: 100, checkedAt: Date.now(), low: true },
      };
      return answer;
    }
    throw new Error(`Unexpected test route ${path}`);
  });
  await mount();
  await select('chart');
  await field('Birdeye token or wallet address', mint);
  await submit();
  expect(visible()).toContain('Birdeye access verified. Credit budget low.');
  expect(
    fixture.api.mock.calls.filter(([path]) =>
      String(path).startsWith('/birdeye/status'),
    ),
  ).toHaveLength(2);
  expect(queryCalls()).toHaveLength(1);
  await act(async () =>
    root!.root
      .findByProps({ type: 'checkbox' })
      .props.onChange({ target: { checked: true } }),
  );
  expect(
    children(root!.root.findByProps({ className: 'birdeye-checkbox' })),
  ).toContain('3 minutes');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(179999);
  });
  expect(queryCalls()).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(queryCalls()).toHaveLength(2);
  expect(
    fixture.api.mock.calls.filter(([path]) =>
      String(path).startsWith('/birdeye/status'),
    ),
  ).toHaveLength(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(179999);
  });
  expect(queryCalls()).toHaveLength(2);
});

it('refreshes provider status after a failed read while preserving the actionable request error', async () => {
  let failed = false;
  fixture.api.mockImplementation(async (path: string) => {
    if (path.startsWith('/birdeye/status'))
      return {
        ...status,
        state: failed ? 'tier-unavailable' : 'ready',
        message: failed
          ? 'Birdeye reports a plan restriction.'
          : status.message,
      };
    if (path === '/birdeye/query') {
      failed = true;
      throw new Error('Holder profiling requires a higher Birdeye plan.');
    }
    throw new Error(`Unexpected test route ${path}`);
  });
  await mount();
  await click('Use connected wallet');
  await submit();
  expect(visible()).toContain('Birdeye reports a plan restriction.');
  expect(visible()).toContain(
    'Holder profiling requires a higher Birdeye plan.',
  );
  expect(
    fixture.api.mock.calls.filter(([path]) =>
      String(path).startsWith('/birdeye/status'),
    ),
  ).toHaveLength(2);
  expect(queryCalls()).toHaveLength(1);
});
