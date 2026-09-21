import { useEffect, useRef, useState } from 'react';
import type { RemoteSessionStatus } from '@orchardworks/agent-remote-web';

const RECOVERY_NOTICE_DELAY_MS = 5000;

/** A disconnect gets one foreground grace period, including retries and catch-up. */
export function useRecoveryNotice(sessionKey: string, status: RemoteSessionStatus, runtimeRecovering: boolean, visible: boolean): boolean {
  const episode = useRef<{ sessionKey: string; timelineDisconnected: boolean; startedAt?: number }>({ sessionKey, timelineDisconnected: false });
  const pageHidden = useRef(false);
  const [elapsedFor, setElapsedFor] = useState<string>();

  useEffect(() => {
    if (episode.current.sessionKey !== sessionKey) {
      episode.current = { sessionKey, timelineDisconnected: false };
      setElapsedFor(undefined);
    }
    const current = episode.current;
    if (status === 'disconnected') current.timelineDisconnected = true;
    else if (status === 'ready' || status === 'idle') current.timelineDisconnected = false;
    const recovering = current.timelineDisconnected || runtimeRecovering;
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
  }, [sessionKey, status, runtimeRecovering, visible]);

  return visible && elapsedFor === sessionKey && (runtimeRecovering || (status !== 'ready' && status !== 'idle'));
}
