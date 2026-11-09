import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.js';

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: IconName; destructive?: boolean; disabled?: boolean; onSelect(): void }
  | { kind: 'separator' };

const ENABLED = '[role="menuitem"]:not([aria-disabled="true"])';
const GAP = 4;
const MARGIN = 8;

/** Where a menu of `size` goes: below `anchor`, or above it when it fits better there; right edges aligned; inside the viewport. */
export function placeMenu(anchor: Pick<DOMRect, 'top' | 'bottom' | 'right'>, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const below = viewport.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const up = size.height > below && above > below;
  const maxHeight = Math.max(0, up ? above : below);
  return {
    top: up ? anchor.top - GAP - Math.min(size.height, maxHeight) : anchor.bottom + GAP,
    left: Math.max(MARGIN, Math.min(anchor.right - size.width, viewport.width - size.width - MARGIN)),
    maxHeight,
  };
}

type Opening = { host: HTMLElement; focus: 'first' | 'last' | 'menu' };

/**
 * A ⋯ (or custom) button that opens a menu. The keyboard opens it on an item, a pointer on the menu itself; the item under
 * the pointer takes focus, so only the focused item is highlighted. Escape, Tab and choosing an item close it and return focus
 * to the button; a press or scroll outside, or a resize, closes it. The menu portals into the dialog holding the button, if any.
 */
export function Menu({ label, icon = 'ellipsis', trigger, items }: { label: string; icon?: IconName; trigger?: ReactNode; items: readonly MenuEntry[] }) {
  const [open, setOpen] = useState<Opening>();
  const [position, setPosition] = useState<CSSProperties>();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const hasIcons = items.some(item => item.kind !== 'separator' && item.icon);
  const show = (focus: Opening['focus']) => setOpen({ host: button.current?.closest('dialog') ?? document.body, focus });
  const close = (restoreFocus: boolean) => {
    setOpen(undefined);
    setPosition(undefined);
    if (restoreFocus) button.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !button.current || !menu.current) return;
    setPosition(placeMenu(button.current.getBoundingClientRect(), { width: menu.current.offsetWidth, height: menu.current.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }));
    const enabled = menu.current.querySelectorAll<HTMLElement>(ENABLED);
    const target = open.focus === 'first' ? enabled[0] : open.focus === 'last' ? enabled[enabled.length - 1] : undefined;
    (target ?? menu.current).focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    const resize = () => close(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const enabled = [...(menu.current?.querySelectorAll<HTMLElement>(ENABLED) ?? [])];
    if (!enabled.length) return;
    const index = enabled.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : index < 0 ? (step > 0 ? 0 : enabled.length - 1)
      : (index + step + enabled.length) % enabled.length;
    enabled[next]!.focus();
  };
  const follow = (target: HTMLElement | null) => { if (target && document.activeElement !== target) target.focus(); };

  return <>
    <button ref={button} type="button" className="ui-icon-button" aria-label={label} title={label} aria-haspopup="menu"
      aria-expanded={Boolean(open)} aria-controls={open ? id : undefined}
      // A click from the keyboard (Enter, Space) has no pointer detail and opens on the first item.
      onClick={event => (open ? close(false) : show(event.detail === 0 ? 'first' : 'menu'))}
      onKeyDown={event => {
        if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
        event.preventDefault();
        show(event.key === 'ArrowDown' ? 'first' : 'last');
      }}>
      {trigger ?? <Icon name={icon} />}
    </button>
    {open ? createPortal(<div ref={menu} id={id} role="menu" aria-label={label} tabIndex={-1} className="ui-menu" style={position}
      onKeyDown={onKeyDown} onPointerLeave={() => follow(menu.current)}>
      {items.map((item, index) => item.kind === 'separator'
        ? <div key={index} role="separator" className="ui-menu-separator" />
        : <button key={index} type="button" role="menuitem" tabIndex={-1} className="ui-menu-item" data-destructive={item.destructive || undefined}
            aria-disabled={item.disabled || undefined}
            onPointerMove={event => follow(item.disabled ? menu.current : event.currentTarget)}
            onClick={() => { if (item.disabled) return; close(true); item.onSelect(); }}>
            {item.icon ? <Icon name={item.icon} size={16} /> : hasIcons ? <span className="ui-menu-item-spacer" /> : null}
            <span>{item.label}</span>
          </button>)}
    </div>, open.host) : null}
  </>;
}
