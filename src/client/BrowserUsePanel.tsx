import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dot } from '../shared/types';
import {
  cloudRunFinished,
  type BrowserUseStatus,
  type CloudBrowser,
} from '../shared/browser-use-types';
import { api } from './api';

function BrowserView({
  browser,
  label,
}: {
  browser?: CloudBrowser;
  label: string;
}) {
  if (!browser) return null;
  let liveUrl: string | undefined;
  try {
    const url = new URL(browser.liveUrl || '');
    if (url.protocol === 'https:' && url.hostname === 'live.browser-use.com')
      liveUrl = url.href;
  } catch {
    /* Provider has not published a live view yet. */
  }
  return (
    <section className="computer-section">
      <h3>
        {label} · {browser.status}
      </h3>
      {browser.status === 'active' && liveUrl && (
        <>
          <iframe
            className="cloud-browser-view"
            src={liveUrl}
            title={label}
            sandbox="allow-scripts allow-same-origin allow-forms"
            allow="clipboard-read; clipboard-write"
          />
          <a href={liveUrl} target="_blank" rel="noreferrer">
            Open live browser ↗
          </a>
        </>
      )}
      {browser.status === 'active' && (
        <small>
          Expires at {new Date(browser.timeoutAt).toLocaleTimeString()}.
        </small>
      )}
      {browser.recordingUrl ? (
        <a href={browser.recordingUrl} target="_blank" rel="noreferrer">
          Download recording ↗
        </a>
      ) : browser.status === 'stopped' ? (
        <p role="status">
          {browser.recordingAvailable === false
            ? 'No recording is available for this session.'
            : 'Recording is processing. Refresh to check again.'}
        </p>
      ) : null}
    </section>
  );
}

export function BrowserUsePanel({ dot }: { dot: Dot }) {
  const [state, setState] = useState<BrowserUseStatus>();
  const [task, setTask] = useState('');
  const [followup, setFollowup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cdp, setCdp] = useState('');
  const active = useRef(false);
  const working = useRef(false);
  const currentState = useRef<BrowserUseStatus | undefined>(undefined);
  const base = `/dots/${encodeURIComponent(dot.id)}/browser-use`;
  const refresh = useCallback(async () => {
    try {
      const next = await api<BrowserUseStatus>(base);
      if (active.current) {
        currentState.current = next;
        setState(next);
      }
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load Browser Use.',
        );
    }
  }, [base]);
  useEffect(() => {
    active.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const started = Date.now();
    const poll = async () => {
      if (!working.current && (!document.hidden || !currentState.current)) {
        const next = currentState.current;
        const recordingPending = (browser?: CloudBrowser) =>
          browser?.status === 'stopped' &&
          !browser.recordingUrl &&
          browser.recordingAvailable !== false &&
          Date.now() - started < 120000;
        if (
          !next ||
          next.browser?.status === 'active' ||
          (next.run && !cloudRunFinished(next.run.status)) ||
          next.run?.browser?.status === 'active' ||
          recordingPending(next.browser) ||
          recordingPending(next.run?.browser)
        )
          await refresh();
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => {
      cancelled = true;
      active.current = false;
      clearTimeout(timer);
    };
  }, [refresh]);
  const run = async (path: string, method = 'POST', body: unknown = {}) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await api<BrowserUseStatus>(`${base}${path}`, method, body);
      if (active.current) {
        currentState.current = next;
        setState(next);
      }
    } catch (cause) {
      if (active.current)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Browser Use request failed.',
        );
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  };
  const running = !!state?.run && !cloudRunFinished(state.run.status);
  return (
    <section
      className="computer-panel browser-use-panel"
      aria-label={`${dot.name}'s Browser Use`}
      aria-busy={busy}
    >
      <div className="computer-status">
        <strong>Browser Use</strong>
        <button
          disabled={busy}
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          Refresh
        </button>
      </div>
      {error && (
        <p className="computer-error" role="alert">
          {error}
        </p>
      )}
      {!state ? (
        <p role="status">Loading Browser Use…</p>
      ) : (
        <>
          <p>
            Cloud browser tasks use {state.model}.{' '}
            {state.profileConfigured
              ? 'CLAWD profile is configured.'
              : 'Sessions use a fresh profile.'}
          </p>
          {!state.configured && (
            <p>
              Set BROWSERUSE_API_KEY in the server environment, then restart.
            </p>
          )}
          <label>
            <input
              type="checkbox"
              checked={state.enabled}
              disabled={busy || !state.configured}
              onChange={(event) =>
                void run('/permission', 'PATCH', {
                  enabled: event.target.checked,
                })
              }
            />{' '}
            Allow Browser Use for {dot.name}
          </label>
          <p className="computer-hint">
            Sessions use provider credits. Stop the browser when finished;
            closing this panel leaves it running until stopped or timed out.
          </p>
          <div className="computer-actions">
            <button
              disabled={
                busy ||
                !state.enabled ||
                !state.configured ||
                state.browser?.status === 'active'
              }
              onClick={() => void run('/start')}
            >
              Start cloud browser
            </button>
            <button
              disabled={busy || state.browser?.status !== 'active'}
              onClick={() => void run('/stop-browser')}
            >
              Stop cloud browser
            </button>
            <button
              disabled={
                busy ||
                (!running &&
                  state.run?.browser?.status !== 'active' &&
                  state.browser?.status !== 'active')
              }
              onClick={() => void run('/stop')}
            >
              Stop all cloud work
            </button>
          </div>
          <small>
            Standalone browser: Japan proxy · 15 minutes · recording on.
          </small>
          <BrowserView browser={state.browser} label="Cloud browser" />
          <form
            className="computer-section"
            onSubmit={(event) => {
              event.preventDefault();
              void run('/runs', 'POST', { task, followup });
            }}
          >
            <h3>Browser task</h3>
            <textarea
              aria-label="Browser Use task"
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="Open https://example.com and return its title"
              required
              maxLength={12000}
              disabled={busy || running}
            />
            <label>
              <input
                type="checkbox"
                checked={followup}
                disabled={busy || running || !state.run}
                onChange={(event) => setFollowup(event.target.checked)}
              />{' '}
              Continue the previous task session
            </label>
            <div className="computer-actions">
              <button
                disabled={
                  busy ||
                  running ||
                  !state.enabled ||
                  !state.configured ||
                  !task.trim()
                }
              >
                Run browser task
              </button>
              <button
                type="button"
                disabled={
                  busy || (!running && state.run?.browser?.status !== 'active')
                }
                onClick={() => void run('/stop-run')}
              >
                Stop task
              </button>
            </div>
            <small>
              US proxy · 1440 × 900 · high reasoning · recording on.
            </small>
          </form>
          {state.run && (
            <section className="computer-section">
              <h3>Task · {state.run.status}</h3>
              {state.run.result && <pre>{state.run.result}</pre>}
              {state.run.error && (
                <p className="computer-error" role="alert">
                  {state.run.error}
                </p>
              )}
              {state.run.totalCostUsd && (
                <small>Task cost: ${state.run.totalCostUsd}</small>
              )}
              <BrowserView browser={state.run.browser} label="Task browser" />
            </section>
          )}
          {state.suppliedCdpConfigured && (
            <section className="computer-section">
              <h3>Supplied CDP browser</h3>
              <button
                disabled={busy}
                onClick={async () => {
                  try {
                    const result = await api<{
                      connected: boolean;
                      browser?: string;
                      status?: number;
                    }>(`${base}/check-cdp`, 'POST', {});
                    if (active.current)
                      setCdp(
                        result.connected
                          ? `Connected · ${result.browser}`
                          : `Unavailable${result.status ? ` (HTTP ${result.status})` : ''}. The endpoint may have expired.`,
                      );
                  } catch (cause) {
                    if (active.current)
                      setCdp(
                        cause instanceof Error
                          ? cause.message
                          : 'CDP check failed.',
                      );
                  }
                }}
              >
                Check supplied browser
              </button>
              <p role="status">{cdp}</p>
              <small>
                This checks the supplied connection without changing or stopping
                that browser.
              </small>
            </section>
          )}
        </>
      )}
    </section>
  );
}
