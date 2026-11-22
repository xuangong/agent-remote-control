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
        // Text for assistive technology alone is no text a control can cover.
        if (!node.textContent?.trim() || node.parentElement?.closest('.agent-visually-hidden')) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        // A line shows only inside the area's own box, however far it runs before the area clips it.
        for (const rect of range.getClientRects()) {
          const line = { left: Math.max(rect.left, scroller.left), right: Math.min(rect.right, scroller.right), top: Math.max(rect.top, scroller.top), bottom: Math.min(rect.bottom, scroller.bottom) };
          if (line.bottom > line.top && line.right > line.left) lines.push(line);
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

/**
 * Where the frame's floating panels collide, whatever their widths: a panel (the rail, the assistant list, the conversation, the details
 * or a page) that overlaps another or leaves the viewport, a resize handle over a panel, and a page that scrolls sideways. Empty when
 * every panel stands in its own place with the ground between them.
 */
export async function panelOverlaps(page: Page) {
  return page.evaluate(() => {
    const shown = (element: Element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && !element.closest('[hidden]'); };
    const named = (element: Element) => element.getAttribute('aria-label') ?? String(element.className).split(' ')[0]!;
    const meets = (a: DOMRect, b: DOMRect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const panels = [...document.querySelectorAll('.lab-frame > .lab-rail, .lab-frame > main > .orchard-panel, .lab-frame > .lab-page')].filter(shown);
    const handles = [...document.querySelectorAll('.lab-panel-handle')].filter(element => getComputedStyle(element).display !== 'none' && shown(element));
    const found: string[] = [];
    for (const [index, panel] of panels.entries()) {
      const rect = panel.getBoundingClientRect();
      if (rect.left < -0.5 || rect.right > innerWidth + 0.5) found.push(`${named(panel)} leaves the viewport`);
      for (const other of panels.slice(index + 1)) if (meets(rect, other.getBoundingClientRect())) found.push(`${named(panel)} overlaps ${named(other)}`);
      for (const handle of handles) if (meets(rect, handle.getBoundingClientRect())) found.push(`${named(handle)} covers ${named(panel)}`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) found.push('the page scrolls sideways');
    return found;
  });
}
