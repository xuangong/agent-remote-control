import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * A detached container for a portal whose content must stay mounted while it moves between places in the page.
 * Changing a portal's container remounts its content, so the container stays the same element and moves instead.
 */
export function useMovableHost(): HTMLDivElement {
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'lab-movable-host';
    return element;
  });
  return host;
}

/**
 * Moves `host` into the slot `slot` refers to. Render it before the portal that fills `host` and after the slots:
 * layout effects run in tree order, so the portal's content measures itself in its new place, and a slot rendered
 * in the same commit is already attached. A control focused inside `host` keeps the focus the move would drop.
 */
export function MovableHostSlot({ host, slot }: { host: HTMLElement; slot: RefObject<HTMLElement> }): null {
  useLayoutEffect(() => {
    const target = slot.current;
    if (!target || host.parentNode === target) return;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && host.contains(active) ? active : undefined;
    target.appendChild(host);
    if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
  });
  return null;
}
