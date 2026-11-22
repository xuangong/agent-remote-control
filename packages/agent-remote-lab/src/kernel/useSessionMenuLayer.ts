import { useLayoutEffect, type RefObject } from 'react';

const margin = 8;
const gap = 5;
const properties = ['left', 'top', 'width-limit', 'height-limit'] as const;

/** Keeps anchored menus above floating views without moving their DOM or context. */
export function useSessionMenuLayer(panel: RefObject<HTMLElement>, trigger: RefObject<HTMLElement>, open: boolean) {
  useLayoutEffect(() => {
    const element = panel.current, anchor = trigger.current;
    if (!open || !element || !anchor || typeof element.showPopover !== 'function') return;
    const positioningAnchor = anchor.closest<HTMLElement>('.lab-timeline-tools-content') ?? anchor;
    // Choosing an action settles the toolbar reveal before placing its menu.
    for (const node of [positioningAnchor, positioningAnchor.closest('.lab-timeline-tools')]) {
      for (const animation of node?.getAnimations?.() ?? []) {
        if ('transitionProperty' in animation && animation.transitionProperty === 'transform') animation.finish();
      }
    }
    const clear = () => {
      if (element.matches(':popover-open')) element.hidePopover();
      element.removeAttribute('popover');
      for (const property of properties) element.style.removeProperty(`--session-menu-${property}`);
    };
    const place = () => {
      const triggerBounds = anchor.getBoundingClientRect();
      const button = positioningAnchor.getBoundingClientRect();
      // Heading actions remain inline while their overflow trigger is hidden.
      if (!triggerBounds.width || !triggerBounds.height || getComputedStyle(anchor).visibility === 'hidden') { clear(); return; }
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + margin;
      const top = (viewport?.offsetTop ?? 0) + margin;
      const right = left + (viewport?.width ?? window.innerWidth) - 2 * margin;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 2 * margin;
      const below = Math.max(0, bottom - button.bottom - gap);
      const above = Math.max(0, button.top - top - gap);
      element.style.setProperty('--session-menu-width-limit', `${Math.max(0, right - left)}px`);
      element.style.setProperty('--session-menu-height-limit', `${Math.max(above, below)}px`);
      element.setAttribute('popover', 'manual');
      if (!element.matches(':popover-open')) element.showPopover();
      const size = element.getBoundingClientRect();
      const openAbove = size.height > below && above > below;
      element.style.setProperty('--session-menu-height-limit', `${openAbove ? above : below}px`);
      const height = Math.min(size.height, openAbove ? above : below);
      const leading = !!anchor.closest('.lab-session-heading-leading');
      const x = Math.max(left, Math.min(leading ? button.left : button.right - size.width, right - size.width));
      const y = Math.max(top, Math.min(openAbove ? button.top - gap - height : button.bottom + gap, bottom - height));
      element.style.setProperty('--session-menu-left', `${x}px`);
      element.style.setProperty('--session-menu-top', `${y}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    observer.observe(element);
    if (positioningAnchor !== anchor) observer.observe(positioningAnchor);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      clear();
    };
  }, [panel, trigger, open]);
}
