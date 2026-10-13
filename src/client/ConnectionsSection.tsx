import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Brain, PlugZap, RefreshCw, Trash2 } from 'lucide-react';
import type { Connection } from '../shared/connection-types';
import { api } from './api';
import './supermemory.css';

interface OAuthStart {
  connection: Connection;
  authorizationUrl: string;
}
interface SupermemorySpaces {
  spaces: { namespace: string; name?: string; description?: string }[];
  activeNamespace?: string;
  identity: { text: string };
}
export function isSupermemoryServer(value: string) {
  try {
    const target = new URL(value.trim());
    return (
      target.origin === 'https://mcp.supermemory.ai' &&
      target.pathname.replace(/\/+$/, '') === '/mcp' &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password
    );
  } catch {
    return false;
  }
}

function SupermemorySpacePicker({
  connectionId,
  disabled,
}: {
  connectionId: string;
  disabled: boolean;
}) {
  const [spaces, setSpaces] = useState<SupermemorySpaces>();
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    void api<SupermemorySpaces>(
      `/connections/${encodeURIComponent(connectionId)}/supermemory/spaces`,
    )
      .then((result) => {
        if (!active) return;
        setSpaces(result);
        setSelected(result.activeNamespace ?? '');
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : 'Could not load spaces.',
          );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [connectionId]);
  const setActive = async () => {
    if (!selected || !spaces) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const result = await api<{ activeNamespace: string }>(
        `/connections/${encodeURIComponent(connectionId)}/supermemory/space`,
        'POST',
        { namespace: selected },
      );
      setSpaces((current) =>
        current ? { ...current, activeNamespace: result.activeNamespace } : current,
      );
      setSelected(result.activeNamespace);
      setMessage('Active Supermemory space updated.');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not set the active space.',
      );
    } finally {
      setSaving(false);
    }
  };
  const activeName = spaces?.spaces.find(
    (space) => space.namespace === spaces.activeNamespace,
  );
  return (
    <div className="supermemory-spaces">
      <p className="muted">
        Requests use your active Supermemory space or account default. Name a
        space in chat for one request, or change your active space here for
        future requests.
      </p>
      {loading ? (
        <p className="muted" role="status">Loading Supermemory spaces…</p>
      ) : spaces ? (
        <>
          <p className="supermemory-active-space">
            Active: <strong>{activeName?.name || spaces.activeNamespace || 'Account default'}</strong>
          </p>
          {spaces.spaces.length ? (
            <div className="supermemory-space-controls">
              <label htmlFor={`supermemory-space-${connectionId}`}>
                Supermemory space
              </label>
              <select
                id={`supermemory-space-${connectionId}`}
                value={selected}
                disabled={disabled || saving}
                onKeyDown={stayInSection}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setMessage('');
                }}
              >
                <option value="" disabled>Choose a space</option>
                {spaces.activeNamespace && !activeName && (
                  <option value={spaces.activeNamespace}>{spaces.activeNamespace}</option>
                )}
                {spaces.spaces.map((space) => (
                  <option key={space.namespace} value={space.namespace}>
                    {space.name || space.namespace}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="connection-connect"
                disabled={disabled || saving || !selected || selected === spaces.activeNamespace}
                onClick={() => void setActive()}
              >
                {saving ? 'Setting active space…' : 'Set active space'}
              </button>
            </div>
          ) : (
            <p className="muted">No named spaces are available. Requests use your account default.</p>
          )}
        </>
      ) : null}
      {message && <p className="muted" role="status">{message}</p>}
      {error && <p className="chat-error" role="alert">{error}</p>}
    </div>
  );
}
// Lives inside the Dot form, so it saves immediately through its own
// requests and keeps Enter from submitting the surrounding form.
const stayInSection = (event: KeyboardEvent) => {
  if (event.key === 'Enter') event.preventDefault();
};
export function ConnectionsSection({ dotId }: { dotId: string }) {
  const [connections, setConnections] = useState<Connection[]>();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void api<Connection[]>(`/dots/${encodeURIComponent(dotId)}/connections`)
      .then((value) => active && setConnections(value))
      .catch(
        (cause) =>
          active &&
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load connections.',
          ),
      );
    return () => {
      active = false;
    };
  }, [dotId]);
  const run = async <T,>(key: string, request: () => Promise<T>) => {
    setBusy(key);
    setError('');
    try {
      return await request();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setBusy('');
    }
  };
  const replace = (next: Connection) =>
    setConnections((list) =>
      list?.map((item) => (item.id === next.id ? next : item)),
    );
  const startSupermemory = async (connection?: Connection) => {
    const result = await run(connection?.id ?? 'supermemory', () =>
      api<OAuthStart>(
        connection
          ? `/connections/${encodeURIComponent(connection.id)}/oauth/start`
          : `/dots/${encodeURIComponent(dotId)}/connections/supermemory`,
        'POST',
        {},
      ),
    );
    if (!result) return;
    if (connection) replace(result.connection);
    else setConnections((list) => [...(list ?? []), result.connection]);
    setToken('');
    window.location.assign(result.authorizationUrl);
  };
  const supermemoryServer = isSupermemoryServer(url);
  const existingSupermemory = connections?.find(
    (connection) => connection.provider === 'supermemory',
  );
  const add = async () => {
    if (supermemoryServer) {
      await startSupermemory(existingSupermemory);
      return;
    }
    const created = await run('add', () =>
      api<Connection>(
        `/dots/${encodeURIComponent(dotId)}/connections`,
        'POST',
        {
          name: name.trim(),
          url: url.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
        },
      ),
    );
    if (!created) return;
    setConnections((list) => [...(list ?? []), created]);
    setName('');
    setUrl('');
    setToken('');
  };
  return (
    <fieldset className="space-access-fields connections-fields">
      <legend>Connections</legend>
      <p className="muted">
        Give this Dot tools from MCP servers. Read-only tools run on their own;
        anything else asks you in chat before it runs. Tokens stay on the
        server.
      </p>
      {!existingSupermemory && (
        <div className="supermemory-connect">
          <span className="supermemory-heading"><Brain size={16} aria-hidden="true" /> Supermemory</span>
          <p className="muted">Search and save your context across Supermemory spaces. Sign in to Supermemory and approve access to connect this Dot.</p>
          <button
            type="button"
            className="connection-connect"
            disabled={!!busy || !connections}
            onClick={() => void startSupermemory()}
          >
            {busy === 'supermemory' ? 'Opening Supermemory…' : 'Connect Supermemory'}
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
          <small className="muted">Connect with OAuth. No API key or manual token needed.</small>
        </div>
      )}
      {connections?.map((connection) => (
        <div className="connection" key={connection.id}>
          <div className="connection-head">
            <PlugZap size={15} />
            <span>
              <strong>{connection.name}</strong>
              <small>
                {new URL(connection.url).host}
                {connection.auth === 'oauth'
                  ? connection.authStatus === 'connected'
                    ? ' · connected with OAuth'
                    : connection.authStatus === 'expired'
                      ? ' · reconnect required'
                      : ' · authorization pending'
                  : connection.hasToken ? ' · token saved' : ''}
              </small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Refresh ${connection.name} tools`}
              disabled={!!busy || (connection.auth === 'oauth' && connection.authStatus !== 'connected')}
              onClick={async () => {
                const next = await run(connection.id, () =>
                  api<Connection>(
                    `/connections/${connection.id}/refresh`,
                    'POST',
                    {},
                  ),
                );
                if (next) replace(next);
              }}
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remove ${connection.name}`}
              disabled={!!busy}
              onClick={async () => {
                if (!window.confirm(`Remove ${connection.name} from this Dot?`))
                  return;
                const done = await run(connection.id, () =>
                  api(`/connections/${connection.id}`, 'DELETE'),
                );
                if (done)
                  setConnections((list) =>
                    list?.filter((item) => item.id !== connection.id),
                  );
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
          {connection.provider === 'supermemory' && connection.auth === 'oauth' && (
            <>
              {connection.authStatus === 'connected' ? (
                <SupermemorySpacePicker connectionId={connection.id} disabled={!!busy} />
              ) : (
                <p className="muted">
                  {connection.authStatus === 'expired'
                    ? 'Your Supermemory authorization expired. Reauthorize to restore access.'
                    : 'Finish authorization in Supermemory to load this Dot’s tools.'}
                </p>
              )}
              <button
                type="button"
                className="connection-connect supermemory-reauthorize"
                disabled={!!busy}
                onClick={() => void startSupermemory(connection)}
              >
                {busy === connection.id ? 'Opening Supermemory…' : connection.authStatus === 'pending' ? 'Continue authorization' : 'Reauthorize Supermemory'}
              </button>
            </>
          )}
          {connection.error && (
            <p className="chat-error" role="alert">
              {connection.error}
            </p>
          )}
          {!connection.tools.length && (connection.auth !== 'oauth' || connection.authStatus === 'connected') && (
            <p className="muted">This server offers no tools.</p>
          )}
          <ul className="connection-tools">
            {connection.tools.map((tool) => {
              const patch = async (value: {
                enabled?: boolean;
                requiresApproval?: boolean;
              }) => {
                const next = await run(connection.id, () =>
                  api<Connection>(
                    `/connections/${connection.id}/tools/${encodeURIComponent(tool.name)}`,
                    'PATCH',
                    value,
                  ),
                );
                if (next) replace(next);
              };
              return (
                <li key={tool.name}>
                  <label className="permission-row">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      disabled={!!busy}
                      onChange={(event) =>
                        void patch({ enabled: event.target.checked })
                      }
                    />
                    <span>
                      <strong>
                        {tool.title}
                        {tool.readOnly && <em>read-only</em>}
                      </strong>
                      {tool.description && <small>{tool.description}</small>}
                    </span>
                  </label>
                  <label className="connection-approval">
                    <input
                      type="checkbox"
                      checked={tool.requiresApproval}
                      disabled={!!busy || !tool.enabled}
                      onChange={(event) =>
                        void patch({ requiresApproval: event.target.checked })
                      }
                    />
                    Ask first
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div className="connection-add">
        <span className="field-label">
          Add an MCP server
        </span>
        {!supermemoryServer && <input
          id="connection-name"
          aria-label="MCP server name"
          placeholder="Name, e.g. GitHub"
          maxLength={40}
          value={name}
          onKeyDown={stayInSection}
          onChange={(event) => setName(event.target.value)}
        />}
        <input
          aria-label="MCP server URL"
          placeholder="https://example.com/mcp"
          type="url"
          value={url}
          onKeyDown={stayInSection}
          onChange={(event) => setUrl(event.target.value)}
        />
        {!supermemoryServer && <input
          aria-label="Bearer token (optional)"
          placeholder="Bearer token (optional)"
          type="password"
          autoComplete="off"
          value={token}
          onKeyDown={stayInSection}
          onChange={(event) => setToken(event.target.value)}
        />}
        <button
          type="button"
          className="connection-connect"
          disabled={!!busy || (!supermemoryServer && !name.trim()) || !url.trim() || (supermemoryServer && !connections)}
          onClick={() => void add()}
        >
          {busy === 'add' || busy === 'supermemory' ? 'Connecting…' : supermemoryServer ? 'Connect Supermemory' : 'Connect'}
        </button>
        {supermemoryServer && <small className="muted">Supermemory connects with OAuth. Your API key or bearer token is not used.</small>}
      </div>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
