import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { MenuPanel, type MenuEntry } from './Menu.js';

type Opened = { anchor: HTMLElement; host: HTMLElement; label: string; items: readonly MenuEntry[]; point?: { x: number; y: number } };
/** Where a context menu was asked for: the element under the pointer or in focus, and the pointer's place for a right-click. */
export interface ContextMenuRequest { readonly target: Element; readonly point?: { x: number; y: number } }

/** Whether a key press asks for the focused element's context menu: Shift-F10 or the keyboard's context menu key. */
export function isContextMenuKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>): boolean {
  return event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

// The context menu key also makes some systems send a contextmenu event after the key: that one is the same request.
let keyboardRequestAt = -Infinity;

/**
 * The events that ask an element for its context menu: a right-click (at the pointer), and Shift-F10 or the context menu key (beside
 * the focused element). `open` answers with whether it showed a menu; when it did not, the browser shows its own. A long press of a
 * finger keeps the browser's behaviour (text selection, the callout).
 */
export function contextMenuEvents(open: (request: ContextMenuRequest) => boolean) {
  return {
    onContextMenu(event: MouseEvent<HTMLElement>) {
      if (event.defaultPrevented) return;
      const native = event.nativeEvent as Partial<PointerEvent>;
      if (native.pointerType === 'touch') return;
      // A contextmenu event the keyboard made has no pointer: it opens beside the element in focus, unless the key already did.
      const keyboard = native.pointerType === '' || event.clientX === 0 && event.clientY === 0;
      if (keyboard && performance.now() - keyboardRequestAt < 400) { event.preventDefault(); return; }
      const target = keyboard && document.activeElement && event.currentTarget.contains(document.activeElement) ? document.activeElement : event.target as Element;
      if (open({ target, ...(keyboard ? {} : { point: { x: event.clientX, y: event.clientY } }) })) event.preventDefault();
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (event.defaultPrevented || !isContextMenuKey(event)) return;
      if (open({ target: event.target as Element })) { keyboardRequestAt = performance.now(); event.preventDefault(); }
    },
  };
}

/**
 * A context menu of actions (I5d): `show` opens it at the pointer for a right-click, or beside its element for the keyboard,
 * focused on its first item. It is a `MenuPanel`, so Escape, Tab, a choice, a press outside or a scroll that moves its element close
 * it, and the focus goes back to the element it was opened from. `menu` renders it where the owner wants.
 */
export function useContextMenu(): { show(anchor: HTMLElement, label: string, items: readonly MenuEntry[], point?: { x: number; y: number }, focusBack?: HTMLElement): void; menu: ReactNode } {
  const [opened, setOpened] = useState<Opened & { focusBack: HTMLElement }>();
  return {
    show: (anchor, label, items, point, focusBack = anchor) => setOpened({ anchor, host: anchor.closest('dialog') ?? document.body, label, items, focusBack, ...(point ? { point } : {}) }),
    menu: opened ? <MenuPanel key={`${opened.point?.x ?? ''}:${opened.point?.y ?? ''}:${opened.label}`} label={opened.label} items={opened.items} host={opened.host}
      focus={opened.point ? 'menu' : 'first'} anchor={() => opened.anchor} {...(opened.point ? { point: opened.point } : {})}
      onClose={restoreFocus => { setOpened(undefined); if (restoreFocus && opened.focusBack.isConnected) opened.focusBack.focus({ preventScroll: true }); }} /> : null,
  };
}
