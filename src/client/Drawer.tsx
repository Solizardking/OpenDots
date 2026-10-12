import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export function Drawer({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const container = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = container.current;
    node?.querySelector<HTMLElement>('button,input,textarea,a[href]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const items = [
          ...(node?.querySelectorAll<HTMLElement>(
            'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href]',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div className="dots-drawer-backdrop" onClick={onClose}>
      <section
        ref={container}
        className="dots-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dots-drawer-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dots-drawer-header">
          <div>
            <span className="eyebrow">CHATGPTEE</span>
            <h2 id="dots-drawer-title">{title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close drawer"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="dots-drawer-body">{children}</div>
      </section>
    </div>
  );
}
