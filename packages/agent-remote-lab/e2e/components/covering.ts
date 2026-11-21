import type { Page } from '@playwright/test';

/**
 * Every control in a fixed or absolutely positioned layer over a text area: by default every visible timeline, so every tile
 * of a Window (`content` names another area, such as a list or a sheet's body, or the composer's capsule), across the width its text lines take. It is generic, so a control added later
 * is caught too. Controls inside the area (its own content) and toasts, which are transient and dismissible notifications,
 * are not resident controls. A control counts where it shows: the part its own scrolling or clipping ancestors cut off covers nothing.
 */
export async function coveringControls(page: Page, content = '.lab-timeline-scroll') {
  return page.evaluate(selector => {
    type Box = { left: number; top: number; right: number; bottom: number };
    const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const areas = [...document.querySelectorAll(selector)].filter(element => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !element.closest('[hidden], [inert]');
    });
    if (!areas.length) return ['no conversation text'];
    // Behind an open modal (a sheet) nothing can cover its content: only the modal's own controls count then.
    const modal = document.querySelector('dialog:modal');
    const controls = [...document.querySelectorAll('button, a[href], input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('.lab-toast-region, [inert], [aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden')
      .filter(element => !modal || modal.contains(element));
    const found = new Set<string>();
    for (const timeline of areas) {
      const scroller = timeline.getBoundingClientRect();
      const lines: Box[] = [];
      const walker = document.createTreeWalker(timeline, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          const line = { left: rect.left, right: rect.right, top: Math.max(rect.top, scroller.top), bottom: Math.min(rect.bottom, scroller.bottom) };
          if (line.bottom > line.top && rect.width > 0) lines.push(line);
        }
      }
      if (!lines.length) { found.add('no conversation text'); continue; }
      const positioned = (element: Element) => {
        for (let current: Element | null = element; current && current !== document.body; current = current.parentElement) {
          if (current.contains(timeline)) return false;
          if (['fixed', 'absolute'].includes(getComputedStyle(current).position)) return true;
        }
        return false;
      };
      // Text scrolls through the whole visible area, so the area is that height across the width its lines take.
      const area = { left: Math.min(...lines.map(line => line.left)), right: Math.max(...lines.map(line => line.right)), top: scroller.top, bottom: scroller.bottom };
      /** The part of a control that shows: its box cut by every ancestor that scrolls or clips. */
      const shown = (element: Element): Box => {
        const rect = element.getBoundingClientRect();
        const box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        for (let current = element.parentElement; current && current !== document.body; current = current.parentElement) {
          const style = getComputedStyle(current);
          if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
          const clip = current.getBoundingClientRect();
          box.left = Math.max(box.left, clip.left); box.top = Math.max(box.top, clip.top);
          box.right = Math.min(box.right, clip.right); box.bottom = Math.min(box.bottom, clip.bottom);
        }
        return box;
      };
      for (const element of controls) {
        if (timeline.contains(element) || !positioned(element)) continue;
        const box = shown(element);
        if (box.right > box.left && box.bottom > box.top && meets(box, area)) found.add(element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 30) ?? element.tagName);
      }
    }
    return [...found];
  }, content);
}
