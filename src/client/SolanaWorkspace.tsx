import { TradingBrainPanel } from './TradingBrainPanel';
import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Pause, Play, Search } from 'lucide-react';
import { Drawer } from './Drawer';
import { ConnectedWalletPanel } from './ConnectedWalletPanel';
import { PumpPanel } from './PumpPanel';
import { JupiterPanel } from './JupiterPanel';
import { DflowQuoteForm } from './DflowQuoteCard';
import { OpenMarketPanel } from './OpenMarketPanel';
import {
  filteredLaunches,
  launchSchema,
  receiveLaunch,
  type PumpLaunchItem,
} from '../shared/pump-feed';
import './pump.css';
import './solana-workspace.css';

export function SolanaWorkspace({
  initialTab = 'pump',
  dotId,
  threadId,
  jupiterThreadId,
  walletId,
  paused,
  onPrepare,
  onPrepareJupiter,
  onClose,
}: {
  initialTab?: 'pump' | 'jupiter' | 'wallet' | 'openmarket';
  dotId?: string;
  threadId?: string;
  jupiterThreadId?: string;
  walletId?: string | null;
  paused: boolean;
  onPrepare: () => Promise<string | undefined>;
  onPrepareJupiter: () => Promise<string>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<typeof initialTab | 'brain'>(initialTab),
    [launches, setLaunches] = useState<PumpLaunchItem[]>([]);
  const [query, setQuery] = useState(''),
    [github, setGithub] = useState(false),
    [feedPaused, setFeedPaused] = useState(false);
  const [state, setState] = useState('Connecting to launch feed…'),
    [lastMessage, setLastMessage] = useState(0),
    [now, setNow] = useState(Date.now());
  const [trade, setTrade] = useState<{
    mint: string;
    mode: 'launch' | 'buy' | 'sell';
    threadId: string;
    brainDecisionId?: string;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (feedPaused || tab !== 'pump') return;
    let active = true,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      delay = 1000;
    const connect = () => {
      if (!active) return;
      setState('Connecting to launch feed…');
      socket = new WebSocket('wss://clawd-ws.fly.dev/ws');
      socket.onopen = () => {
        if (active) {
          delay = 1000;
          setState('Connected · waiting for launches');
          setLastMessage(Date.now());
        }
      };
      socket.onmessage = (event) => {
        if (
          !active ||
          typeof event.data !== 'string' ||
          event.data.length > 100000
        )
          return;
        try {
          const frame = JSON.parse(event.data) as Record<string, unknown>;
          if (frame.type === 'status' && typeof frame.connected === 'boolean') {
            setState(
              frame.connected ? 'Live launch feed' : 'Relay reconnecting…',
            );
            setLastMessage(Date.now());
          }
          if (launchSchema.safeParse(frame).success) {
            setLaunches((previous) => receiveLaunch(previous, frame));
            setLastMessage(Date.now());
            setState('Live launch feed');
          }
        } catch {
          /* Ignore malformed provider frames. */
        }
      };
      socket.onerror = () => {
        if (active) setState('Launch feed unavailable · reconnecting');
      };
      socket.onclose = () => {
        if (!active) return;
        setState('Launch feed disconnected · reconnecting');
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
    };
    connect();
    return () => {
      active = false;
      clearTimeout(timer);
      socket?.close();
    };
  }, [feedPaused, tab]);
  const prepare = async (
    mint = '',
    mode?: 'buy' | 'sell',
    brainDecisionId?: string,
  ) => {
    setBusy(true);
    setError('');
    try {
      const id = threadId || (await onPrepare());
      if (id)
        setTrade({
          mint,
          mode: mode ?? (mint ? 'buy' : 'launch'),
          threadId: id,
          brainDecisionId,
        });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not open the transaction panel.',
      );
    } finally {
      setBusy(false);
    }
  };
  const items = filteredLaunches(launches, query, github);
  const feedState = feedPaused
    ? 'Feed paused'
    : lastMessage && now - lastMessage > 45000
      ? 'Feed stale · waiting for an update'
      : state;
  return (
    <Drawer title="Solana workspace" onClose={onClose}>
      <div className="solana-workspace">
        <p className="solana-workspace-intro">Discover. Research. Launch.</p>
        <div
          className="solana-tabs"
          role="group"
          aria-label="Solana workspace section"
        >
          <button aria-pressed={tab === 'pump'} onClick={() => setTab('pump')}>
            Pump.fun
          </button>
          <button
            aria-pressed={tab === 'jupiter'}
            onClick={() => setTab('jupiter')}
          >
            Jupiter
          </button>
          <button
            aria-pressed={tab === 'wallet'}
            onClick={() => setTab('wallet')}
          >
            Wallets & assets
          </button>
          {dotId && (
            <button
              aria-pressed={tab === 'brain'}
              onClick={() => setTab('brain')}
            >
              Trading brain
            </button>
          )}
          <button
            aria-pressed={tab === 'openmarket'}
            onClick={() => setTab('openmarket')}
          >
            OpenMarket
          </button>
        </div>
        {tab === 'brain' && dotId ? (
          <TradingBrainPanel
            dotId={dotId}
            paused={paused}
            onReview={async (record) => {
              setTab('pump');
              await prepare(
                record.data.mint,
                record.data.answers?.action.choice === 'sell' ? 'sell' : 'buy',
                record.id,
              );
            }}
          />
        ) : tab === 'openmarket' ? (
          <OpenMarketPanel />
        ) : tab === 'wallet' ? (
          <ConnectedWalletPanel
            onOpenPump={() => {
              setTab('pump');
              void prepare();
            }}
          />
        ) : tab === 'jupiter' ? (
          <JupiterPanel
            threadId={jupiterThreadId}
            onPrepare={onPrepareJupiter}
            paused={paused}
          />
        ) : (
          <>
            <div className="solana-feed-status">
              <span role="status">{feedState}</span>
              <small>{launches.length} launches in session</small>
            </div>
            <div className="solana-launch-actions">
              <button
                className="primary"
                disabled={busy || paused}
                onClick={() => void prepare()}
              >
                {busy ? 'Opening…' : 'Launch or trade'}
              </button>
              <button onClick={() => setTab('wallet')}>Connect wallet</button>
            </div>
            {error && (
              <p role="alert" className="pump-error">
                {error}
              </p>
            )}
            {trade && (
              <PumpPanel
                key={`${trade.threadId}:${trade.mint}:${trade.mode}:${trade.brainDecisionId ?? 'manual'}`}
                threadId={trade.threadId}
                walletId={walletId}
                paused={paused}
                initialMint={trade.mint}
                brainDecision={
                  trade.brainDecisionId && dotId
                    ? { dotId, id: trade.brainDecisionId }
                    : undefined
                }
                initialMode={trade.mode}
                onClose={() => setTrade(undefined)}
              />
            )}
            <label className="solana-feed-search">
              <Search size={16} />
              <input
                aria-label="Search Pump.fun launches"
                placeholder="Search name, symbol or mint"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="solana-feed-filters">
              <label>
                <input
                  type="checkbox"
                  checked={github}
                  onChange={(event) => setGithub(event.target.checked)}
                />
                Has GitHub
              </label>
              <button
                aria-pressed={feedPaused}
                onClick={() => setFeedPaused((value) => !value)}
              >
                {feedPaused ? <Play size={14} /> : <Pause size={14} />}
                {feedPaused ? 'Resume feed' : 'Pause feed'}
              </button>
            </div>
            <div
              className="solana-launch-list"
              aria-label="Recent Pump.fun launches"
            >
              {items.map((item) => (
                <article className="solana-launch-card" key={item.mint}>
                  <header>
                    <div>
                      <strong>{item.name || 'Unnamed coin'}</strong>
                      <span>{item.symbol}</span>
                    </div>
                    <div>
                      {item.marketCapSol == null
                        ? 'Unavailable'
                        : `${item.marketCapSol.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL`}
                      <small>launch market cap</small>
                    </div>
                  </header>
                  <div className="solana-mint">
                    <code>{item.mint}</code>
                    <button
                      aria-label={`Copy mint for ${item.symbol || item.name}`}
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(item.mint)
                          .catch(() =>
                            setError(
                              'Could not copy this mint. Select the address to copy.',
                            ),
                          )
                      }
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                  <footer>
                    <a
                      href={`https://pump.fun/coin/${item.mint}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Pump.fun <ExternalLink size={12} />
                    </a>
                    <a
                      href={`https://solscan.io/token/${item.mint}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Explorer <ExternalLink size={12} />
                    </a>
                    <button
                      disabled={busy || paused}
                      onClick={() => void prepare(item.mint)}
                    >
                      Review trade
                    </button>
                  </footer>
                </article>
              ))}
              {!items.length && (
                <p className="solana-feed-empty">
                  {launches.length
                    ? 'No launches match these filters.'
                    : 'New launches appear here when the relay sends an update.'}
                </p>
              )}
            </div>
            <DflowQuoteForm initialMint={trade?.mint || ''} />
            <p className="solana-feed-note">
              Launch data comes from the CLAWD Pump.fun relay. Prices can change
              before a wallet review.
            </p>
          </>
        )}
      </div>
    </Drawer>
  );
}
