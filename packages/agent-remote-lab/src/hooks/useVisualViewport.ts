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
      if (frame || document.hidden) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Preserve pinch zoom, tolerating the rounding of an unzoomed viewport.
        if (document.hidden || Math.abs(viewport.scale - 1) > .01) return;
        // Rotation can deliver window and visual viewport dimensions separately.
        // Only compare heights from the same width; a stale landscape height must
        // not shrink the portrait shell or be interpreted as keyboard occlusion.
        const aligned = Math.abs(viewport.width - window.innerWidth) <= 1;
        const height = aligned ? Math.min(viewport.height, window.innerHeight) : window.innerHeight;
        if (height <= 0) return;
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
        // A mismatched rotation sample cannot establish that the keyboard closed.
        // Retain its bounds and safe-area policy until both viewports describe the
        // same width, instead of expanding to full height and shrinking again.
        if (aligned) occluded = Math.max(layoutHeight, retainReference ? unobscuredHeight : 0) - height > 100;
        shell.dataset.viewportOccluded = String(occluded);
        if (aligned && occluded) {
          shell.style.setProperty('--lab-viewport-height', `${height}px`);
          shell.style.setProperty('--lab-viewport-top', `${viewport.offsetTop}px`);
        } else if (!occluded) {
          // Let CSS dynamic viewport units participate in the native rotation.
          // Copying unoccluded measurements into pixels adds a second layout pass
          // and converts late fractional height/offset samples into content shifts.
          shell.style.removeProperty('--lab-viewport-height');
          shell.style.removeProperty('--lab-viewport-top');
        }
        latestUpdate.current?.();
      });
    };
    const cancelSettling = () => { settling.forEach(clearTimeout); settling = []; };
    const settle = () => {
      cancelSettling();
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      update();
      // Standalone WebKit can expose the final keyboard bounds after its event.
      // Sample only during transitions; do not poll while reading or typing.
      settling = [120, 350, 800, 1500, 2500].map(delay => window.setTimeout(update, delay));
    };
    const reorient = () => { referenceWidth = Number.NaN; settle(); };
    settle();
    viewport.addEventListener('resize', settle);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', settle);
    window.addEventListener('scroll', update);
    window.addEventListener('pageshow', settle);
    window.addEventListener('focus', settle);
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
      window.removeEventListener('focus', settle);
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
