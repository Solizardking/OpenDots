import { useEffect, useRef, useState } from 'react';
import { Copy, MessageCircle, RefreshCw } from 'lucide-react';
import type {
  MessagingChannelStatus,
  MessagingLink,
  MessagingPlatform,
  MessagingStatus,
} from '../shared/messaging-types';
import { api } from './api';
import './phone-messaging.css';

const names: Record<MessagingPlatform, string> = {
  telegram: 'Telegram',
  imessage: 'iMessage',
};

// Only expose a provider-owned destination returned for this exact channel.
export function messagingLinkUrl(
  channel: MessagingChannelStatus,
  link: MessagingLink,
): string | undefined {
  if (!channel.available || channel.platform !== link.platform || !link.url)
    return;
  try {
    const url = new URL(link.url);
    if (channel.platform === 'telegram') {
      const username = channel.botUsername?.replace(/^@/, '');
      if (
        username &&
        /^[a-zA-Z0-9_]+$/.test(username) &&
        url.protocol === 'https:' &&
        url.hostname === 't.me' &&
        !url.port &&
        !url.username &&
        !url.password &&
        url.pathname.toLowerCase() === `/${username.toLowerCase()}`
      )
        return url.href;
    } else if (
      channel.address &&
      ['sms:', 'imessage:'].includes(url.protocol) &&
      decodeURIComponent(url.pathname) === channel.address
    )
      return url.href;
  } catch {
    // Invalid or unexpected provider links stay as copyable instructions.
  }
}

export function MessagingChannels({ dotId }: { dotId?: string }) {
  const [status, setStatus] = useState<MessagingStatus>();
  const [error, setError] = useState('');
  const [statusError, setStatusError] = useState('');
  const [busy, setBusy] = useState<MessagingPlatform>();
  const [links, setLinks] = useState<
    Partial<Record<MessagingPlatform, MessagingLink>>
  >({});
  const [copied, setCopied] = useState<MessagingPlatform>();
  const [now, setNow] = useState(Date.now());
  const scope = useRef(0);
  const actionController = useRef<AbortController>(undefined);
  const refresh = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const currentScope = ++scope.current;
    let active = true;
    let controller: AbortController | undefined;
    setStatus(undefined);
    setError('');
    setStatusError('');
    setBusy(undefined);
    setLinks({});
    setCopied(undefined);
    const load = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const value = await api<MessagingStatus>(
          `/messaging/status${dotId ? `?dotId=${encodeURIComponent(dotId)}` : ''}`,
          'GET',
          undefined,
          request.signal,
        );
        if (!active || request.signal.aborted) return;
        setStatus(value);
        setStatusError('');
        setLinks((current) => {
          const remaining = { ...current };
          for (const channel of value.channels)
            if (channel.linked && channel.dotId === dotId)
              delete remaining[channel.platform];
          return remaining;
        });
      } catch (failure) {
        if (!active || request.signal.aborted) return;
        setStatus(undefined);
        setStatusError(
          failure instanceof Error
            ? failure.message
            : 'Messaging status is unavailable.',
        );
      }
    };
    refresh.current = load;
    void load();
    const poll = setInterval(() => void load(), 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      if (scope.current === currentScope) scope.current++;
      controller?.abort();
      actionController.current?.abort();
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [dotId]);

  const connect = async (platform: MessagingPlatform) => {
    const channel = status?.channels.find(
      (entry) => entry.platform === platform,
    );
    if (!dotId || !channel?.available || busy) return;
    const currentScope = scope.current;
    const request = new AbortController();
    actionController.current = request;
    setBusy(platform);
    setError('');
    setCopied(undefined);
    try {
      const link = await api<MessagingLink>(
        '/messaging/link',
        'POST',
        { platform, dotId },
        request.signal,
      );
      if (scope.current !== currentScope || request.signal.aborted) return;
      if (
        link.platform !== platform ||
        !Number.isFinite(Date.parse(link.expiresAt))
      )
        throw new Error('The messaging link was invalid. Create a new code.');
      setLinks((current) => ({ ...current, [platform]: link }));
      setNow(Date.now());
    } catch (failure) {
      if (scope.current === currentScope && !request.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not create a link code.',
        );
    } finally {
      if (scope.current === currentScope && !request.signal.aborted)
        setBusy(undefined);
    }
  };

  const unlink = async (platform: MessagingPlatform) => {
    if (busy) return;
    const currentScope = scope.current;
    const request = new AbortController();
    actionController.current = request;
    setBusy(platform);
    setError('');
    try {
      await api<MessagingStatus>(
        '/messaging/unlink',
        'POST',
        { platform },
        request.signal,
      );
      if (scope.current !== currentScope || request.signal.aborted) return;
      setLinks((current) => ({ ...current, [platform]: undefined }));
      await refresh.current();
    } catch (failure) {
      if (scope.current === currentScope && !request.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Could not unlink this account.',
        );
    } finally {
      if (scope.current === currentScope && !request.signal.aborted)
        setBusy(undefined);
    }
  };

  return (
    <section className="messaging-channels" aria-label="Account messaging">
      <h3>Text your Dot</h3>
      <p className="muted">
        Link a messaging account to continue conversations with your selected
        Dot. Each private code is one use. Send it only from the account you
        want to link.
      </p>
      {(['telegram', 'imessage'] as const).map((platform) => {
        const channel = status?.channels.find(
          (entry) => entry.platform === platform,
        );
        const ready =
          channel?.available &&
          channel.linked &&
          (!dotId || channel.dotId === dotId);
        const link = links[platform];
        const expired = !!link && Date.parse(link.expiresAt) <= now;
        const url =
          channel && link && !expired
            ? messagingLinkUrl(channel, link)
            : undefined;
        const label = !channel
          ? statusError
            ? 'Status unavailable'
            : 'Checking…'
          : ready
            ? 'Ready'
            : channel.linked
              ? channel.available
                ? 'Linked to another Dot'
                : 'Linked · unavailable'
              : !channel.configured
                ? 'Not configured'
                : !channel.available
                  ? 'Unavailable'
                  : 'Not linked';
        return (
          <article
            className="messaging-channel"
            key={platform}
            aria-label={`${names[platform]} messaging`}
          >
            <header>
              <strong>{names[platform]}</strong>
              <span
                className={`messaging-link-status ${ready ? 'ready' : ''}`}
                role="status"
              >
                {label}
              </span>
            </header>
            {platform === 'imessage' && <p>Texting through Spectrum.</p>}
            {channel?.reason && <p>{channel.reason}</p>}
            {channel?.botUsername && (
              <p>Bot: @{channel.botUsername.replace(/^@/, '')}</p>
            )}
            {channel?.address && <p>Messaging address: {channel.address}</p>}
            {channel?.linked && (
              <p>
                Linked account:{' '}
                {channel.linkedIdentityMasked ?? 'Verified messaging identity'}
                {channel.dotName && <> · Dot: {channel.dotName}</>}
              </p>
            )}
            {!dotId && <p>Select a Dot to connect a messaging account.</p>}
            <div className="messaging-channel-actions">
              {(!channel?.linked || channel.dotId !== dotId) && (
                <button
                  type="button"
                  disabled={!dotId || !channel?.available || !!busy}
                  onClick={() => void connect(platform)}
                >
                  <MessageCircle size={15} />
                  {busy === platform
                    ? 'Working…'
                    : channel?.linked
                      ? 'Link to selected Dot'
                      : link
                        ? 'Create new link code'
                        : `Connect ${names[platform]}`}
                </button>
              )}
              {channel?.linked && (
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void unlink(platform)}
                >
                  Unlink {names[platform]}
                </button>
              )}
            </div>
            {link && (
              <div className="messaging-pending-link">
                {expired ? (
                  <p role="status">
                    Link code expired. Create a new code to connect.
                  </p>
                ) : (
                  <>
                    <p className="message-link-instruction">
                      {link.instruction}
                    </p>
                    <code
                      className="messaging-link-code"
                      aria-label={`${names[platform]} private link code`}
                    >
                      {link.code}
                    </code>
                    <p role="status">
                      Waiting for your message · expires in{' '}
                      {Math.max(
                        0,
                        Math.ceil((Date.parse(link.expiresAt) - now) / 1000),
                      )}{' '}
                      seconds.
                    </p>
                    <div className="messaging-channel-actions">
                      <button
                        type="button"
                        onClick={() => {
                          const currentScope = scope.current;
                          void navigator.clipboard
                            .writeText(link.code)
                            .then(() => {
                              if (scope.current === currentScope)
                                setCopied(platform);
                            })
                            .catch(() => {
                              if (scope.current === currentScope)
                                setError(
                                  'Select the private code and copy it.',
                                );
                            });
                        }}
                      >
                        <Copy size={15} />{' '}
                        {copied === platform ? 'Copied' : 'Copy private code'}
                      </button>
                      {url && (
                        <a href={url} target="_blank" rel="noreferrer">
                          Open {names[platform]} ↗
                        </a>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </article>
        );
      })}
      <button
        type="button"
        className="secondary"
        onClick={() => void refresh.current()}
      >
        <RefreshCw size={14} /> Refresh messaging status
      </button>
      {(error || statusError) && (
        <p className="chat-error" role="alert">
          {error || statusError}
        </p>
      )}
    </section>
  );
}
