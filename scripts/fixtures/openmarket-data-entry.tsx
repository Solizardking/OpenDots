import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import {
  OpenMarketAnalytics,
  PolymarketAnalytics,
} from '../../src/client/OpenMarketAnalytics';
import { api } from '../../src/client/api';
import '../../src/client/openmarket.css';
function SessionProbe() {
  const [state, setState] = useState('Loading market selection…');
  useEffect(() => {
    void api('/backpack/public/markets')
      .then(() => setState('OpenMarket session ready'))
      .catch((error) => setState(error.message));
  }, []);
  return <p role="status">{state}</p>;
}
createRoot(document.getElementById('root')!).render(
  <main
    className="openmarket-panel"
    style={{ width: '100%', maxWidth: 1200, margin: 'auto', padding: 16 }}
  >
    <SessionProbe />
    <OpenMarketAnalytics defaultOpened />
    <section className="om-content">
      <PolymarketAnalytics />
    </section>
  </main>,
);
