import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

export interface SupportingRailProps {
  id: string;
  label: string;
  className: string;
  compact: boolean;
  collapsible?: boolean;
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement>;
  onClose(): void;
  children: ReactNode;
}

const focusableSelector = [
  'button:not([disabled])',
  'a[href]',
  'summary',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex^="-"])',
].join(',');

export function SupportingRail({ id, label, className, compact, collapsible = false, open, triggerRef, onClose, children }: SupportingRailProps): ReactElement | null {
  const railRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!compact || !open) return;
    closeRef.current?.focus();
    return () => {
      if (!restoreFocusRef.current) return;
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    };
  }, [compact, open, triggerRef]);

  if (compact && !open) return null;

  function close(): void {
    restoreFocusRef.current = true;
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (!compact) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const controls = focusableElements(railRef.current);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return <aside
    ref={railRef}
    id={id}
    className={className}
    hidden={!compact && collapsible && !open}
    aria-label={label}
    role={compact ? 'dialog' : undefined}
    aria-modal={compact ? true : undefined}
    onKeyDown={handleKeyDown}
  >
    {compact ? <div className="lab-rail-mobile-heading">
      <strong>{label === 'Context' ? 'Sessions & Hosts' : label}</strong>
      <button ref={closeRef} className="lab-rail-close" type="button" onClick={close}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        <span className="agent-visually-hidden">Close {label}</span>
      </button>
    </div> : null}
    {children}
  </aside>;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.hidden || element.closest('[hidden]')) return false;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement && !parent.open && element !== parent.querySelector(':scope > summary')) return false;
    }
    if (element.matches(':disabled') || element.tabIndex < 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}
