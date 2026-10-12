import { useEffect, useState } from 'react';
import {
  PrivyProvider,
  usePrivy,
  useX402Fetch,
  useCreateWallet,
  useUser,
} from '@privy-io/react-auth';
import {
  toSolanaWalletConnectors,
  useCreateWallet as useCreateSolanaWallet,
} from '@privy-io/react-auth/solana';
import {
  samePaymentOffer,
  isUsdcPaymentOffer,
  usdcBaseUnits,
  type PaymentOffer,
} from '../shared/x402-payment';
import './agent-authorization.css';

interface Config {
  appId?: string;
  clientId?: string;
  authorizationUrl: string;
  oauthOrigin: string;
  paymentOrigins: string[];
  maxPaymentBaseUnits: string;
}
interface Grant {
  id: string;
  created_at: number;
  last_used_at: number | null;
}
const connectors = toSolanaWalletConnectors();

function AgentAccess({ config }: { config: Config }) {
  const { ready, authenticated, login, logout, getAccessToken, user } =
    usePrivy();
  const { createWallet: createEthereumWallet } = useCreateWallet();
  const { refreshUser } = useUser();
  const { createWallet: createSolanaWallet } = useCreateSolanaWallet();
  const { wrapFetchWithPayment } = useX402Fetch();
  const [code, setCode] = useState(
    new URLSearchParams(location.search).get('user_code') ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [endpoint, setEndpoint] = useState(
    'https://pro-api.coingecko.com/api/v3/x402/simple/price?ids=solana&vs_currencies=usd',
  );
  const [limit, setLimit] = useState('0.1');
  const [wallet, setWallet] = useState('');
  const [offers, setOffers] = useState<PaymentOffer[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [result, setResult] = useState('');
  const embedded =
    user?.linkedAccounts.filter(
      (a) => a.type === 'wallet' && a.walletClientType === 'privy',
    ) ?? [];

  async function operation(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The request failed. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function privyRequest(path: string, init?: RequestInit) {
    const token = await getAccessToken();
    if (!token) throw new Error('Sign in with Privy to continue.');
    const response = await fetch(config.oauthOrigin + '/api/oauth/v2' + path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'privy-app-id': config.appId!,
        Authorization: `Bearer ${token}`,
        ...init?.headers,
      },
    });
    if (!response.ok) {
      if (response.status === 400)
        throw new Error(
          'This code is invalid or expired. Restart login in your agent.',
        );
      if (response.status === 401)
        throw new Error('Your Privy session expired. Sign in again.');
      throw new Error(
        `Privy could not complete this request (${response.status}).`,
      );
    }
    return response.json();
  }
  async function verify(action: 'approve' | 'deny') {
    if (!/^[A-Z0-9-]{4,32}$/.test(code.trim()))
      throw new Error('Enter the code displayed by your agent.');
    await privyRequest('/device_verify', {
      method: 'POST',
      body: JSON.stringify({ user_code: code.trim(), action }),
    });
    setMessage(
      action === 'approve'
        ? 'Agent access approved. Return to your agent to finish connecting.'
        : 'Agent access denied.',
    );
    setCode('');
    history.replaceState(null, '', '/authorize');
  }
  async function loadGrants() {
    setGrants((await privyRequest('/grants')).data);
  }
  async function createAgentWallet(chain: 'solana' | 'ethereum') {
    const token = await getAccessToken();
    if (!token) throw new Error('Sign in with Privy to continue.');
    const response = await fetch('/api/agent/wallets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ chain_type: chain }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || 'Could not create your agent wallet.');
    await refreshUser();
    setMessage(
      `${chain === 'solana' ? 'Solana' : 'EVM'} agent wallet ready. ${result.wallet.address}`,
    );
  }
  async function paymentFetch(input: RequestInfo | URL, init?: RequestInit) {
    const token = await getAccessToken();
    if (!token) throw new Error('Sign in with Privy to continue.');
    const target = new URL(endpoint);
    if (
      !config.paymentOrigins.includes(target.origin) ||
      target.username ||
      target.password
    )
      throw new Error('Choose a CoinGecko or Allium HTTPS API.');
    return fetch(
      '/api/agent/resource?url=' + encodeURIComponent(target.toString()),
      {
        ...init,
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          Authorization: `Bearer ${token}`,
        },
      },
    );
  }
  async function reviewPayment() {
    usdcBaseUnits(limit);
    setOffers(null);
    setResult('');
    const response = await paymentFetch(endpoint);
    if (response.status === 402) {
      const body = await response.json();
      if (!Array.isArray(body.accepts) || body.x402Version !== 1)
        throw new Error(
          'This API uses a payment format supported by the agent CLI. Use its fetch command.',
        );
      const supported = body.accepts.filter(isUsdcPaymentOffer);
      if (!supported.length)
        throw new Error(
          'This API has no supported USDC payment offer. No payment was submitted.',
        );
      setOffers(supported);
      setSelected(0);
    } else {
      setResult((await response.text()).slice(0, 12000));
      if (!response.ok)
        throw new Error(
          `The API returned ${response.status}; no payment was submitted.`,
        );
    }
  }
  async function pay() {
    const offer = offers?.[selected];
    if (!offer || !isUsdcPaymentOffer(offer) || !wallet)
      throw new Error('Select a payment wallet and review the price first.');
    const maximum = usdcBaseUnits(limit);
    const wrapped = wrapFetchWithPayment({
      walletAddress: wallet,
      fetch: paymentFetch as typeof fetch,
      maxValue: maximum,
      paymentRequirementsSelector: (requirements) => {
        const match = requirements.find((next) =>
          samePaymentOffer(offer, next),
        );
        if (!match)
          throw new Error(
            'The API changed its price or recipient. Review the payment again.',
          );
        return match;
      },
    });
    const response = await wrapped(endpoint);
    setResult((await response.text()).slice(0, 12000));
    setOffers(null);
    if (!response.ok)
      throw new Error(
        `The API returned ${response.status}. Check the facilitator response before retrying a payment.`,
      );
    setMessage('API response received.');
  }

  return (
    <main className="agent-page">
      <header>
        <a className="agent-brand" href="/">
          <img src="/logo.png" alt="" />
          <strong>ChatGPTEE</strong>
        </a>
        <a href="/">Open workspace</a>
      </header>
      <section className="agent-intro">
        <span className="auth-eyebrow">YOUR AGENTS. YOUR CONTROL.</span>
        <h1>Authorize an agent</h1>
        <p>
          Connect a self-hosted agent to your Privy wallets. Match the code
          shown in your agent before approving access.
        </p>
      </section>
      {error && (
        <p role="alert" className="agent-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="agent-success">
          {message}
        </p>
      )}
      <section className="agent-box">
        <h2>Connect your agent</h2>
        <label>
          Agent code
          <input
            aria-label="Agent code"
            value={code}
            maxLength={32}
            placeholder="ABCD-1234"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        </label>
        <p>
          Approval lets this agent sign messages and make wallet transactions
          under your Privy wallet policies. You can revoke access below.
        </p>
        {!authenticated ? (
          <button
            disabled={!ready || busy}
            onClick={() =>
              login({
                loginMethods: ['wallet'],
                walletChainType: 'solana-only',
              })
            }
          >
            {ready ? 'Sign in with Privy' : 'Preparing sign-in…'}
          </button>
        ) : (
          <>
            <p className="agent-identity">
              Signed in: {user?.wallet?.address ?? user?.id}
            </p>
            <p>
              Create a user-owned Privy wallet for agent signing before
              approving access.
            </p>
            <div className="agent-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void operation(() => createAgentWallet('solana'))
                }
              >
                Create Solana agent wallet
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void operation(() => createAgentWallet('ethereum'))
                }
              >
                Create EVM agent wallet
              </button>
            </div>
            <div className="agent-actions">
              <button
                disabled={busy || !code.trim()}
                onClick={() => void operation(() => verify('approve'))}
              >
                Approve agent access
              </button>
              <button
                className="secondary"
                disabled={busy || !code.trim()}
                onClick={() => void operation(() => verify('deny'))}
              >
                Deny access
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await logout();
                    setGrants(null);
                  })
                }
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </section>
      <section className="agent-box">
        <h2>Manage agent access</h2>
        <p>
          Revoking access stops token refresh immediately. An issued access
          token may remain valid for up to 15 minutes.
        </p>
        <button
          className="secondary"
          disabled={!authenticated || busy}
          onClick={() => void operation(loadGrants)}
        >
          Refresh authorizations
        </button>
        {grants?.length === 0 && <p>No active agent authorizations.</p>}
        {grants?.map((g) => (
          <div key={g.id} className="agent-grant">
            <div>
              <code>{g.id}</code>
              <small>
                Authorized {new Date(g.created_at * 1000).toLocaleString()}
              </small>
            </div>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void operation(async () => {
                  await privyRequest('/grants/' + encodeURIComponent(g.id), {
                    method: 'DELETE',
                  });
                  await loadGrants();
                  setMessage('Agent authorization revoked.');
                })
              }
            >
              Revoke access
            </button>
          </div>
        ))}
      </section>
      <section className="agent-box" id="payments">
        <h2>Pay for an API with x402</h2>
        <p>
          Use USDC in a Privy embedded wallet. Review the network, token and
          recipient before submitting a payment.
        </p>
        <div className="agent-actions">
          <button
            className="secondary"
            disabled={!authenticated || busy}
            onClick={() =>
              void operation(async () => {
                await createSolanaWallet();
                setMessage(
                  'Solana payment wallet created. Fund it with USDC before paying.',
                );
              })
            }
          >
            Create Solana payment wallet
          </button>
          <button
            className="secondary"
            disabled={!authenticated || busy}
            onClick={() =>
              void operation(async () => {
                await createEthereumWallet();
                setMessage(
                  'EVM payment wallet created. Fund it with USDC on the API’s network before paying.',
                );
              })
            }
          >
            Create EVM payment wallet
          </button>
        </div>
        <label>
          Payment wallet
          <select value={wallet} onChange={(e) => setWallet(e.target.value)}>
            <option value="">Choose an embedded wallet</option>
            {embedded.map(
              (a) =>
                a.type === 'wallet' && (
                  <option key={a.address} value={a.address}>
                    {a.chainType}: {a.address}
                  </option>
                ),
            )}
          </select>
        </label>
        <label>
          API URL
          <input
            type="url"
            value={endpoint}
            onChange={(e) => {
              setEndpoint(e.target.value);
              setOffers(null);
            }}
          />
        </label>
        <label>
          Maximum payment (USDC)
          <input
            inputMode="decimal"
            value={limit}
            onChange={(e) => {
              setLimit(e.target.value);
              setOffers(null);
            }}
          />
        </label>
        <button
          className="secondary"
          disabled={!authenticated || busy}
          onClick={() => void operation(reviewPayment)}
        >
          Review API price
        </button>
        {offers && (
          <div className="agent-offers">
            {offers.map((o, i) => (
              <label key={i} className="agent-offer">
                <input
                  type="radio"
                  name="offer"
                  checked={selected === i}
                  onChange={() => setSelected(i)}
                />
                <span>
                  <strong>
                    {Number(o.maxAmountRequired) / 1000000} USDC · {o.network}
                  </strong>
                  <small>Token: {o.asset}</small>
                  <small>Recipient: {o.payTo}</small>
                </span>
              </label>
            ))}
            <button
              disabled={!wallet || busy || !offers.length}
              onClick={() => void operation(pay)}
            >
              Pay up to {limit} USDC and fetch
            </button>
          </div>
        )}
        {result && <pre className="agent-result">{result}</pre>}
      </section>
      <footer>
        <a href="/agent/SKILL.md">Agent setup guide</a> ·{' '}
        <a href="https://docs.privy.io/recipes/agent-integrations/agent-authorization">
          Privy authorization docs
        </a>
      </footer>
    </main>
  );
}
export default function AgentAuthorization() {
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/agent/config')
      .then(async (r) => {
        if (!r.ok) throw new Error('Could not load agent configuration.');
        const c = await r.json();
        if (!c.appId) throw new Error('Privy is not configured.');
        if (!cancelled) setConfig(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (!config)
    return (
      <main className="agent-page">
        <h1>Authorize an agent</h1>
        <p role={error ? 'alert' : 'status'}>
          {error || 'Loading secure sign-in…'}
        </p>
      </main>
    );
  return (
    <PrivyProvider
      appId={config.appId!}
      clientId={config.clientId}
      config={{
        loginMethods: ['wallet'],
        appearance: {
          theme: 'dark',
          accentColor: '#9945ff',
          logo: '/logo.png',
          landingHeader: 'Sign in to ChatGPTEE',
          walletChainType: 'solana-only',
          walletList: ['phantom', 'solflare', 'backpack', 'detected_wallets'],
        },
        externalWallets: {
          solana: { connectors },
          walletConnect: { enabled: false },
        },
        embeddedWallets: {
          solana: { createOnLogin: 'off' },
          ethereum: { createOnLogin: 'off' },
        },
      }}
    >
      <AgentAccess config={config} />
    </PrivyProvider>
  );
}
