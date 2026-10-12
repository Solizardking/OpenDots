import { useState } from 'react';
import { Smartphone, ShieldCheck } from 'lucide-react';

export function PairPhone() {
  const [credential, setCredential] = useState(() =>
    decodeURIComponent(location.hash.slice(1)),
  );
  const [name, setName] = useState('My phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Keep the pairing token out of history, referrers and copied URLs.
  if (location.hash) history.replaceState(null, '', location.pathname);
  return (
    <main className="phone-pair-page">
      <section className="phone-pair-card">
        <img
          src="/brand/solana-logomark.svg"
          alt="ChatGPTEE"
          className="phone-pair-icon"
        />
        <span className="eyebrow">CHATGPTEE COMPANION</span>
        <h1>
          Your Dots.
          <br />
          Wherever you go.
        </h1>
        <p>
          Pair this phone with your Mac to continue your conversations and work
          in your Spaces.
        </p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              const response = await fetch('/api/companion/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credential, name }),
              });
              const result = await response.json();
              if (!response.ok) throw Error(result.error || 'Pairing failed.');
              location.replace('/');
            } catch (error) {
              setError(
                error instanceof Error
                  ? error.message
                  : 'Your Mac could not be reached.',
              );
              setBusy(false);
            }
          }}
        >
          <label className="field-label" htmlFor="phone-name">
            Device name
          </label>
          <input
            id="phone-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={60}
          />
          {credential.length < 20 && (
            <>
              <label className="field-label" htmlFor="phone-code">
                Pairing code
              </label>
              <input
                id="phone-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                value={credential}
                onChange={(event) =>
                  setCredential(
                    event.target.value.replace(/\D/g, '').slice(0, 6),
                  )
                }
                required
                placeholder="000000"
              />
            </>
          )}
          <button className="primary full" disabled={busy}>
            <Smartphone size={18} /> {busy ? 'Pairing…' : 'Pair with Mac'}
          </button>
        </form>
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <p className="phone-pair-note">
          <ShieldCheck size={16} /> Your Mac controls access. Keys and wallet
          signing stay there.
        </p>
      </section>
    </main>
  );
}
