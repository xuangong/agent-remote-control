import { useEffect, useRef, useState } from 'react';
import { idleTimeReveal, registerTimeGesture } from './timeline-time-gestures.js';

export function useTimelineTimeSwipe(enabled: boolean, direction: -1 | 1, actionable = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState(idleTimeReveal);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled || !window.matchMedia) return;
    return registerTimeGesture({ element, direction, actionable, publish: setReveal });
  }, [enabled, direction, actionable]);
  return { ref, reveal };
}
