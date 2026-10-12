import { useCallback, useEffect, useRef, useState } from 'react';
import { Layers3 } from 'lucide-react';
import { api } from './api';
import { Drawer } from './Drawer';
import type {
  OpenRouterBatchJob,
  OpenRouterBatchState,
} from '../shared/openrouter-types';
import './openrouter-batches.css';

const terminal = (status: string) =>
  ['completed', 'failed', 'cancelled', 'expired', 'deleted'].includes(status);
export function OpenRouterBatches({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<OpenRouterBatchState>();
  const [draft, setDraft] = useState('');
  const [tokens, setTokens] = useState(512);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(false);
  const working = useRef(false);
  const request = useRef<{ signature: string; id: string } | undefined>(
    undefined,
  );
  const controller = useRef<AbortController | undefined>(undefined);
  const base = '/openrouter/batches';
  const refresh = useCallback(async () => {
    if (working.current) return;
    working.current = true;
    const abort = new AbortController();
    controller.current = abort;
    try {
      const next = await api<OpenRouterBatchState>(
        base,
        'GET',
        undefined,
        abort.signal,
      );
      if (alive.current) setState(next);
      for (const job of next.jobs.filter(
        (job) =>
          !terminal(job.status) ||
          (job.status === 'completed' && job.results === null),
      )) {
        const current = await api<OpenRouterBatchJob>(
          `${base}/${job.id}`,
          'GET',
          undefined,
          abort.signal,
        );
        next.jobs = next.jobs.map((item) =>
          item.id === current.id ? current : item,
        );
      }
      if (alive.current) {
        setState(next);
        setError('');
      }
    } catch (cause) {
      if (alive.current && !abort.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not refresh batch jobs.',
        );
    } finally {
      working.current = false;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      alive.current = false;
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh]);
  const prompts = draft
    .trim()
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter(Boolean);
  const submit = async () => {
    if (working.current || !prompts.length || prompts.length > 50) return;
    working.current = true;
    setBusy(true);
    setError('');
    const signature = JSON.stringify({ prompts, maxTokens: tokens });
    if (request.current?.signature !== signature)
      request.current = { signature, id: crypto.randomUUID() };
    try {
      const job = await api<OpenRouterBatchJob>(base, 'POST', {
        requestId: request.current.id,
        prompts,
        maxTokens: tokens,
      });
      if (alive.current) {
        setState(
          (previous) =>
            previous && {
              ...previous,
              jobs: [
                job,
                ...previous.jobs.filter((item) => item.id !== job.id),
              ],
            },
        );
        if (job.status !== 'submission_unknown' && job.status !== 'failed') {
          setDraft('');
          request.current = undefined;
        }
      }
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : 'Could not submit batch.',
        );
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Drawer title="Claude batches" onClose={onClose}>
      <div className="batch-panel">
        <div className="drawer-feature-icon">
          <Layers3 size={26} />
        </div>
        <p className="drawer-intro">
          Run several prompts together with Claude Haiku 5.5.
        </p>
        <p className="muted">
          Batch jobs can take up to 24 hours. You can close this panel and
          return later. OpenRouter retains inputs and results for 30 days.
        </p>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        {!state ? (
          <p role="status">Loading your batch jobs…</p>
        ) : (
          <>
            <p className="batch-model">{state.configuredModel}</p>
            {!state.configured && (
              <p role="status">
                Batch processing is not configured. Contact the workspace
                administrator.
              </p>
            )}
            <form
              className="drawer-card"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label htmlFor="batch-prompts">Prompts</label>
              <p className="muted">
                Separate each request with a blank line. Up to 50 requests per
                batch.
              </p>
              <textarea
                id="batch-prompts"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={7}
                maxLength={100000}
                placeholder={
                  'Summarize this first document…\n\nSummarize this second document…'
                }
                required
                disabled={busy || !state.configured}
              />
              <label htmlFor="batch-tokens">
                Maximum output tokens per request
              </label>
              <input
                id="batch-tokens"
                type="number"
                min={64}
                max={4096}
                step={1}
                value={tokens}
                onChange={(event) => setTokens(Number(event.target.value))}
                required
                disabled={busy}
              />
              <p className="muted">
                {prompts.length} request{prompts.length === 1 ? '' : 's'} · Uses
                your workspace’s OpenRouter credits.
              </p>
              <button
                className="primary"
                disabled={
                  busy ||
                  !state.configured ||
                  !prompts.length ||
                  prompts.length > 50
                }
              >
                {busy ? 'Submitting…' : 'Submit batch'}
              </button>
            </form>
            <div className="batch-history-header">
              <h3>Your batches</h3>
              <button disabled={busy} onClick={() => void refresh()}>
                Refresh
              </button>
            </div>
            {!state.jobs.length && (
              <p className="muted">
                Your queued jobs and completed results will appear here.
              </p>
            )}
            {state.jobs
              .filter((job) => job.status !== 'deleted')
              .map((job) => (
                <article className="drawer-card" key={job.id}>
                  <div className="batch-history-header">
                    <strong>
                      {job.requestCounts.total} request
                      {job.requestCounts.total === 1 ? '' : 's'}
                    </strong>
                    <span className="batch-status" role="status">
                      {job.status.replaceAll('_', ' ')}
                    </span>
                  </div>
                  <p className="muted">
                    {new Date(job.createdAt).toLocaleString()} ·{' '}
                    {job.requestCounts.completed} completed ·{' '}
                    {job.requestCounts.failed} failed
                  </p>
                  {job.error && <p className="chat-error">{job.error}</p>}
                  {job.pollError && (
                    <p className="chat-error">{job.pollError}</p>
                  )}
                  {job.status === 'submission_unknown' && (
                    <p>
                      OpenRouter may have accepted this submission. This job is
                      saved to prevent a duplicate charge; ask your workspace
                      administrator to check it before resubmitting.
                    </p>
                  )}
                  {job.results?.map((result) => (
                    <details
                      key={result.customId}
                      open={job.results?.length === 1}
                    >
                      <summary>{result.prompt.slice(0, 100)}</summary>
                      {result.error ? (
                        <p className="chat-error">{result.error}</p>
                      ) : (
                        <pre className="batch-output">
                          {result.text || 'No text returned.'}
                        </pre>
                      )}
                    </details>
                  ))}
                  {job.usage?.cost != null && (
                    <small>Batch cost: ${job.usage.cost.toFixed(6)}</small>
                  )}
                  {['completed', 'failed', 'expired', 'cancelled'].includes(
                    job.status,
                  ) && (
                    <button
                      disabled={busy}
                      onClick={async () => {
                        if (working.current) return;
                        working.current = true;
                        setBusy(true);
                        setError('');
                        try {
                          await api(`${base}/${job.id}`, 'DELETE', {});
                          if (alive.current)
                            setState(
                              (previous) =>
                                previous && {
                                  ...previous,
                                  jobs: previous.jobs.filter(
                                    (item) => item.id !== job.id,
                                  ),
                                },
                            );
                        } catch (cause) {
                          if (alive.current)
                            setError(
                              cause instanceof Error
                                ? cause.message
                                : 'Could not delete this batch.',
                            );
                        } finally {
                          working.current = false;
                          if (alive.current) setBusy(false);
                        }
                      }}
                    >
                      Delete finished batch
                    </button>
                  )}
                </article>
              ))}
          </>
        )}
      </div>
    </Drawer>
  );
}
