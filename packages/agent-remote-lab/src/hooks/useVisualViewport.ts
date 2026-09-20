import { useEffect, useRef } from 'react';

export function useVisualViewport() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = ref.current;
    if (!viewport || !shell) return;
    let frame = 0;
    let settling: number[] = [];
    const update = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // Preserve pinch zoom, tolerating the rounding of an unzoomed viewport.
        if (Math.abs(viewport.scale - 1) > .01) return;
        shell.style.setProperty('--lab-viewport-height', `${viewport.height}px`);
        shell.style.setProperty('--lab-viewport-top', `${viewport.offsetTop}px`);
        // Ignore small browser-chrome changes when adapting floating input panels.
        shell.dataset.viewportOccluded = String(window.innerHeight - viewport.height > 100);
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
    settle();
    viewport.addEventListener('resize', settle);
    viewport.addEventListener('scroll', update);
    window.addEventListener('resize', settle);
    window.addEventListener('scroll', update);
    window.addEventListener('pageshow', settle);
    window.addEventListener('orientationchange', settle);
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
      window.removeEventListener('orientationchange', settle);
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
