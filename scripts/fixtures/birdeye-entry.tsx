import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BirdeyePanel } from '../../src/client/BirdeyePanel';
import '../../src/client/style.css';
import '../../src/client/brand.css';

function Fixture() {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState('');
  return (
    <main
      className="template-app solana-dots-app"
      style={{
        width: 'min(100%, 850px)',
        margin: 'auto',
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        padding: 12,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 12,
        }}
      >
        <strong>Dot · Birdeye research</strong>
        <button onClick={() => setOpen(!open)}>Research</button>
      </header>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        Your conversation stays in this workspace.
      </div>
      {open && (
        <BirdeyePanel
          threadId="birdeye-fixture"
          paused={false}
          onClose={() => setOpen(false)}
          onAskDot={(text) => {
            setDraft(text);
            setOpen(false);
          }}
        />
      )}
      <textarea
        aria-label="Message your Dot"
        placeholder="Review a research prompt before sending…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        style={{ minHeight: 90, width: '100%', resize: 'vertical' }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
