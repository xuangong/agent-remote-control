import { useEffect, useRef } from 'react';

export function useVisualViewport() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const shell = ref.current;
    if (!viewport || !shell) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Pinch zoom pans the existing layout; only keyboard and browser chrome resize it.
        if (viewport.scale !== 1) return;
        shell.style.setProperty('--lab-viewport-height', `${viewport.height}px`);
        shell.style.setProperty('--lab-viewport-top', `${viewport.offsetTop}px`);
      });
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
      shell.style.removeProperty('--lab-viewport-height');
      shell.style.removeProperty('--lab-viewport-top');
    };
  }, []);
  return ref;
}
