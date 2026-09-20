import { useLayoutEffect, type RefObject } from 'react';

/** Keep the desktop popover near its trigger; mobile layout stays centered in CSS. */
export function useAskPosition(panel: RefObject<HTMLElement>, anchor: RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    const element = panel.current;
    const trigger = anchor.current;
    const viewport = element?.parentElement;
    if (!element || !trigger || !viewport) return;
    const place = () => {
      const bounds = viewport.getBoundingClientRect();
      const button = trigger.getBoundingClientRect();
      const panelBounds = element.getBoundingClientRect();
      const margin = 12, gap = 8;
      const below = bounds.bottom - button.bottom - gap - margin;
      const above = button.top - bounds.top - gap - margin;
      const preferredTop = below >= panelBounds.height || below >= above
        ? button.bottom + gap : button.top - panelBounds.height - gap;
      const left = Math.max(margin, Math.min(button.left - bounds.left, bounds.width - panelBounds.width - margin));
      const top = Math.max(margin, Math.min(preferredTop - bounds.top, bounds.height - panelBounds.height - margin));
      element.style.setProperty('--ask-left', `${left}px`);
      element.style.setProperty('--ask-top', `${top}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    observer.observe(trigger);
    observer.observe(viewport);
    window.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [panel, anchor]);
}
