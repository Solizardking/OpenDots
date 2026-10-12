import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import bs58 from 'bs58';
import { LogOut, ShieldCheck } from 'lucide-react';
import { api, setToken } from './api';
import type { AuthSession, SignInChallenge } from '../shared/auth-types';
import { authClient } from './better-auth';

export interface PublicAuthConfig {
  desktop?: boolean;
  companion?: boolean;
  privyAppId?: string;
  privyClientId?: string;
  betterAuth?: boolean;
  socialProviders?: string[];
  privySocialProviders?: string[];
}
const PrivySignIn = lazy(() => import('./PrivySignIn'));
const AuthContext = createContext<{
  session: AuthSession;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}>({
  session: { user: null, owner: false },
  signOut: async () => {},
  refresh: async () => {},
});
export const useAuth = () => useContext(AuthContext);

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="About ChatGPTEE">
        <div className="auth-wordmark">
          <img src="/brand/solana-logomark.svg" alt="" />
          <span>
            ChatGP<strong>TEE</strong>
          </span>
        </div>
        <div className="auth-story-copy">
          <span className="auth-eyebrow">A WORKSPACE THAT MOVES WITH YOU</span>
          <h1>
            Your ideas.
            <br />
            Your agents.
            <br />
            <em>Your next move.</em>
          </h1>
          <p>
            A home for your personal AI team. Think in chat, work in Spaces, and
            let your Dots follow through.
          </p>
          <div className="auth-capabilities">
            <span>Chat & calls</span>
            <span>Agent computers</span>
            <span>Spaces & pages</span>
          </div>
        </div>
        <footer>
          POWERED BY YOUR SOLANA IDENTITY ·{' '}
          <a href="/authorize">Authorize an agent</a> ·{' '}
          <a href="/docs">Documentation</a> · <a href="/privacy">Privacy</a> ·{' '}
          <a href="/terms">Terms</a> · <a href="/service">Service</a>
        </footer>
      </section>
      <section className="auth-panel">
        <div className="auth-card">
          <img
            className="solana-mark"
            src="/brand/solana-logomark.svg"
            alt=""
          />
          {children}
        </div>
      </section>
    </main>
  );
}

function NativeSignIn({
  onSession,
  onError,
  betterAuth = false,
  purpose = 'sign-in',
  registration = false,
}: {
  onSession: (session: AuthSession) => void;
  onError: (message: string) => void;
  betterAuth?: boolean;
  purpose?: 'sign-in' | 'link';
  registration?: boolean;
}) {
  const { publicKey, signIn, signMessage, connected } = useWallet();
  const [busy, setBusy] = useState(false);
  const authenticate = async () => {
    if (!publicKey) return;
    setBusy(true);
    onError('');
    try {
      setToken('');
      const challenge = await api<SignInChallenge>(
        betterAuth ? '/auth/solana/nonce' : '/auth/challenge',
        'POST',
        {
          address: publicKey.toBase58(),
          ...(betterAuth ? { purpose } : {}),
        },
      );
      let address = publicKey.toBase58(),
        message = challenge.message,
        signature: Uint8Array;
      if (signIn) {
        const output = await signIn(challenge.input);
        address = output.account.address;
        message = new TextDecoder().decode(output.signedMessage);
        signature = output.signature;
      } else if (signMessage)
        signature = await signMessage(new TextEncoder().encode(message));
      else
        throw new Error(
          'This wallet does not support message signing. Choose a different Solana wallet.',
        );
      if (address !== publicKey.toBase58())
        throw Error('Your wallet changed. Request a new sign-in.');
      await api(betterAuth ? '/auth/solana/verify' : '/auth/verify', 'POST', {
        ...(betterAuth
          ? { nonce: challenge.input.nonce }
          : { id: challenge.id, address }),
        message,
        signature: bs58.encode(signature),
      });
      const session = await api<AuthSession>('/auth/session');
      if (!session.user || session.owner)
        throw Error(
          'Could not establish your account session. Please try again.',
        );
      onSession(session);
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : 'Sign-in was interrupted. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <WalletMultiButton>
        {connected ? undefined : 'Connect Solana wallet'}
      </WalletMultiButton>
      {connected && (
        <button
          className="auth-primary"
          style={{ marginTop: 12 }}
          disabled={busy}
          onClick={() => void authenticate()}
        >
          {busy
            ? 'Confirm in your wallet…'
            : purpose === 'link'
              ? 'Link this wallet'
              : registration
                ? 'Create account with this wallet'
                : 'Sign in with this wallet'}
          <ShieldCheck size={17} />
        </button>
      )}
    </>
  );
}

function SocialSignIn({
  config,
  onError,
  link = false,
}: {
  config: PublicAuthConfig;
  onError: (message: string) => void;
  link?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="auth-social"
      aria-label={link ? 'Link a social account' : 'Social sign-in'}
    >
      {(
        [
          ['google', 'Google'],
          ['twitter', 'X'],
          ['github', 'GitHub'],
        ] as const
      ).map(([provider, label]) => {
        const enabled = config.socialProviders?.includes(provider);
        return (
          <button
            key={provider}
            disabled={!enabled || busy}
            onClick={async () => {
              setToken('');
              setBusy(true);
              onError('');
              try {
                const result = await (link
                  ? authClient.linkSocial({
                      provider,
                      callbackURL: '/auth/account',
                    })
                  : authClient.signIn.social({ provider, callbackURL: '/' }));
                if (result.error)
                  throw Error(
                    result.error.message || 'Could not start sign-in.',
                  );
              } catch (error) {
                onError(
                  error instanceof Error
                    ? error.message
                    : 'Could not start sign-in.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {link ? 'Link' : 'Continue with'} {label}
            {!enabled && ' · coming soon'}
          </button>
        );
      })}
    </div>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const registration = ['/register', '/signup'].includes(path);
  const [session, setSession] = useState<AuthSession>();
  const [config, setConfig] = useState<PublicAuthConfig>();
  const [error, setError] = useState('');
  const [ownerToken, setOwnerToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [privyOpen, setPrivyOpen] = useState(false);
  const acceptSession = useCallback((value: AuthSession) => {
    if (
      value.user &&
      ['/register', '/signup', '/login', '/signin'].includes(
        window.location.pathname.replace(/\/+$/, ''),
      )
    )
      window.history.replaceState(null, '', '/');
    setSession(value);
  }, []);
  const refresh = useCallback(async () => {
    setError('');
    try {
      const [config, session] = await Promise.all([
        api<PublicAuthConfig>('/auth/config'),
        api<AuthSession>('/auth/session'),
      ]);
      setConfig(config);
      setSession(session);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not reach the sign-in service.',
      );
    }
  }, []);
  useEffect(() => {
    void refresh();
    if (new URLSearchParams(window.location.search).has('error'))
      setError('Social sign-in could not be completed. Please try again.');
  }, [refresh]);
  useEffect(() => {
    const expired = () => {
      setToken('');
      setSession({ user: null, owner: false });
    };
    window.addEventListener('solana-dots-auth-expired', expired);
    return () =>
      window.removeEventListener('solana-dots-auth-expired', expired);
  }, []);
  const signOut = useCallback(async () => {
    await api('/auth/logout', 'POST', {});
    setToken('');
    setSession({ user: null, owner: false });
    setError('');
  }, []);
  if (session?.user || session?.owner)
    return (
      <AuthContext.Provider
        key={session.user?.id || 'owner'}
        value={{ session, signOut, refresh }}
      >
        {children}
      </AuthContext.Provider>
    );
  if (config?.companion)
    return (
      <AuthFrame>
        <h2>Connect to your Mac.</h2>
        <p>Open Phone in ChatGPTEE on your Mac and create a pairing code.</p>
        <a className="auth-primary" href="/pair">
          Pair this phone
        </a>
        {error && <p role="alert">{error}</p>}
      </AuthFrame>
    );
  return (
    <AuthFrame>
      {registration ? (
        <h2>Create your account.</h2>
      ) : (
        <h2>
          Make yourself
          <br />
          at home.
        </h2>
      )}
      <p>
        {registration
          ? 'Your first sign-in creates your account and private workspace.'
          : 'Choose how to sign in to your personal workspace.'}
      </p>
      <p className="auth-note">
        {registration ? (
          <>
            Already have an account? <a href="/login">Sign in</a>
          </>
        ) : (
          <>
            New here? <a href="/register">Create an account</a>
          </>
        )}
      </p>
      {config ? (
        <>
          <NativeSignIn
            betterAuth={config.betterAuth}
            registration={registration}
            onSession={acceptSession}
            onError={setError}
          />
          {config.privyAppId && !!config.privySocialProviders?.length ? (
            <Suspense fallback={<p>Loading sign-in options…</p>}>
              <PrivySignIn
                config={config}
                onSession={acceptSession}
                onError={setError}
              />
            </Suspense>
          ) : (
            config.betterAuth && (
              <SocialSignIn config={config} onError={setError} />
            )
          )}
          <p className="auth-note">
            <ShieldCheck size={14} aria-hidden="true" /> Your wallet verifies
            it’s you. Your session stays private.
          </p>
          {config.privyAppId && !config.privySocialProviders?.length && (
            <details
              onToggle={(event) => setPrivyOpen(event.currentTarget.open)}
            >
              <summary>Sign in with Privy</summary>
              {privyOpen && (
                <Suspense fallback={<p>Loading wallet sign-in…</p>}>
                  <PrivySignIn
                    config={config}
                    walletOnly
                    onSession={acceptSession}
                    onError={setError}
                  />
                </Suspense>
              )}
            </details>
          )}
          <details>
            <summary>Existing workspace owner</summary>
            <p>
              Use your server’s owner access token to open the original
              workspace.
            </p>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError('');
                setToken(ownerToken);
                try {
                  const session = await api<AuthSession>('/auth/session');
                  if (!session.owner)
                    throw new Error('The owner access token is invalid.');
                  setOwnerToken('');
                  setSession(session);
                } catch (error) {
                  setToken('');
                  setError(
                    error instanceof Error
                      ? error.message
                      : 'Could not unlock the owner workspace.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <input
                aria-label="Owner access token"
                type="password"
                value={ownerToken}
                autoComplete="off"
                onChange={(event) => setOwnerToken(event.target.value)}
                required
              />
              <button disabled={busy} type="submit">
                {busy ? 'Checking…' : 'Open original workspace'}
              </button>
            </form>
          </details>
        </>
      ) : (
        <button
          className="auth-primary"
          disabled={!error}
          onClick={() => void refresh()}
        >
          {error ? 'Retry connection' : 'Connecting…'}
        </button>
      )}
      {error && (
        <p role="alert" className="auth-error" style={{ marginTop: 20 }}>
          {error}
        </p>
      )}
    </AuthFrame>
  );
}

export function AccountControl() {
  const { session, signOut, refresh } = useAuth();
  const { disconnect } = useWallet();
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(
    window.location.pathname === '/auth/account',
  );
  const [config, setConfig] = useState<PublicAuthConfig>();
  useEffect(() => {
    if (settings)
      void api<PublicAuthConfig>('/auth/config')
        .then(setConfig)
        .catch(() => setError('Could not load account settings.'));
  }, [settings]);
  const address = session.user?.walletAddress;
  if (window.solanaDots)
    return (
      <span className="desktop-local-badge">
        <ShieldCheck size={13} /> Local workspace
      </span>
    );
  if (session.companion)
    return (
      <span className="desktop-local-badge">
        <ShieldCheck size={13} /> Paired with Mac
      </span>
    );
  return (
    <div className="account-control">
      <span className="wallet-address" title={address ?? undefined}>
        {address
          ? `${address.slice(0, 4)}…${address.slice(-4)}`
          : session.user?.displayName || (session.owner ? 'Owner' : 'Account')}
      </span>
      <WalletMultiButton />
      {session.user && (
        <button onClick={() => setSettings(!settings)}>Account</button>
      )}
      {settings && session.user && (
        <section className="auth-account" aria-label="Account settings">
          <button
            onClick={() => setSettings(false)}
            aria-label="Close account settings"
          >
            Close
          </button>
          <h2>Your account</h2>
          <p>
            Connect another sign-in method to this workspace. Sign in again if
            your session is more than five minutes old.
          </p>
          {config?.betterAuth && (
            <>
              {config.privyAppId && !!config.privySocialProviders?.length ? (
                <Suspense fallback={<p>Loading account options…</p>}>
                  <PrivySignIn
                    config={config}
                    link
                    workspaceId={session.user.id}
                    onSession={() => void refresh()}
                    onError={setError}
                  />
                </Suspense>
              ) : (
                <SocialSignIn config={config} link onError={setError} />
              )}
              {!address && (
                <NativeSignIn
                  betterAuth
                  purpose="link"
                  onError={setError}
                  onSession={() => void refresh()}
                />
              )}
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <button
        className="icon-button"
        aria-label="Sign out"
        title={error || 'Sign out'}
        onClick={() => {
          void signOut()
            .then(() => disconnect())
            .catch(() => setError('Could not sign out. Please retry.'));
        }}
      >
        <LogOut size={16} />
      </button>
      {error && (
        <span role="alert" className="sr-only">
          {error}
        </span>
      )}
    </div>
  );
}
