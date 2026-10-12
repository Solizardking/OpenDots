import { useCallback, useEffect, useState } from 'react';
import {
  Smartphone,
  ShieldCheck,
  Wifi,
  Trash2,
  Copy,
  Phone,
} from 'lucide-react';
import QRCode from 'qrcode';
import type { CompanionState } from '../shared/desktop-types';
import { Drawer } from './Drawer';
import { MessagingChannels } from './MessagingChannels';
import { CHATGPTEE_CALL_NUMBER } from '../shared/messaging-types';
import { CHATGPTEE_CALL_LABEL } from './PhoneActions';
import './phone-messaging.css';

export function PhoneDrawer({
  onClose,
  dotId,
}: {
  onClose: () => void;
  dotId?: string;
}) {
  const [state, setState] = useState<CompanionState>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const refresh = useCallback(
    () =>
      void window.solanaDots
        ?.companion('state')
        .then(setState)
        .catch(() => setError('Phone status is unavailable. Try again.')),
    [],
  );
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      refresh();
      setNow(Date.now());
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  const address = state?.urls.find((url) => !url.includes('127.0.0.1'));
  const link =
    state?.remote?.connected && state.pairing
      ? `https://chatgptee.ai/pair#mac=${state.remote.id}&code=${state.pairing.token}`
      : '';
  useEffect(() => {
    let active = true;
    setQr('');
    if (link)
      void QRCode.toDataURL(link, {
        width: 256,
        margin: 2,
        errorCorrectionLevel: 'M',
      }).then((value) => {
        if (active) setQr(value);
      });
    return () => {
      active = false;
    };
  }, [link]);
  const action = async (name: string, value?: string) => {
    setBusy(true);
    setError('');
    try {
      setState(await window.solanaDots!.companion(name, value));
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Phone service unavailable.',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer title="Phone & messaging" onClose={onClose}>
      <div className="drawer-feature-icon">
        <Smartphone size={28} />
      </div>
      <p className="drawer-intro">
        Call directly, text your Dot, or pair your phone with your Mac
        workspace.
      </p>
      <div className="drawer-card phone-contact">
        <h3>Call ChatGPTEE</h3>
        <span className="phone-number">{CHATGPTEE_CALL_LABEL}</span>
        <div className="phone-contact-actions">
          <a
            href={`tel:${CHATGPTEE_CALL_NUMBER}`}
            aria-label={`Call ${CHATGPTEE_CALL_LABEL}`}
          >
            <Phone size={17} /> Call {CHATGPTEE_CALL_LABEL}
          </a>
        </div>
      </div>
      <MessagingChannels dotId={dotId} />
      {!window.solanaDots ? (
        <div className="drawer-card">
          <h3>Pair from the Mac app</h3>
          <p>
            Phone pairing connects to your Solana Dots desktop workspace. Open
            Phone in the Mac app to get started.
          </p>
          <a
            href="https://app.chatgptee.ai/download"
            target="_blank"
            rel="noreferrer"
          >
            Get Solana Dots for Mac ↗
          </a>
          <p>
            <a
              href="https://chatgptee.ai/pair"
              target="_blank"
              rel="noreferrer"
            >
              Pair your Mac ↗
            </a>
          </p>
        </div>
      ) : (
        <>
          <div className="drawer-card">
            <div className="drawer-card-title">
              <Wifi size={19} />
              <h3>Phone access</h3>
              <span
                className={`drawer-status ${state?.enabled ? 'ready' : ''}`}
              >
                {state?.enabled ? 'Enabled' : 'Off'}
              </span>
            </div>
            <p>
              Connect from anywhere at <strong>chatgptee.ai/pair</strong>. Keep
              your Mac awake with Solana Dots open. Your Mac connects out over
              TLS; no router setup is needed.
            </p>
            <button
              type="button"
              className={state?.enabled ? 'secondary' : 'primary'}
              disabled={busy || !state}
              onClick={() => void action(state?.enabled ? 'stop' : 'start')}
            >
              {state?.enabled ? 'Turn off Phone access' : 'Enable Phone access'}
            </button>
            {state?.enabled && (
              <>
                <p role="status">
                  {state.remote?.connected
                    ? 'Connected to ChatGPTEE. Ready to pair from anywhere.'
                    : 'Connecting to ChatGPTEE… Pairing becomes available when the connection is ready.'}
                </p>
                <label className="permission-row">
                  <input
                    type="checkbox"
                    checked={state.keepAwake}
                    onChange={(event) =>
                      void window
                        .solanaDots!.keepAwake(event.target.checked)
                        .then(setState)
                        .catch(() =>
                          setError('Could not change the wake setting.'),
                        )
                    }
                  />
                  <span>Keep this Mac awake while Phone access is on</span>
                </label>
              </>
            )}
          </div>
          {state?.enabled && (
            <div className="drawer-card pairing-card">
              <h3>Pair a phone</h3>
              {state.pairing && state.pairing.expiresAt > now ? (
                <>
                  {qr && (
                    <img
                      src={qr}
                      alt="Scan to pair this phone with ChatGPTEE"
                      className="pair-qr"
                    />
                  )}
                  <p>
                    Scan with your phone’s camera, then tap{' '}
                    <strong>Pair with Mac</strong>.
                  </p>
                  <button
                    type="button"
                    disabled={!link}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(link)
                        .then(() => setCopied(true))
                        .catch(() =>
                          setError(
                            'Scan the QR code to open the pairing link.',
                          ),
                        )
                    }
                  >
                    <Copy size={14} /> {copied ? 'Copied' : 'Copy pairing link'}
                  </button>
                  <div className="pair-code" aria-label="Pairing code">
                    {state.pairing.code}
                  </div>
                  <small className="muted">
                    One use · expires in{' '}
                    {Math.max(
                      0,
                      Math.ceil((state.pairing.expiresAt - now) / 1000),
                    )}{' '}
                    seconds
                  </small>
                  <details>
                    <summary>Enter the code manually</summary>
                    <p>
                      Open <strong>chatgptee.ai/pair</strong> and enter this Mac
                      connection ID and the code above.
                    </p>
                    <code style={{ overflowWrap: 'anywhere' }}>
                      {state.remote?.id}
                    </code>
                    <button
                      type="button"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(state.remote?.id || '')
                          .then(() => setCopied(true))
                          .catch(() =>
                            setError('Select the connection ID and copy it.'),
                          )
                      }
                    >
                      <Copy size={14} />{' '}
                      {copied ? 'Copied' : 'Copy Mac connection ID'}
                    </button>
                  </details>
                  <details>
                    <summary>Use local Wi-Fi instead</summary>
                    <p>
                      On the same trusted Wi-Fi, open{' '}
                      <strong>{address}/pair</strong> and enter the code above.
                      This local connection uses HTTP.
                    </p>
                  </details>
                  <button
                    type="button"
                    onClick={() => void action('cancel')}
                    disabled={busy}
                  >
                    Cancel pairing
                  </button>
                </>
              ) : (
                <>
                  <p>
                    A pairing code gives one phone access to this workspace.
                    Only share it with a device you own.
                  </p>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !state.remote?.connected}
                    onClick={() => void action('pair')}
                  >
                    Create pairing code
                  </button>
                </>
              )}
            </div>
          )}
          <div className="drawer-card">
            <div className="drawer-card-title">
              <ShieldCheck size={19} />
              <h3>Paired devices</h3>
              <span className="drawer-status">
                {state?.devices.length ?? 0} / 8
              </span>
            </div>
            {state?.devices.length ? (
              <ul className="paired-devices">
                {state.devices.map((device) => (
                  <li key={device.id}>
                    <Smartphone size={19} />
                    <div>
                      <strong>{device.name}</strong>
                      <small>
                        Paired {new Date(device.createdAt).toLocaleDateString()}{' '}
                        · last seen{' '}
                        {new Date(device.lastSeenAt).toLocaleTimeString([], {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </small>
                    </div>
                    <button
                      type="button"
                      aria-label={`Revoke ${device.name}`}
                      onClick={() => void action('revoke', device.id)}
                      disabled={busy}
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No phones paired yet.</p>
            )}
            <p className="muted">
              Revoke a phone here to end its access immediately. Provider keys,
              wallet signing, and connection settings stay on your Mac. Pairing
              expires after 30 days.
            </p>
          </div>
        </>
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </Drawer>
  );
}
