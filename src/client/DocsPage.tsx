import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  Copy,
  Download,
  Menu,
  Search,
  X,
} from 'lucide-react';
import { article, guide, routeCount } from 'virtual:chatgptee-docs';
import { docsSections, filterDocs } from './docs-model';
import './docs.css';

const sections = docsSections(guide);
function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : String(child),
    )
    .join('');
}
function CopyBlock({ children }: { children?: ReactNode }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="docs-code">
      <button
        className="docs-copy"
        type="button"
        aria-label="Copy code example"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              plainText(children).replace(/\n$/, ''),
            );
            setState('copied');
          } catch {
            setState('failed');
          }
        }}
      >
        {state === 'copied' ? <Check size={14} /> : <Copy size={14} />}
        {state === 'copied'
          ? 'Copied'
          : state === 'failed'
            ? 'Select to copy'
            : 'Copy'}
      </button>
      <pre>{children}</pre>
      <span className="docs-sr-only" role="status">
        {state === 'copied'
          ? 'Example copied to clipboard'
          : state === 'failed'
            ? 'Clipboard unavailable. Select the example and copy it.'
            : ''}
      </span>
    </div>
  );
}
export default function DocsPage() {
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(false);
  const [active, setActive] = useState(location.hash.slice(1) || 'overview');
  const [tab, setTab] = useState<'guide' | 'article'>('guide');
  const visible = filterDocs(sections, query);
  useEffect(() => {
    document.title = 'ChatGPTEE Docs — Dots, Spaces, computers and Solana';
    const description = document.querySelector('meta[name="description"]');
    description?.setAttribute(
      'content',
      'Complete ChatGPTEE documentation for Dots, Spaces, agent computers, permissions, wallets, APIs and deployment.',
    );
  }, []);
  useEffect(() => {
    const scrollToHash = () => {
      const id = location.hash.slice(1);
      if (id === 'article') {
        setTab('article');
        return;
      }
      if (id) {
        setTab('guide');
        setQuery('');
        setActive(id);
      }
    };
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, []);
  useEffect(() => {
    if (
      tab === 'guide' &&
      !query &&
      location.hash &&
      location.hash !== '#article'
    ) {
      const frame = requestAnimationFrame(() =>
        document.getElementById(active)?.scrollIntoView(),
      );
      return () => cancelAnimationFrame(frame);
    }
    if (tab === 'article') document.getElementById('docs-root')?.scrollTo(0, 0);
  }, [active, tab, query]);
  return (
    <div className="docs-root" id="docs-root">
      <a className="docs-skip" href="#docs-content">
        Skip to documentation
      </a>
      <header className="docs-header">
        <a
          className="docs-brand"
          href="/docs"
          aria-label="ChatGPTEE documentation"
        >
          <img src="/brand/solana-logomark.svg" alt="" />
          <span>
            ChatGP<strong>TEE</strong>
          </span>
          <span className="docs-badge">DOCS</span>
        </a>
        <div className="docs-header-actions">
          <a href="/docs/GUIDE.md" download>
            <Download size={16} />
            <span>Download guide</span>
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
            aria-label={
              menu ? 'Close documentation menu' : 'Open documentation menu'
            }
            aria-expanded={menu}
            aria-controls="docs-sidebar"
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
            aria-label="Close documentation menu"
            onClick={() => setMenu(false)}
          />
        )}
        <aside
          id="docs-sidebar"
          className={'docs-sidebar' + (menu ? ' is-open' : '')}
        >
          <label className="docs-search">
            <Search size={16} />
            <input
              type="search"
              placeholder="Search documentation…"
              aria-label="Search documentation"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setTab('guide');
              }}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={14} />
              </button>
            )}
          </label>
          <p className="docs-nav-label">
            {query ? visible.length + ' matching sections' : 'IN THIS GUIDE'}
          </p>
          <nav aria-label="Documentation sections">
            {visible.map((section) => (
              <a
                key={section.id}
                href={'#' + section.id}
                aria-current={
                  tab === 'guide' && active === section.id
                    ? 'location'
                    : undefined
                }
                onClick={() => {
                  setTab('guide');
                  setActive(section.id);
                  setMenu(false);
                }}
              >
                {section.title}
              </a>
            ))}
          </nav>
          {visible.length === 0 && (
            <p className="docs-empty">
              No sections match. Try a provider, feature or API path.
            </p>
          )}
          <div className="docs-sidebar-bottom">
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
            <a href="/service">Service</a>
            <a
              href="#article"
              onClick={() => {
                setTab('article');
                setMenu(false);
              }}
            >
              <BookOpen size={16} /> Read the article
            </a>
            <a href="/docs/ARTICLE.md" download>
              <Download size={16} /> Download ARTICLE.md
            </a>
            <a href="/docs/API.md" download>
              API reference · Markdown
            </a>
            <a href="/docs/api.json" download>
              API route manifest · JSON
            </a>
            <a href="/agent/SKILL.md">
              External agent setup <ArrowUpRight size={13} />
            </a>
          </div>
        </aside>
        <main className="docs-content" id="docs-content" tabIndex={-1}>
          <div className="docs-eyebrow">
            <span className="docs-status-dot" /> PUBLIC PRODUCT DOCUMENTATION
          </div>
          <h1>
            {tab === 'article'
              ? 'Agents that follow through.'
              : 'Your workspace, explained.'}
          </h1>
          <p className="docs-lead">
            {tab === 'article'
              ? 'How ChatGPTEE connects persistent context, useful tools and accountable actions.'
              : 'From your first Dot to a reviewed Solana transaction. Learn the features, permissions, integrations and APIs that make ChatGPTEE work.'}
          </p>
          <div className="docs-tabs" aria-label="Documentation view">
            <button
              aria-pressed={tab === 'guide'}
              onClick={() => {
                setTab('guide');
                history.replaceState(null, '', '/docs');
              }}
            >
              Complete guide
            </button>
            <button
              aria-pressed={tab === 'article'}
              onClick={() => {
                setTab('article');
                history.replaceState(null, '', '/docs#article');
              }}
            >
              The innovation article
            </button>
            <span>
              {sections.length} sections · {routeCount} API routes
            </span>
          </div>
          {tab === 'guide' ? (
            <>
              {!query && (
                <div className="docs-start-grid">
                  <a href="#quick-start">
                    <span>01 / GET STARTED</span>
                    <strong>Create your first Dot</strong>
                    <p>Set up an account, a Space and a specialist.</p>
                    <ArrowUpRight size={19} />
                  </a>
                  <a href="#api-usage-and-contracts">
                    <span>02 / BUILD WITH IT</span>
                    <strong>Understand the API</strong>
                    <p>Session boundaries, request examples and routes.</p>
                    <ArrowUpRight size={19} />
                  </a>
                  <a href="#wallets-and-custody">
                    <span>03 / STAY IN CONTROL</span>
                    <strong>Review before signing</strong>
                    <p>Wallets, tool permissions and exact approvals.</p>
                    <ArrowUpRight size={19} />
                  </a>
                </div>
              )}
              {query && (
                <p className="docs-search-summary" role="status">
                  {visible.length} sections match “{query}”.{' '}
                  <button onClick={() => setQuery('')}>
                    Show all sections
                  </button>
                </p>
              )}
              {visible.length === 0 && (
                <div className="docs-no-results">
                  <h2>No results</h2>
                  <p>Try “Jupiter”, “computer”, “provider” or “/api/pages”.</p>
                  <button onClick={() => setQuery('')}>Clear search</button>
                </div>
              )}
              {visible.map((section, index) => (
                <section
                  className="docs-section"
                  id={section.id}
                  key={section.id}
                >
                  <div className="docs-section-heading">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <h2>
                      <a href={'#' + section.id}>{section.title}</a>
                    </h2>
                  </div>
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{ pre: CopyBlock }}
                  >
                    {section.body}
                  </Markdown>
                </section>
              ))}
            </>
          ) : (
            <article className="docs-article" id="article">
              <a
                className="docs-article-download"
                href="/docs/ARTICLE.md"
                download
              >
                <Download size={16} /> Download the article
              </a>
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{ pre: CopyBlock }}
              >
                {article}
              </Markdown>
            </article>
          )}
          <footer className="docs-footer">
            <span>ChatGPTEE · Built on OpenDots</span>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/service">Service</a>
            <a
              href="#overview"
              onClick={() => {
                setTab('guide');
                setQuery('');
              }}
            >
              Back to overview ↑
            </a>
            <a href="/docs/GUIDE.md" download>
              Keep an offline copy
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}
