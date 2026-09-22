import { useEffect, useRef } from 'react';

export function useVisualViewport(onUpdate?: () => void) {
  const latestUpdate = useRef(onUpdate);
  latestUpdate.current = onUpdate;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = ref.current;
    if (!viewport || !shell) return;
    const coarsePointer = window.matchMedia('(pointer: coarse)');
    let frame = 0;
    let settling: number[] = [];
    let referenceWidth = window.innerWidth;
    let unobscuredHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
    let occluded = false;
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Preserve pinch zoom, tolerating the rounding of an unzoomed viewport.
        if (Math.abs(viewport.scale - 1) > .01) return;
        shell.style.setProperty('--lab-viewport-height', `${viewport.height}px`);
        shell.style.setProperty('--lab-viewport-top', `${viewport.offsetTop}px`);
        const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
        const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]') ?? false;
        const retainReference = coarsePointer.matches && (editing || occluded);
        // Some mobile windows shrink with the keyboard. Keep the pre-focus height
        // until dismissal, but never reuse portrait geometry after a width change.
        if (window.innerWidth !== referenceWidth || !retainReference) {
          referenceWidth = window.innerWidth;
          unobscuredHeight = layoutHeight;
        }
        // Ignore small browser-chrome changes and preserve hardware-keyboard focus.
        occluded = Math.max(layoutHeight, retainReference ? unobscuredHeight : 0) - viewport.height > 100;
        shell.dataset.viewportOccluded = String(occluded);
        latestUpdate.current?.();
      });
    };
    const cancelSettling = () => { settling.forEach(clearTimeout); settling = []; };
    const settle = () => {
      cancelSettling();
      if (document.hidden) return;
      update();
      // Standalone WebKit can expose the final keyboard bounds after its event.
      // Sample only during transitions; do not poll while reading or typing.
      settling = [120, 350, 800].map(delay => window.setTimeout(update, delay));
    };
    const reorient = () => { referenceWidth = Number.NaN; settle(); };
    settle();
    viewport.addEventListener('resize', settle);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', settle);
    window.addEventListener('scroll', update);
    window.addEventListener('pageshow', settle);
    window.addEventListener('orientationchange', reorient);
    document.addEventListener('focusin', settle);
    document.addEventListener('focusout', settle);
    document.addEventListener('visibilitychange', settle);
    return () => {
      cancelAnimationFrame(frame);
      cancelSettling();
      viewport.removeEventListener('resize', settle);
      viewport.removeEventListener('scroll', update);
      window.removeEventListener('resize', settle);
      window.removeEventListener('scroll', update);
      window.removeEventListener('pageshow', settle);
      window.removeEventListener('orientationchange', reorient);
      document.removeEventListener('focusin', settle);
      document.removeEventListener('focusout', settle);
      document.removeEventListener('visibilitychange', settle);
      shell.style.removeProperty('--lab-viewport-height');
      shell.style.removeProperty('--lab-viewport-top');
      delete shell.dataset.viewportOccluded;
    };
  }, []);
  return ref;
}
