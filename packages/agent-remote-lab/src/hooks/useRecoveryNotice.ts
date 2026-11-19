import { useEffect, useRef, useState } from 'react';

const RECOVERY_NOTICE_DELAY_MS = 5000;

/** A lost link gets one foreground grace period before the page says so. */
export function useRecoveryNotice(sessionKey: string, recovering: boolean, visible: boolean): boolean {
  const episode = useRef<{ sessionKey: string; startedAt?: number }>({ sessionKey });
  const pageHidden = useRef(false);
  const [elapsedFor, setElapsedFor] = useState<string>();

  useEffect(() => {
    if (episode.current.sessionKey !== sessionKey) {
      episode.current = { sessionKey };
      setElapsedFor(undefined);
    }
    const current = episode.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (!visible || !recovering || pageHidden.current || document.visibilityState === 'hidden') {
        current.startedAt = undefined;
        setElapsedFor(undefined);
        return;
      }
      current.startedAt ??= performance.now();
      const remaining = RECOVERY_NOTICE_DELAY_MS - (performance.now() - current.startedAt);
      if (remaining <= 0) setElapsedFor(sessionKey);
      else timer = setTimeout(update, remaining);
    };
    const hide = () => { pageHidden.current = true; update(); };
    const show = (event: PageTransitionEvent) => {
      pageHidden.current = false;
      if (event.persisted) { current.startedAt = undefined; setElapsedFor(undefined); }
      update();
    };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    update();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, [sessionKey, recovering, visible]);

  return visible && elapsedFor === sessionKey && recovering;
}
