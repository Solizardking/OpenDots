import { Mic, Phone, PhoneOff } from 'lucide-react';
import { CHATGPTEE_CALL_NUMBER } from '../shared/messaging-types';
import './phone-messaging.css';

export const CHATGPTEE_CALL_LABEL = '+1 (256) 472-6195';

export function PhoneActions({
  canTalk,
  voiceStatus,
  onStart,
  onEnd,
}: {
  canTalk: boolean;
  voiceStatus: string;
  onStart: () => void;
  onEnd: () => void;
}) {
  const talking = voiceStatus !== 'idle';
  return (
    <>
      <a
        className="icon-button phone-call-link"
        href={`tel:${CHATGPTEE_CALL_NUMBER}`}
        aria-label={`Call ${CHATGPTEE_CALL_LABEL}`}
        title={`Call ${CHATGPTEE_CALL_LABEL}`}
      >
        <Phone size={18} />
        <span className="phone-call-number">{CHATGPTEE_CALL_LABEL}</span>
      </a>
      <button
        type="button"
        className={`icon-button ${talking ? 'on-call' : ''}`}
        aria-label={talking ? 'End browser voice call' : 'Talk in browser'}
        title={
          talking
            ? 'End the current browser voice call'
            : canTalk
              ? 'Talk with your Dot in this browser'
              : 'Browser voice is unavailable. Enable voice in settings.'
        }
        disabled={voiceStatus === 'ending' || (!canTalk && !talking)}
        onClick={talking ? onEnd : onStart}
      >
        {talking ? <PhoneOff size={18} /> : <Mic size={18} />}
      </button>
    </>
  );
}
