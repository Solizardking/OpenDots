import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { Mascot } from './Mascot';
import { rememberAvatar, type Avatar } from './avatar';
export function AvatarEditor({
  avatarId,
  onChange,
  configured,
  name,
  identity,
  onBusy,
}: {
  avatarId: string | null;
  onChange: (id: string | null) => void;
  configured: boolean;
  name: string;
  identity?: string;
  onBusy: (busy: boolean) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const generate = async (editing: boolean) => {
    controller.current = new AbortController();
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const avatar = await api<Avatar>(
        '/avatars',
        'POST',
        { prompt, ...(editing && avatarId ? { sourceId: avatarId } : {}) },
        controller.current.signal,
      );
      rememberAvatar(avatar);
      onChange(avatar.id);
      setPrompt('');
    } catch (e) {
      if (!controller.current.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Could not generate this avatar.',
        );
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  return (
    <fieldset className="avatar-editor space-access-fields">
      <legend>Dot avatar</legend>
      <div className="avatar-preview">
        <Mascot
          identity={identity}
          avatarId={avatarId}
          name={name || 'Dot'}
          state={busy ? 'working' : 'idle'}
        />
      </div>
      <label className="field-label" htmlFor="avatar-prompt">
        {avatarId
          ? 'Describe an edit or a new look'
          : 'Describe your Dot’s look'}
      </label>
      <textarea
        id="avatar-prompt"
        rows={2}
        maxLength={1500}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="A mint-green plush owl with round glasses"
        disabled={busy || !configured}
      />
      <div className="avatar-actions">
        <button
          type="button"
          disabled={busy || !configured || prompt.trim().length < 3}
          onClick={() => void generate(false)}
        >
          {busy ? 'Creating…' : 'Generate avatar'}
        </button>
        {avatarId && (
          <button
            type="button"
            disabled={busy || !configured || prompt.trim().length < 3}
            onClick={() => void generate(true)}
          >
            Edit this avatar
          </button>
        )}
        {avatarId && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => onChange(null)}
          >
            Use CLAWD avatar
          </button>
        )}
      </div>
      <p className="muted">
        {configured
          ? 'Generate with Grok Imagine 2.0. Save these settings to use your avatar everywhere.'
          : 'Add XAI_API_KEY to the server environment to generate and edit avatars.'}
      </p>
      {busy && (
        <p role="status">
          Your avatar is being created. This can take a minute.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
