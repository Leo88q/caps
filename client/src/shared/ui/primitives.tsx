import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '@/app/store/ui';

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { maxWidth: 760 } : undefined}>
        {title && <h3 className="modal-title">{title}</h3>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          <div className="strong">{t.title}</div>
          {t.body && <div className="muted small" style={{ marginTop: 2 }}>{t.body}</div>}
          {t.href && <a className="small" href={t.href} target="_blank" rel="noreferrer" style={{ color: 'var(--cg-neon-cyan)' }}>View in explorer ↗</a>}
        </div>
      ))}
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Stat({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="stat">
      <b className={mono ? 'mono' : undefined} style={mono ? undefined : { fontFamily: 'inherit' }}>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function Progress({ value, max, tone }: { value: number; max: number; tone?: 'magenta' | 'acid' | 'orange' | 'trust' }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return <div className={`progress ${tone ?? ''}`}><i style={{ width: `${pct}%` }} /></div>;
}

export type PillProps = {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  tone?: 'danger' | 'ok';
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'role' | 'aria-selected' | 'aria-controls' | 'aria-checked' | 'aria-label' | 'aria-labelledby' | 'tabIndex' | 'id' | 'disabled'>;

export function Pill({ children, active, onClick, tone, ...aria }: PillProps) {
  const cls = `pill ${active ? 'pill-active' : ''} ${tone ? `pill-${tone}` : ''}`;
  // A pill with no handler is a label, not a control: ~10 read-only tag lists across the app rendered a
  // focusable <button> per chip colour — a Tab stop that does nothing, and the reason axe saw
  // "button[tabindex]" as an unallowed child of a tablist. Interactive pills stay buttons; the CSS does
  // not care which tag it is.
  if (!onClick && !aria.role) return <span className={cls}>{children}</span>;
  return (
    <button type="button" className={cls} onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }} {...aria}>
      {children}
    </button>
  );
}

/** Money UI wrapper — everything with balances/prices/fees lives inside one of these. */
export function CleanZone({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`cg-clean-zone ${className}`} style={style}>{children}</div>;
}

export function KV({ k, v, total, accent }: { k: ReactNode; v: ReactNode; total?: boolean; accent?: boolean }) {
  return (
    <div className={`kv ${total ? 'total' : ''}`}>
      <span className="muted">{k}</span>
      <b className={accent ? 'cg-accent' : undefined}>{v}</b>
    </div>
  );
}
