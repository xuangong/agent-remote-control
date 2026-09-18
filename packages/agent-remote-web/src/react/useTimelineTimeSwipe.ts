import { useEffect, useRef, useState } from 'react';

const revealWidth = 116;
const idle = { offset: 0, top: 0, dragging: false };

export function useTimelineTimeSwipe(enabled: boolean, direction: -1 | 1) {
  const ref = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState(idle);

  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled || !window.matchMedia) return;
    const mobile = window.matchMedia('(max-width: 1180px)');
    let gesture: { id: number; x: number; y: number; top: number; started: number; locked: boolean; distance: number } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let suppressClickUntil = 0;
    function reset() {
      clearTimeout(timer);
      gesture = undefined;
      setReveal(idle);
    }
    function start(event: TouchEvent) {
      reset();
      suppressClickUntil = 0;
      if (!mobile.matches || event.touches.length !== 1 || window.getSelection()?.toString()) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (!target || target.closest('input, textarea, select, [contenteditable="true"], pre, code, table, img, video, audio')) return;
      for (let node: Element | null = target; node && node !== element; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
      }
      const touch = event.touches[0]!;
      // Leave screen-edge navigation to the browser, and long presses to selection.
      if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return;
      const bounds = element!.getBoundingClientRect();
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY,
        top: Math.max(22, Math.min(bounds.height - 22, touch.clientY - bounds.top)),
        started: Date.now(), locked: false, distance: 0 };
    }
    function move(event: TouchEvent) {
      if (!gesture) return;
      if (event.touches.length !== 1 || !mobile.matches) { reset(); return; }
      const touch = event.touches[0]!;
      if (touch.identifier !== gesture.id) { reset(); return; }
      const dx = (touch.clientX - gesture.x) * direction;
      const dy = Math.abs(touch.clientY - gesture.y);
      if (!gesture.locked) {
        if (Math.max(Math.abs(dx), dy) < 10) { event.stopPropagation(); return; }
        if (Date.now() - gesture.started > 350 || dx < 0 || dx < dy * 1.4) { reset(); return; }
        gesture.locked = true;
      }
      if (!event.cancelable) { reset(); return; }
      event.preventDefault();
      gesture.distance = Math.max(0, Math.min(revealWidth, dx));
      suppressClickUntil = Date.now() + 500;
      setReveal({ offset: gesture.distance * direction, top: gesture.top, dragging: true });
    }
    function end() {
      if (gesture?.locked) suppressClickUntil = Date.now() + 500;
      if (!gesture?.locked || gesture.distance < 36) { reset(); return; }
      setReveal({ offset: revealWidth * direction, top: gesture.top, dragging: false });
      gesture = undefined;
      timer = setTimeout(reset, 1400);
    }
    function click(event: MouseEvent) {
      if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
    }
    element.addEventListener('touchstart', start, { passive: true });
    // Cancel only a confirmed horizontal reveal, preserving native vertical/pinch scrolling.
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', reset);
    element.addEventListener('click', click, true);
    mobile.addEventListener('change', reset);
    window.addEventListener('blur', reset);
    return () => {
      clearTimeout(timer);
      element.removeEventListener('touchstart', start);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', reset);
      element.removeEventListener('click', click, true);
      mobile.removeEventListener('change', reset);
      window.removeEventListener('blur', reset);
    };
  }, [enabled, direction]);
  return { ref, reveal };
}
