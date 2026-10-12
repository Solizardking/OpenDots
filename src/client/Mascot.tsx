import { useEffect, useState } from 'react';
import { loadAvatar } from './avatar';

export function Mascot({
  state = 'idle',
  small = false,
  avatarId,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  avatarId?: string | null;
  name?: string;
  decorative?: boolean;
}) {
  const [custom, setCustom] = useState<{ id: string; url: string }>();
  const [failedUrl, setFailedUrl] = useState<string>();
  useEffect(() => {
    if (!avatarId) return;
    let active = true;
    void loadAvatar(avatarId)
      .then((avatar) => {
        if (active) setCustom({ id: avatar.id, url: avatar.dataUrl });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [avatarId]);
  const url = avatarId && custom?.id === avatarId ? custom.url : undefined;
  const hasCustom = !!(url && url !== failedUrl);
  return (
    <span
      className={`mascot ${state} ${small ? 'small' : ''} ${hasCustom ? '' : 'clawd-dot'}`}
    >
      <img
        className="dot-body"
        src={hasCustom ? url : '/brand/clawd-mascot.png'}
        onError={() => setFailedUrl(url)}
        alt={decorative ? '' : `${name} is ${state}`}
        width={512}
        height={512}
        draggable={false}
      />
    </span>
  );
}
