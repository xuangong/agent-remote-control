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
    {compact ? <button ref={closeRef} className="lab-rail-close" type="button" onClick={close}>Close {label}</button> : null}
    {children}
  </aside>;
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => {
    if (element.hidden || element.closest('[hidden]')) return false;
    if (element.matches(':disabled') || element.tabIndex < 0) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}
