import { useRef, useState } from 'react';
import {
  PrivyProvider,
  useLinkAccount,
  useLogin,
  useLoginWithOAuth,
  usePrivy,
  type User,
} from '@privy-io/react-auth';
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana';
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
} from '@solana-mobile/wallet-standard-mobile';
import { api, setToken } from './api';
import type { PublicAuthConfig } from './AuthGate';
import type { AuthSession } from '../shared/auth-types';

const connectors = toSolanaWalletConnectors({ shouldAutoConnect: true });
// Solana Mobile Wallet Adapter: lets Android wallets connect through the
// wallet standard. Registration finds no MWA wallet on desktop/iOS, where
// the Privy connectors above remain the path.
try {
  registerMwa({
    appIdentity: {
      name: 'ChatGPTEE',
      uri: 'https://chatgptee.ai',
      icon: 'brand/solana-logomark.svg',
    },
    authorizationCache: createDefaultAuthorizationCache(),
    chains: ['solana:mainnet'],
    chainSelector: createDefaultChainSelector(),
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  });
} catch {
  /* MWA is optional; Privy wallet connectors remain available. */
}
const intentKey = 'chatgptee.privy-auth-intent';
const providers = [
  ['google', 'Google'],
  ['twitter', 'X'],
  ['github', 'GitHub'],
] as const;
type Provider = (typeof providers)[number][0];
type Intent = {
  purpose: 'sign-in' | 'link';
  workspaceId?: string;
  startedAt: number;
};
type Props = {
  config: PublicAuthConfig;
  onSession: (session: AuthSession) => void;
  onError: (error: string) => void;
  link?: boolean;
  workspaceId?: string;
  walletOnly?: boolean;
};
function readIntent(): Intent | undefined {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(intentKey) || 'null',
    ) as Intent | null;
    if (
      value &&
      ['sign-in', 'link'].includes(value.purpose) &&
      Number.isFinite(value.startedAt) &&
      Date.now() >= value.startedAt &&
      Date.now() - value.startedAt < 600000
    )
      return value;
  } catch {
    /* An interrupted or expired redirect must start again. */
  }
}
function SignInButtons({
  config,
  onSession,
  onError,
  link = false,
  workspaceId,
  walletOnly = false,
}: Props) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();
  const [busy, setBusy] = useState(false);
  const exchanging = useRef(false);
  const fail = () => {
    sessionStorage.removeItem(intentKey);
    setBusy(false);
    onError('Sign-in was interrupted or unavailable. Please try again.');
  };
  const complete = async (verifiedUser: User) => {
    const intent = readIntent();
    if (!intent || exchanging.current) return;
    exchanging.current = true;
    setBusy(true);
    onError('');
    try {
      if (
        intent.purpose === 'link' &&
        (!link || intent.workspaceId !== workspaceId)
      )
        throw Error(
          'Sign in to your workspace and start account linking again.',
        );
      const linked = verifiedUser.linkedAccounts.find(
        (account) =>
          account.type === 'wallet' && account.chainType === 'solana',
      );
      const address =
        verifiedUser.wallet?.chainType === 'solana'
          ? verifiedUser.wallet.address
          : linked?.type === 'wallet'
            ? linked.address
            : undefined;
      const accessToken = await getAccessToken();
      if (!accessToken)
        throw Error('Privy could not finish your sign-in. Please try again.');
      setToken('');
      const session = await api<AuthSession>('/auth/privy', 'POST', {
        accessToken,
        purpose: intent.purpose,
        ...(intent.purpose === 'link'
          ? { workspaceId: intent.workspaceId }
          : address
            ? { address }
            : {}),
      });
      if (!session.user || session.owner)
        throw Error(
          'Could not establish your account session. Please try again.',
        );
      if (intent.purpose === 'link' && session.user?.id !== intent.workspaceId)
        throw Error('Your workspace changed. Please sign in again.');
      onSession(session);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : 'Could not verify your sign-in.',
      );
    } finally {
      sessionStorage.removeItem(intentKey);
      exchanging.current = false;
      setBusy(false);
    }
  };
  // Always mounted on login and account pages so redirected OAuth flows finish.
  const { initOAuth, loading } = useLoginWithOAuth({
    onComplete: ({ user }) => void complete(user),
    onError: fail,
  });
  const { linkGoogle, linkTwitter, linkGithub } = useLinkAccount({
    onSuccess: ({ user }) => void complete(user),
    onError: fail,
  });
  const { login } = useLogin({
    onComplete: ({ user }) => void complete(user),
    onError: fail,
  });
  const remember = () => {
    if (link && window.location.pathname !== '/auth/account')
      window.history.replaceState(null, '', '/auth/account');
    sessionStorage.setItem(
      intentKey,
      JSON.stringify({
        purpose: link ? 'link' : 'sign-in',
        workspaceId,
        startedAt: Date.now(),
      } satisfies Intent),
    );
    onError('');
    setBusy(true);
  };
  const begin = async (provider: Provider) => {
    try {
      let sameIdentity = false;
      if (link && authenticated && user) {
        const accounts = await api<{ providerId: string; accountId: string }[]>(
          '/auth/list-accounts',
        );
        sameIdentity = accounts.some(
          (account) =>
            account.providerId === 'privy' && account.accountId === user.id,
        );
      }
      remember();
      if (sameIdentity && user) {
        if (
          user.linkedAccounts.some(
            (account) => account.type === `${provider}_oauth`,
          )
        )
          await complete(user);
        else
          ({ google: linkGoogle, twitter: linkTwitter, github: linkGithub })[
            provider
          ]();
      } else {
        // A cached Privy identity must not silently link a different provider.
        if (authenticated) await logout();
        await initOAuth({ provider });
      }
    } catch {
      fail();
    }
  };
  const WalletContainer = walletOnly ? 'div' : 'details';
  return (
    <>
      {!!config.privySocialProviders?.length && (
        <div
          className="auth-social"
          aria-label={link ? 'Link a social account' : 'Social sign-in'}
        >
          {providers
            .filter(([provider]) =>
              config.privySocialProviders?.includes(provider),
            )
            .map(([provider, label]) => (
              <button
                key={provider}
                disabled={!ready || busy || loading}
                onClick={() => void begin(provider)}
              >
                {link ? 'Link' : 'Continue with'} {label}
              </button>
            ))}
        </div>
      )}
      {!link && (
        <WalletContainer>
          {!walletOnly && <summary>Sign in with Privy</summary>}
          <button
            className="auth-primary"
            disabled={!ready || busy || loading}
            onClick={async () => {
              remember();
              try {
                if (authenticated) await logout();
                login({
                  loginMethods: ['wallet'],
                  walletChainType: 'solana-only',
                });
              } catch {
                fail();
              }
            }}
          >
            <img
              src="/brand/solana-logomark.svg"
              alt=""
              width={20}
              height={18}
            />
            {busy
              ? 'Verifying your sign-in…'
              : !ready
                ? 'Preparing sign-in…'
                : 'Continue with Privy'}
          </button>
          <button
            className="text-button"
            style={{ fontSize: 11, marginTop: 10 }}
            onClick={() => {
              sessionStorage.removeItem(intentKey);
              void logout()
                .then(() => {
                  setBusy(false);
                  onError('');
                })
                .catch(fail);
            }}
          >
            Use a different account
          </button>
        </WalletContainer>
      )}
    </>
  );
}
export default function PrivySignIn({ config, ...props }: Props) {
  return (
    <PrivyProvider
      appId={config.privyAppId!}
      clientId={config.privyClientId}
      config={{
        loginMethods: [
          'wallet',
          ...((config.privySocialProviders || []) as Provider[]),
        ],
        appearance: {
          theme: 'dark',
          accentColor: '#9945ff',
          logo: '/brand/solana-logomark.svg',
          landingHeader: 'Sign in to ChatGPTEE',
          loginMessage: 'Your personal workspace.',
          walletChainType: 'solana-only',
          walletList: [
            'phantom',
            'solflare',
            'backpack',
            'detected_solana_wallets',
            'wallet_connect_qr_solana',
          ],
        },
        externalWallets: {
          solana: { connectors },
        },
        embeddedWallets: {
          solana: { createOnLogin: 'off' },
          ethereum: { createOnLogin: 'off' },
        },
      }}
    >
      <SignInButtons config={config} {...props} />
    </PrivyProvider>
  );
}
