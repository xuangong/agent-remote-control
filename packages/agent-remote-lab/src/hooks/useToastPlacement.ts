import { useLayoutEffect, useRef } from 'react';
import { useVisualViewport } from './useVisualViewport.js';

/** Measure only while a toast is visible; never subscribe to conversation mutations. */
export function useToastPlacement(anchors: readonly HTMLElement[], active: boolean) {
  const schedule = useRef<() => void>();
  const ref = useVisualViewport(() => schedule.current?.());
  useLayoutEffect(() => {
    const region = ref.current;
    if (!region || !active || !anchors.length || typeof window.matchMedia !== 'function') return;
    const mobile = window.matchMedia('(max-width: 1180px)');
    let frame = 0;
    const clear = () => {
      delete region.dataset.composerAnchored;
      region.style.removeProperty('--lab-toast-anchor');
      region.style.removeProperty('--lab-toast-room');
    };
    const update = () => {
      if (!mobile.matches) { clear(); return; }
      const viewport = window.visualViewport;
      if (viewport && Math.abs(viewport.scale - 1) > .01) return;
      const top = viewport?.offsetTop ?? 0, bottom = top + (viewport?.height ?? window.innerHeight);
      const visible = anchors.filter(element => element.isConnected && element.getClientRects().length)
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.height > 0 && rect.bottom > top && rect.top < bottom);
      if (!visible.length) { clear(); return; }
      const edge = Math.min(...visible.map(rect => rect.top)) - 12;
      region.style.setProperty('--lab-toast-anchor', `${edge}px`);
      region.style.setProperty('--lab-toast-room', `${Math.max(0, edge - top - 12)}px`);
      region.dataset.composerAnchored = 'true';
    };
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); });
    };
    schedule.current = queue;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(queue);
    for (const element of anchors) {
      observer?.observe(element);
      if (element.parentElement) observer?.observe(element.parentElement);
    }
    mobile.addEventListener('change', queue);
    window.addEventListener('resize', queue);
    update();
    return () => {
      schedule.current = undefined;
      cancelAnimationFrame(frame); observer?.disconnect();
      mobile.removeEventListener('change', queue);
      window.removeEventListener('resize', queue);
      clear();
    };
  }, [anchors, active, ref]);
  return ref;
}
