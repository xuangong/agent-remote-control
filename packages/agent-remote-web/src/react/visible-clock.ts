import { useEffect, useState } from 'react';

const subscribers = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let suspended = false;
function tick(): void { const now = Date.now(); for (const subscriber of subscribers) subscriber(now); }
function update(): void {
  clearInterval(timer); timer = undefined;
  if (!subscribers.size || suspended || document.visibilityState === 'hidden') return;
  tick();
  timer = setInterval(tick, 1000);
}
function hide(): void { suspended = true; update(); }
function show(): void { suspended = false; update(); }
function subscribe(listener: (now: number) => void): () => void {
  subscribers.add(listener);
  if (subscribers.size === 1) {
    suspended = false;
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    update();
  } else listener(Date.now());
  return () => {
    subscribers.delete(listener);
    if (subscribers.size) return;
    clearInterval(timer); timer = undefined;
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('pagehide', hide);
    window.removeEventListener('pageshow', show);
  };
}
export function useVisibleClock(enabled: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { if (enabled) return subscribe(setNow); }, [enabled]);
  return now;
}
