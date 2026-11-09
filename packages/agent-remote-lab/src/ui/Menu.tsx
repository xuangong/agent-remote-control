import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './Icon.js';

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: IconName; destructive?: boolean; disabled?: boolean; onSelect(): void }
  | { kind: 'separator' };

const ENABLED = '[role="menuitem"]:not([aria-disabled="true"])';
const NAVIGATION = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
const GAP = 4;
const MARGIN = 8;

/** Where a menu of `size` goes: below `anchor`, or above it when it fits better there; right edges aligned; inside the viewport. */
export function placeMenu(anchor: Pick<DOMRect, 'top' | 'bottom' | 'right'>, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const below = viewport.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const up = size.height > below && above > below;
  const maxHeight = Math.max(0, up ? above : below);
  return {
    top: up ? Math.max(MARGIN, anchor.top - GAP - Math.min(size.height, maxHeight)) : anchor.bottom + GAP,
    left: Math.max(MARGIN, Math.min(anchor.right - size.width, viewport.width - size.width - MARGIN)),
    maxHeight,
    up,
  };
}

type Opening = { host: HTMLElement; focus: 'first' | 'last' | 'menu' };

/**
 * A ⋯ button that opens a menu of actions. The keyboard opens it on an item, a pointer on the menu itself; the item under
 * the pointer takes focus, so only the focused item is highlighted. Escape, Tab and choosing an item close it and return
 * focus to the button (before the action runs). A press outside, a scroll that moves the button, or the window losing
 * focus closes it; a resize moves it. It portals into the dialog holding the button, if any, so a modal dialog does not
 * make it inert.
 */
export function Menu({ label, icon = 'ellipsis', items }: { label: string; icon?: IconName; items: readonly MenuEntry[] }) {
  const [open, setOpen] = useState<Opening>();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const hasIcons = items.some(item => item.kind !== 'separator' && item.icon);
  const show = (focus: Opening['focus']) => setOpen({ host: button.current?.closest('dialog') ?? document.body, focus });
  const close = (restoreFocus: boolean) => {
    setOpen(undefined);
    if (restoreFocus) button.current?.focus();
  };
  // Written straight to the node, before anything in it takes focus, so focusing an item scrolls within the final height.
  const place = () => {
    const node = menu.current, anchor = button.current;
    if (!node || !anchor) return;
    node.style.maxHeight = '';
    const { top, left, maxHeight, up } = placeMenu(anchor.getBoundingClientRect(),
      { width: node.offsetWidth, height: node.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    Object.assign(node.style, { top: `${top}px`, left: `${left}px`, maxHeight: `${maxHeight}px`, transformOrigin: up ? 'bottom right' : 'top right' });
  };

  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    place();
    // A host still animating in (a sheet sliding up) is the menu's containing block until it settles: place the menu again then.
    const settling = open.host.getAnimations?.() ?? [];
    if (settling.length) void Promise.all(settling.map(animation => animation.finished)).then(place, () => undefined);
    const enabled = menu.current.querySelectorAll<HTMLElement>(ENABLED);
    const target = open.focus === 'first' ? enabled[0] : open.focus === 'last' ? enabled[enabled.length - 1] : undefined;
    (target ?? menu.current).focus();
  }, [open]);
  // Items may change while the menu is open; keep focus in it so the keyboard still works.
  useLayoutEffect(() => {
    if (open && menu.current && !menu.current.contains(document.activeElement)) menu.current.focus();
  }, [open, items]);
  useEffect(() => {
    if (!open) return;
    // Returns focus to the button only while it is still in the menu, never taking it from where the user put it.
    const dismiss = () => close(Boolean(menu.current?.contains(document.activeElement)));
    const pressed = (event: Event) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close(false);
    };
    // Only a scroll that moves the button closes the menu: streaming timelines elsewhere scroll all the time.
    const scrolled = (event: Event) => {
      if (button.current && event.target instanceof Node && event.target.contains(button.current)) dismiss();
    };
    document.addEventListener('pointerdown', pressed, true);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', place);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', pressed, true);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('blur', dismiss);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' && event.key !== 'Tab' && !NAVIGATION.includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      close(true);
      return;
    }
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
  // A click from the keyboard (Enter, Space) carries no pointer detail and opens on the first item.
  const toggle = (detail: number) => (open ? close(false) : show(detail === 0 ? 'first' : 'menu'));

  return <>
    <button ref={button} type="button" className="ui-icon-button" aria-label={label} title={label} aria-haspopup="menu"
      aria-expanded={Boolean(open)} aria-controls={open ? id : undefined} onClick={event => toggle(event.detail)}
      onKeyDown={event => {
        if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
        event.preventDefault();
        show(event.key === 'ArrowDown' ? 'first' : 'last');
      }}>
      <Icon name={icon} />
    </button>
    {open ? createPortal(<div ref={menu} id={id} role="menu" aria-label={label} tabIndex={-1} className="ui-menu"
      onKeyDown={onKeyDown} onPointerLeave={() => follow(menu.current)}>
      {items.map((item, index) => item.kind === 'separator'
        ? <div key={`separator-${index}`} role="separator" className="ui-menu-separator" />
        : <button key={item.label} type="button" role="menuitem" tabIndex={-1} className="ui-menu-item" data-destructive={item.destructive || undefined}
            aria-disabled={item.disabled || undefined}
            onPointerMove={event => follow(item.disabled ? menu.current : event.currentTarget)}
            onClick={() => { if (item.disabled) return; close(true); item.onSelect(); }}>
            {item.icon ? <Icon name={item.icon} size={16} /> : hasIcons ? <span className="ui-menu-item-spacer" /> : null}
            <span>{item.label}</span>
          </button>)}
    </div>, open.host) : null}
  </>;
}
