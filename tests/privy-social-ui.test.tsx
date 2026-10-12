import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { User } from '@privy-io/react-auth';
import type { AuthSession } from '../src/shared/auth-types';
const fixture = vi.hoisted(() => ({
  loginCallbacks: {} as { onComplete?: (args: { user: User }) => void },
  linkCallbacks: {} as { onSuccess?: (args: { user: User }) => void },
  authenticated: false,
  user: null as User | null,
  initOAuth: vi.fn(),
  logout: vi.fn(),
  api: vi.fn(),
  linkGoogle: vi.fn(),
}));
vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => children,
  usePrivy: () => ({
    ready: true,
    authenticated: fixture.authenticated,
    user: fixture.user,
    getAccessToken: async () => 'verified-privy-token',
    logout: fixture.logout,
  }),
  useLoginWithOAuth: (callbacks: typeof fixture.loginCallbacks) => {
    fixture.loginCallbacks = callbacks;
    return { initOAuth: fixture.initOAuth, loading: false };
  },
  useLogin: () => ({ login: vi.fn() }),
  useLinkAccount: (callbacks: typeof fixture.linkCallbacks) => {
    fixture.linkCallbacks = callbacks;
    return {
      linkGoogle: fixture.linkGoogle,
      linkTwitter: vi.fn(),
      linkGithub: vi.fn(),
    };
  },
}));
vi.mock('@privy-io/react-auth/solana', () => ({
  toSolanaWalletConnectors: () => [],
}));
vi.mock('../src/client/api', () => ({ api: fixture.api, setToken: vi.fn() }));
import PrivySignIn from '../src/client/PrivySignIn';
let root: ReactTestRenderer;
const socialUser = {
  id: 'did:privy:social',
  linkedAccounts: [{ type: 'google_oauth' }],
} as User;
const session = {
  owner: false,
  user: { id: 'workspace', walletAddress: null },
} as AuthSession;
const props = () => ({
  config: {
    privyAppId: 'public-app',
    privySocialProviders: ['google', 'twitter', 'github'],
  },
  onSession: vi.fn(),
  onError: vi.fn(),
});
const button = (label: string) =>
  root.root
    .findAllByType('button')
    .find((node) => node.children.join('') === label)!;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.authenticated = false;
  fixture.user = null;
  fixture.api.mockResolvedValue(session);
  const values = new Map<string, string>();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('window', {
    location: { pathname: '/' },
    history: { replaceState: vi.fn() },
  });
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
it('finishes a redirected social login without a wallet after remounting and ignores repeat completion', async () => {
  const p = props();
  await act(async () => {
    root = create(createElement(PrivySignIn, p));
  });
  await act(async () => {
    await button('Continue with Google').props.onClick();
  });
  expect(fixture.initOAuth).toHaveBeenCalledWith({ provider: 'google' });
  await act(async () => root.unmount());
  await act(async () => {
    root = create(createElement(PrivySignIn, p));
  });
  await act(async () => {
    fixture.loginCallbacks.onComplete!({ user: socialUser });
  });
  expect(fixture.api).toHaveBeenCalledWith('/auth/privy', 'POST', {
    accessToken: 'verified-privy-token',
    purpose: 'sign-in',
  });
  expect(p.onSession).toHaveBeenCalledWith(session);
  expect(sessionStorage.getItem('chatgptee.privy-auth-intent')).toBeNull();
  await act(async () => {
    fixture.loginCallbacks.onComplete!({ user: socialUser });
  });
  expect(fixture.api).toHaveBeenCalledTimes(1);
});
it('clears a cached Privy account before starting a different provider and never logs back in without intent', async () => {
  const p = props();
  fixture.authenticated = true;
  fixture.user = socialUser;
  await act(async () => {
    root = create(createElement(PrivySignIn, p));
  });
  await act(async () => {
    fixture.loginCallbacks.onComplete!({ user: socialUser });
  });
  expect(fixture.api).not.toHaveBeenCalled();
  await act(async () => {
    await button('Continue with X').props.onClick();
  });
  expect(fixture.logout).toHaveBeenCalledTimes(1);
  expect(fixture.initOAuth).toHaveBeenCalledWith({ provider: 'twitter' });
  expect(fixture.logout.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.initOAuth.mock.invocationCallOrder[0],
  );
});
it('links through the existing matching Privy identity and returns the same workspace', async () => {
  const p = { ...props(), link: true, workspaceId: 'workspace' };
  fixture.authenticated = true;
  fixture.user = { ...socialUser, linkedAccounts: [] };
  fixture.api.mockImplementation(async (path: string) =>
    path === '/auth/list-accounts'
      ? [{ providerId: 'privy', accountId: socialUser.id }]
      : session,
  );
  await act(async () => {
    root = create(createElement(PrivySignIn, p));
  });
  await act(async () => {
    await button('Link Google').props.onClick();
  });
  expect(fixture.linkGoogle).toHaveBeenCalledTimes(1);
  expect(fixture.logout).not.toHaveBeenCalled();
  expect(window.history.replaceState).toHaveBeenCalledWith(
    null,
    '',
    '/auth/account',
  );
  await act(async () => {
    fixture.linkCallbacks.onSuccess!({ user: socialUser });
  });
  expect(fixture.api).toHaveBeenCalledWith('/auth/privy', 'POST', {
    accessToken: 'verified-privy-token',
    purpose: 'link',
    workspaceId: 'workspace',
  });
  expect(p.onSession).toHaveBeenCalledWith(session);
});
it('refuses a redirect that returns into a different workspace', async () => {
  const p = { ...props(), link: true, workspaceId: 'workspace' };
  await act(async () => {
    root = create(createElement(PrivySignIn, p));
  });
  await act(async () => {
    await button('Link GitHub').props.onClick();
  });
  await act(async () => root.unmount());
  await act(async () => {
    root = create(
      createElement(PrivySignIn, { ...p, workspaceId: 'another-workspace' }),
    );
  });
  await act(async () => {
    fixture.loginCallbacks.onComplete!({ user: socialUser });
  });
  expect(fixture.api).not.toHaveBeenCalled();
  expect(p.onSession).not.toHaveBeenCalled();
  expect(p.onError).toHaveBeenCalledWith(
    'Sign in to your workspace and start account linking again.',
  );
});
it.each([Date.now() - 600001, Date.now() + 60000])(
  'ignores an expired or future-dated OAuth intent (%s)',
  async (startedAt) => {
    const p = props();
    sessionStorage.setItem(
      'chatgptee.privy-auth-intent',
      JSON.stringify({ purpose: 'sign-in', startedAt }),
    );
    await act(async () => {
      root = create(createElement(PrivySignIn, p));
    });
    await act(async () => {
      fixture.loginCallbacks.onComplete!({ user: socialUser });
    });
    expect(fixture.api).not.toHaveBeenCalled();
    expect(p.onSession).not.toHaveBeenCalled();
  },
);
it('shows an error when the verified Privy exchange returns no application account', async () => {
  const p = props();
  fixture.api.mockResolvedValue({ user: null, owner: false });
  await act(async () => {
    root = create(createElement(PrivySignIn, p));
  });
  await act(async () => {
    await button('Continue with Google').props.onClick();
  });
  await act(async () => {
    fixture.loginCallbacks.onComplete!({ user: socialUser });
  });
  expect(p.onSession).not.toHaveBeenCalled();
  expect(p.onError).toHaveBeenCalledWith(
    'Could not establish your account session. Please try again.',
  );
  expect(sessionStorage.getItem('chatgptee.privy-auth-intent')).toBeNull();
});
