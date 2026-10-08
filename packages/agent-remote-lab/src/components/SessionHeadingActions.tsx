import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Keeps application-supplied actions available when a Session View is narrow. */
export function SessionHeadingActions({ children, sessionKey }: { children: ReactNode; sessionKey?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(false), [sessionKey]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || container.current?.contains(event.target)) return;
      // A child action may open a modal through a portal and return focus here.
      if (event.target.closest('dialog[open]')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return <div ref={container} className="lab-session-heading-actions" data-open={open}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    }}>
    <button ref={trigger} type="button" className="lab-session-heading-actions-trigger"
      aria-label="More session actions" title="More session actions" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>···</button>
    <div id={id} className="lab-session-heading-actions-panel">{children}</div>
  </div>;
}
