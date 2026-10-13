import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Connection } from '../shared/connection-types';
import { AuthFrame } from './AuthGate';
import { api } from './api';

export type SupermemoryCallbackRequest =
  | { code: string; state: string; iss?: string; error?: never }
  | { error: string; code?: never; state?: never; iss?: never };

// Capture before AuthGate runs, so OAuth errors do not become sign-in errors.
// The authorization response stays only in memory while the account is checked.
export function captureSupermemoryCallback(
  search: string,
  cleanUrl: () => void,
): SupermemoryCallbackRequest {
  const params = new URLSearchParams(search);
  cleanUrl();
  if (params.has('error'))
    return {
      error:
        params.get('error') === 'access_denied'
          ? 'Supermemory authorization was declined. Return to your Dot’s settings to connect again.'
          : 'Supermemory could not authorize this connection. Return to your Dot’s settings and try again.',
    };
  const code = params.get('code');
  const state = params.get('state');
  const iss = params.get('iss');
  if (
    !code ||
    !state ||
    code.length > 4096 ||
    state.length > 512 ||
    params.getAll('code').length !== 1 ||
    params.getAll('state').length !== 1 ||
    params.getAll('iss').length > 1 ||
    (iss !== null && (!iss || iss.length > 2048))
  )
    return {
      error:
        'This Supermemory authorization is missing or invalid. Return to your Dot’s settings and start a new connection.',
    };
  return { code, state, ...(iss ? { iss } : {}) };
}

export default function SupermemoryCallback({
  request,
}: {
  request: SupermemoryCallbackRequest;
}) {
  const pending = useRef<Promise<Connection> | undefined>(undefined);
  const [connection, setConnection] = useState<Connection>();
  const [error, setError] = useState(request.error ?? '');
  useEffect(() => {
    if (request.error) return;
    let active = true;
    // StrictMode reruns effects. Exchange a one-use authorization code once.
    pending.current ??= api<Connection>(
      '/connections/supermemory/oauth/finish',
      'POST',
      {
        code: request.code,
        state: request.state,
        ...(request.iss ? { iss: request.iss } : {}),
      },
    );
    void pending.current
      .then((result) => active && setConnection(result))
      .catch(
        (cause) =>
          active &&
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not finish the Supermemory connection.',
          ),
      );
    return () => {
      active = false;
    };
  }, [request]);
  return (
    <AuthFrame>
      <ShieldCheck size={28} aria-hidden="true" />
      <h2>
        {connection
          ? 'Supermemory connected.'
          : error
            ? 'Connection needs attention.'
            : 'Connecting Supermemory…'}
      </h2>
      {connection ? (
        <p>
          Supermemory is ready for your Dot. Open the Dot’s settings to choose a
          space and review its tools.
        </p>
      ) : error ? (
        <>
          <p className="auth-error" role="alert">
            {error}
          </p>
          <p>
            Open your Dot’s settings and select Connect Supermemory or Continue
            authorization to start again.
          </p>
        </>
      ) : (
        <p role="status">
          Finishing the connection for your signed-in workspace. Your
          Supermemory credentials stay on the server.
        </p>
      )}
      {(connection || error) && (
        <a className="auth-primary" href="/">
          Return to workspace
        </a>
      )}
    </AuthFrame>
  );
}
