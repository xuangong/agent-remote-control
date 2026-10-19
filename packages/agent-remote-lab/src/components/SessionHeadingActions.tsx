import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useSessionMenuLayer } from '../hooks/useSessionMenuLayer.js';

/** A containing toolbar can own disclosure for all supplied session actions. */
export const SessionHeadingActionsPresentationContext = createContext<'adaptive' | 'inline'>('adaptive');

/** Groups application actions in responsive or explicitly collapsed overflow. */
export function SessionHeadingActions({ children, sessionKey, alwaysCollapsed = false }: { children: ReactNode; sessionKey?: string; alwaysCollapsed?: boolean }) {
  const inline = useContext(SessionHeadingActionsPresentationContext) === 'inline';
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useSessionMenuLayer(panel, trigger, open && !inline);
  useEffect(() => setOpen(false), [sessionKey, inline]);
  useEffect(() => {
    if (!open || inline) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || container.current?.contains(event.target)) return;
      // A child action may open a modal through a portal and return focus here.
      if (event.target.closest('dialog[open]')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open, inline]);
  if (inline) return <>{children}</>;
  return <div ref={container} className="lab-session-heading-actions" data-open={open} data-always-collapsed={alwaysCollapsed || undefined}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault(); event.stopPropagation(); setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    }}>
    <button ref={trigger} type="button" className="lab-session-heading-actions-trigger"
      aria-label="More session actions" title="More session actions" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}>···</button>
    <div ref={panel} id={id} className="lab-session-heading-actions-panel" hidden={alwaysCollapsed && !open}>{children}</div>
  </div>;
}
