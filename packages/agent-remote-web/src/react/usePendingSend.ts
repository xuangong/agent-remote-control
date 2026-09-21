import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface PendingSend {
  ready(): boolean;
  invalid(): string | undefined;
  send(): void;
}
interface WaitingSend extends PendingSend {
  sessionKey: string;
  phase: 'waiting' | 'warning';
  seconds: number;
  deadline?: number;
  reason?: string;
}

/** Only holds operations that have never crossed the transport boundary. */
export function usePendingSend(sessionKey: string, visible: boolean) {
  const waiting = useRef<WaitingSend>();
  const pageHidden = useRef(false);
  const latest = useRef({ sessionKey, visible });
  latest.current = { sessionKey, visible };
  const [, refresh] = useState(0);
  const notify = () => refresh(value => value + 1);
  const cancel = () => { waiting.current = undefined; notify(); };

  useLayoutEffect(() => () => {
    if (waiting.current?.sessionKey === sessionKey) waiting.current = undefined;
  }, [sessionKey]);

  // Render updates carry fresh readiness, permissions and native turn state.
  // Reinstalling the watcher preserves the original foreground deadline.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const pending = waiting.current;
      if (!pending || pending.sessionKey !== latest.current.sessionKey || pending.phase !== 'waiting') return;
      if (!latest.current.visible || pageHidden.current || document.visibilityState === 'hidden') {
        pending.deadline = undefined;
        if (pending.seconds !== 10) { pending.seconds = 10; notify(); }
        return;
      }
      pending.deadline ??= performance.now() + 10000;
      const remaining = pending.deadline - performance.now();
      const invalid = pending.invalid();
      if (remaining <= 0 || invalid) {
        pending.phase = 'warning';
        pending.reason = invalid;
        pending.seconds = 0;
        notify();
        return;
      }
      if (pending.ready()) {
        waiting.current = undefined;
        notify();
        pending.send();
        return;
      }
      const seconds = Math.ceil(remaining / 1000);
      if (pending.seconds !== seconds) { pending.seconds = seconds; notify(); }
      timer = setTimeout(update, Math.min(1000, remaining));
    };
    const hide = () => { pageHidden.current = true; update(); };
    const show = (event: PageTransitionEvent) => {
      pageHidden.current = false;
      if (event.persisted && waiting.current?.phase === 'waiting') waiting.current.deadline = undefined;
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
  });

  return {
    pending: waiting.current?.sessionKey === sessionKey ? waiting.current : undefined,
    start(action: PendingSend) {
      if (waiting.current) return;
      waiting.current = { ...action, sessionKey, phase: 'waiting', seconds: 10 };
      notify();
    },
    retry() {
      const pending = waiting.current;
      if (!pending || pending.sessionKey !== sessionKey || pending.phase !== 'warning') return;
      const invalid = pending.invalid();
      if (invalid) { pending.reason = invalid; notify(); return; }
      pending.phase = 'waiting'; pending.seconds = 10; pending.deadline = undefined; pending.reason = undefined;
      notify();
    },
    cancel,
  };
}
