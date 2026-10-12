import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUpRight, Download, Menu, X } from 'lucide-react';
import { policies } from 'virtual:chatgptee-docs';
import type { PublicProductPage } from '../shared/public-pages';
import { docsSections } from './docs-model';
import './docs.css';

export default function PolicyPage({
  page,
}: {
  page: Exclude<PublicProductPage, '/docs'>;
}) {
  const policy = policies[page];
  const sections = docsSections(policy.content);
  const intro = policy.content
    .split(/^## /m)[0]
    .replace(/^# .*\n/, '')
    .trim();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    document.title = policy.title + ' — ChatGPTEE';
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', policy.description);
    const scroll = () =>
      requestAnimationFrame(() =>
        document.getElementById(location.hash.slice(1))?.scrollIntoView(),
      );
    scroll();
    window.addEventListener('hashchange', scroll);
    return () => window.removeEventListener('hashchange', scroll);
  }, [policy]);
  return (
    <div className="docs-root">
      <a className="docs-skip" href="#policy-content">
        Skip to policy
      </a>
      <header className="docs-header">
        <a className="docs-brand" href="/docs">
          <img src="/brand/solana-logomark.svg" alt="" />
          <span>
            ChatGP<strong>TEE</strong>
          </span>
          <span className="docs-badge">{page.slice(1).toUpperCase()}</span>
        </a>
        <div className="docs-header-actions">
          <a href={policy.download} download>
            <Download size={16} />
            <span>Download</span>
          </a>
          <a
            className="docs-open"
            href="/login"
            aria-label="Open ChatGPTEE workspace"
          >
            Open workspace <ArrowUpRight size={15} />
          </a>
          <button
            className="docs-menu-button"
            aria-label={menu ? 'Close page menu' : 'Open page menu'}
            aria-expanded={menu}
            aria-controls="policy-sidebar"
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>
      </header>
      <div className="docs-layout">
        {menu && (
          <button
            className="docs-shade"
            aria-label="Close page navigation"
            onClick={() => setMenu(false)}
          />
        )}
        <aside
          id="policy-sidebar"
          className={'docs-sidebar' + (menu ? ' is-open' : '')}
        >
          <nav aria-label="Public product pages" className="docs-public-nav">
            {Object.entries(policies).map(([path, item]) => (
              <a
                key={path}
                href={path}
                aria-current={path === page ? 'page' : undefined}
              >
                {item.title}
              </a>
            ))}
            <a href="/docs">Documentation</a>
          </nav>
          <p className="docs-nav-label">ON THIS PAGE</p>
          <nav aria-label="Policy sections">
            {sections.map((section) => (
              <a
                key={section.id}
                href={'#' + section.id}
                onClick={() => setMenu(false)}
              >
                {section.title}
              </a>
            ))}
          </nav>
          <div className="docs-sidebar-bottom">
            <a href={policy.download} download>
              <Download size={16} /> Download {policy.download.slice(1)}
            </a>
            <a href="/login">Sign in to your workspace</a>
          </div>
        </aside>
        <main className="docs-content" id="policy-content" tabIndex={-1}>
          <nav className="docs-policy-links" aria-label="Public pages">
            <a href="/docs">Docs</a>
            <a
              href="/privacy"
              aria-current={page === '/privacy' ? 'page' : undefined}
            >
              Privacy
            </a>
            <a
              href="/terms"
              aria-current={page === '/terms' ? 'page' : undefined}
            >
              Terms
            </a>
            <a
              href="/service"
              aria-current={page === '/service' ? 'page' : undefined}
            >
              Service
            </a>
          </nav>
          <div className="docs-eyebrow">
            <span className="docs-status-dot" /> CHATGPTEE ·{' '}
            {page.slice(1).toUpperCase()}
          </div>
          <h1>{policy.title}</h1>
          <div className="docs-policy-intro">
            <Markdown remarkPlugins={[remarkGfm]}>{intro}</Markdown>
          </div>
          {sections.map((section) => (
            <section key={section.id} id={section.id} className="docs-section">
              <div className="docs-section-heading">
                <h2>
                  <a href={'#' + section.id}>{section.title}</a>
                </h2>
              </div>
              <Markdown remarkPlugins={[remarkGfm]}>{section.body}</Markdown>
            </section>
          ))}
          <footer className="docs-footer">
            <span>ChatGPTEE</span>
            <a href="/docs">Documentation</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/service">Service</a>
          </footer>
        </main>
      </div>
    </div>
  );
}
