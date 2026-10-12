import { useState } from 'react';
import {
  OpenMarketAnalytics,
  PolymarketAnalytics,
} from './OpenMarketAnalytics';
import './openmarket.css';

export function OpenMarketPanel() {
  const [tab, setTab] = useState<'crypto' | 'polymarket'>('crypto');
  return (
    <section className="openmarket-panel" aria-label="OpenMarket analytics">
      <h2>OpenMarket</h2>
      <p>
        Crypto market data and Polymarket research. Choose an example, then load
        the dataset.
      </p>
      <div className="solana-tabs" role="group" aria-label="OpenMarket section">
        <button
          aria-pressed={tab === 'crypto'}
          onClick={() => setTab('crypto')}
        >
          Crypto
        </button>
        <button
          aria-pressed={tab === 'polymarket'}
          onClick={() => setTab('polymarket')}
        >
          Polymarket
        </button>
      </div>
      {tab === 'crypto' ? (
        <OpenMarketAnalytics defaultOpened />
      ) : (
        <PolymarketAnalytics />
      )}
    </section>
  );
}
