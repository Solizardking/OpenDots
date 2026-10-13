import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './editor.css';
import { SolanaProvider } from './SolanaProvider';
import { AuthGate } from './AuthGate';
import './brand.css';
import './desktop.css';
import { PairPhone } from './PairPhone';
import { setToken } from './api';
import type {} from '../shared/desktop-types';
import { watchSystemTheme } from './theme';
import { lazy, Suspense } from 'react';
import { publicProductPage, normalizePagePath } from '../shared/public-pages';
import SupermemoryCallback, { captureSupermemoryCallback } from './SupermemoryCallback';
const publicPage = publicProductPage(location.pathname);
const pagePath = normalizePagePath(location.pathname);
const supermemoryCallback = pagePath === '/supermemory/callback'
  ? captureSupermemoryCallback(location.search, () =>
      history.replaceState(null, '', '/supermemory/callback'),
    )
  : undefined;
const PolicyPage = lazy(() => import('./PolicyPage'));
const DocsPage = lazy(() => import('./DocsPage'));
const AgentAuthorization = lazy(() => import('./AgentAuthorization'));
watchSystemTheme();
if (window.solanaDots) {
  const { token } = await window.solanaDots.session();
  setToken(token);
  document.documentElement.classList.add('native-desktop');
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {window.solanaDots && (
      <div className="native-titlebar">
        <span>CHATGPTEE</span>
      </div>
    )}
    {publicPage ? (
      <Suspense fallback={<p>Loading documentation…</p>}>
        {publicPage === '/docs' ? (
          <DocsPage />
        ) : (
          <PolicyPage page={publicPage} />
        )}
      </Suspense>
    ) : (
      <SolanaProvider>
        {pagePath === '/authorize' ? (
          <Suspense fallback={<p>Loading agent access…</p>}>
            <AgentAuthorization />
          </Suspense>
        ) : ['/pair', '/connect'].includes(pagePath) ? (
          <PairPhone />
        ) : (
          <AuthGate>
            {supermemoryCallback ? <SupermemoryCallback request={supermemoryCallback} /> : <App />}
          </AuthGate>
        )}
      </SolanaProvider>
    )}
  </React.StrictMode>,
);
