import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthSession } from '../src/shared/auth-types';

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  address: 'fresh-public-wallet',
  connected: false,
  signIn: vi.fn(),
  clawd: { allowed: true } as Record<string, unknown>,
}));
vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    publicKey: fixture.connected ? { toBase58: () => fixture.address } : null,
    connected: fixture.connected,
    signIn: fixture.signIn,
  }),
}));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletMultiButton: ({ children }: { children: ReactNode }) =>
    createElement('button', {}, children ?? 'Connected wallet'),
}));
vi.mock('../src/client/api', () => ({
  // CLAWD gate: these registration tests cover a verified holder by default.
  api: (path: string, ...rest: unknown[]) =>
    path.startsWith('/clawd/status')
      ? Promise.resolve(fixture.clawd)
      : fixture.api(path, ...rest),
  setToken: vi.fn(),
}));
vi.mock('../src/client/better-auth', () => ({ authClient: {} }));
import { AuthGate } from '../src/client/AuthGate';

let root: ReactTestRenderer;
const session: AuthSession = {
  owner: false,
  user: {
    id: 'private-workspace',
    walletAddress: fixture.address,
    displayName: null,
    createdAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  },
};
const anonymous: AuthSession = { user: null, owner: false };
beforeEach(() => {
  vi.clearAllMocks();
  fixture.connected = false;
  fixture.clawd = { allowed: true };
  fixture.address = 'fresh-public-wallet';
  fixture.api.mockImplementation(async (path: string) =>
    path === '/auth/config' ? { betterAuth: true } : anonymous,
  );
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    location: { pathname: '/', search: '' },
    history: { replaceState: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => {
    root = create(
      createElement(AuthGate, {
        children: createElement('p', {}, 'Private workspace'),
      }),
    );
  });
};
const text = () => JSON.stringify(root.toJSON());
it.each(['/register', '/signup', '/register/'])(
  'offers explicit account creation at %s',
  async (path) => {
    window.location.pathname = path;
    await render();
    expect(text()).toContain('Create your account.');
    expect(text()).toContain(
      'Your first sign-in creates your account and private workspace.',
    );
    expect(
      root.root.findAllByType('a').some((node) => node.props.href === '/login'),
    ).toBe(true);
    expect(text()).not.toContain('Private workspace');
  },
);
it.each(['/', '/login', '/signin'])(
  'links new users to registration from %s',
  async (path) => {
    window.location.pathname = path;
    await render();
    expect(
      root.root
        .findAllByType('a')
        .some((node) => node.props.href === '/register'),
    ).toBe(true);
    expect(text()).not.toContain('Create your account.');
  },
);
it('creates a verified wallet session before opening the private workspace', async () => {
  window.location.pathname = '/register';
  fixture.connected = true;
  let accepted = false;
  fixture.api.mockImplementation(async (path: string) => {
    if (path === '/auth/config') return { betterAuth: true };
    if (path === '/auth/solana/nonce')
      return {
        message: 'Verify wallet ownership',
        input: { nonce: 'one-use-nonce' },
      };
    if (path === '/auth/solana/verify') {
      accepted = true;
      return {};
    }
    return accepted ? session : anonymous;
  });
  fixture.signIn.mockResolvedValue({
    account: { address: fixture.address },
    signedMessage: new TextEncoder().encode('Verify wallet ownership'),
    signature: new Uint8Array(64).fill(1),
  });
  await render();
  const button = root.root
    .findAllByType('button')
    .find((node) => node.children.includes('Create account with this wallet'))!;
  await act(async () => {
    await button.props.onClick();
  });
  expect(fixture.api).toHaveBeenCalledWith('/auth/solana/nonce', 'POST', {
    address: fixture.address,
    purpose: 'sign-in',
  });
  expect(fixture.api).toHaveBeenCalledWith(
    '/auth/solana/verify',
    'POST',
    expect.objectContaining({
      nonce: 'one-use-nonce',
      message: 'Verify wallet ownership',
    }),
  );
  expect(text()).toContain('Private workspace');
  expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/');
});
it('keeps registration visible if signature verification does not establish an account cookie', async () => {
  window.location.pathname = '/register';
  fixture.connected = true;
  fixture.api.mockImplementation(async (path: string) => {
    if (path === '/auth/config') return { betterAuth: true };
    if (path === '/auth/solana/nonce')
      return {
        message: 'Verify wallet ownership',
        input: { nonce: 'one-use-nonce' },
      };
    return anonymous;
  });
  fixture.signIn.mockResolvedValue({
    account: { address: fixture.address },
    signedMessage: new TextEncoder().encode('Verify wallet ownership'),
    signature: new Uint8Array(64).fill(1),
  });
  await render();
  const button = root.root
    .findAllByType('button')
    .find((node) => node.children.includes('Create account with this wallet'))!;
  await act(async () => {
    await button.props.onClick();
  });
  expect(text()).toContain(
    'Could not establish your account session. Please try again.',
  );
  expect(text()).not.toContain('Private workspace');
  expect(window.history.replaceState).not.toHaveBeenCalled();
});
it('restores a server-authenticated session without requiring a new wallet signature', async () => {
  fixture.api.mockImplementation(async (path: string) =>
    path === '/auth/config' ? { betterAuth: true } : session,
  );
  await render();
  expect(text()).toContain('Private workspace');
  expect(fixture.signIn).not.toHaveBeenCalled();
});
it('keeps the account session when the user connects a different trading wallet', async () => {
  fixture.api.mockImplementation(async (path: string) =>
    path === '/auth/config' ? { betterAuth: true } : session,
  );
  fixture.connected = true;
  await render();
  fixture.address = 'second-trading-wallet';
  await act(async () => {
    root.update(
      createElement(AuthGate, {
        children: createElement('p', {}, 'Private workspace'),
      }),
    );
  });
  expect(text()).toContain('Private workspace');
  expect(fixture.api).not.toHaveBeenCalledWith('/auth/logout', 'POST', {});
  expect(fixture.api).not.toHaveBeenCalledWith(
    '/auth/solana/verify',
    expect.anything(),
    expect.anything(),
  );
  expect(fixture.signIn).not.toHaveBeenCalled();
});
it('keeps the account session when the connected trading wallet disconnects', async () => {
  fixture.api.mockImplementation(async (path: string) =>
    path === '/auth/config' ? { betterAuth: true } : session,
  );
  fixture.connected = true;
  await render();
  fixture.connected = false;
  await act(async () => {
    root.update(
      createElement(AuthGate, {
        children: createElement('p', {}, 'Private workspace'),
      }),
    );
  });
  expect(text()).toContain('Private workspace');
  expect(fixture.api).not.toHaveBeenCalledWith('/auth/logout', 'POST', {});
});

it('shows the CLAWD gate instead of the workspace for signed-in non-holders', async () => {
  fixture.clawd = {
    allowed: false,
    reason: 'no_wallet',
    minBalance: '0',
    wallets: [],
    buyUrl:
      'https://pump.fun/coin/8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump',
  };
  fixture.api.mockImplementation(async (path: string) =>
    path === '/auth/config' ? { betterAuth: true } : session,
  );
  await render();
  expect(text()).toContain('Hold CLAWD to unlock ChatGPTEE');
  expect(text()).not.toContain('Private workspace');
  expect(
    root.root
      .findAllByType('a')
      .some((node) => String(node.props.href).includes('pump.fun/coin/')),
  ).toBe(true);
});
