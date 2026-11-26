import { useLayoutEffect, useState, type RefObject } from 'react';

/** The nearest ancestor that scrolls vertically: the panel a Settings page lives in. */
export function scrollParent(element: HTMLElement | null): HTMLElement | undefined {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return undefined;
}

/**
 * Keeps what the reader looks at where it is while the cards of `grid` change height (a status arrives, a process list grows, the
 * width changes). The anchor is the first card still in view; when the layout moves it and the reader did not scroll, the scroll
 * position follows by the same distance. Engines with their own scroll anchoring agree with it; WebKit has none.
 */
export function useKeptPlace(grid: RefObject<HTMLElement | null>, cardCount: number): void {
  useLayoutEffect(() => {
    const element = grid.current, scroller = scrollParent(element);
    if (!element || !scroller || typeof ResizeObserver === 'undefined') return;
    let anchor: { card: Element; top: number; scrollTop: number } | undefined;
    const remember = () => {
      const edge = scroller.getBoundingClientRect().top;
      const card = [...element.children].find(item => item.getBoundingClientRect().bottom > edge + 1);
      anchor = card ? { card, top: card.getBoundingClientRect().top - edge, scrollTop: scroller.scrollTop } : undefined;
    };
    const follow = () => {
      if (!element.offsetHeight) return;
      if (anchor && anchor.scrollTop === scroller.scrollTop && anchor.scrollTop > 0 && anchor.card.isConnected) {
        const moved = anchor.card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
        if (Math.abs(moved) >= 0.5) scroller.scrollTop += moved;
      }
      remember();
    };
    remember();
    // A scroll event that reports the position already remembered is a late echo of this hook's own correction; the layout it would
    // be measured against may be newer than the correction, so only a scroll to a new position takes a new anchor.
    const scrolled = () => { if (anchor?.scrollTop !== scroller.scrollTop) remember(); };
    const observer = new ResizeObserver(follow);
    observer.observe(element);
    for (const card of element.children) observer.observe(card);
    scroller.addEventListener('scroll', scrolled, { passive: true });
    return () => { observer.disconnect(); scroller.removeEventListener('scroll', scrolled); };
  }, [grid, cardCount]);
}

/**
 * The tallest height a block has had, per key, for as long as the page lives: a block whose content arrives later or varies between
 * refreshes reserves that height, so its neighbours never move when the content changes. `initial` stands in until the first reading.
 */
const tallest = new Map<string, number>();
export function useReservedHeight(key: string, initial: number): { ref: (node: HTMLElement | null) => void; minHeight: number } {
  const [minHeight, setMinHeight] = useState(() => tallest.get(key) ?? initial);
  const [node, ref] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // A hidden page measures 0; only a real height raises the reservation.
      const height = node.getBoundingClientRect().height;
      // The measured height as it is: rounding it up would make the block taller than its content and move what follows by a fraction of a pixel.
      if (height > (tallest.get(key) ?? 0)) { tallest.set(key, height); setMinHeight(height); }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, key]);
  return { ref, minHeight };
}
