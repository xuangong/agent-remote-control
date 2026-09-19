import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
export function SessionPopover({ label, trigger, className = '', children, onOpen }: { label: string; trigger: ReactNode; className?: string; children(close: () => void): ReactNode; onOpen?(): void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = () => { setOpen(false); button.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    panel.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return <div className={`lab-session-popover ${className}`} ref={root}
    onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <button type="button" ref={button} className="lab-session-popover-trigger" aria-label={label} aria-expanded={open} aria-controls={id}
      onClick={() => { if (!open) onOpen?.(); setOpen(value => !value); }}>{trigger}</button>
    {open ? <section ref={panel} tabIndex={-1} id={id} className="lab-session-popover-panel" aria-label={label}>
      <div className="lab-directory-heading"><h2>{label}</h2><button type="button" aria-label={`Close ${label}`} onClick={close}>×</button></div>
      {children(close)}
    </section> : null}
  </div>;
}
