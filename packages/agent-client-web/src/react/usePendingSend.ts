import { useEffect, useRef, useState } from 'react';

interface PendingSend {
  text: string;
  ready(): boolean;
  send(signal: AbortSignal, dispatch: () => boolean): Promise<void>;
}
export interface WaitingSend extends PendingSend {
  id: string;
  sessionKey: string;
  phase: 'waiting' | 'preparing' | 'sending' | 'error';
  dispatched: boolean;
  reason?: string;
  abort?: AbortController;
}

/** Automatic retries stop at the transport boundary, even when delivery is uncertain. */
export function usePendingSend(sessionKey: string, visible: boolean) {
  const queues = useRef(new Map<string, WaitingSend[]>());
  const pageHidden = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ sessionKey, visible });
  latest.current = { sessionKey, visible };
  const [, refresh] = useState(0);
  const notify = () => { if (mounted.current) refresh(value => value + 1); };
  const foreground = () => mounted.current && latest.current.visible && !pageHidden.current && document.visibilityState !== 'hidden';
  const allowed = (item: WaitingSend) => foreground() && item.sessionKey === latest.current.sessionKey && item.ready();
  const remove = (item: WaitingSend) => {
    const queue = queues.current.get(item.sessionKey);
    if (queue) {
      const index = queue.indexOf(item);
      if (index !== -1) queue.splice(index, 1);
      if (!queue.length) queues.current.delete(item.sessionKey);
    }
    notify();
  };
  function update(): void {
    for (const queue of queues.current.values()) {
      const item = queue[0];
      if (item?.phase === 'preparing' && !allowed(item)) item.abort?.abort();
    }
    const item = queues.current.get(latest.current.sessionKey)?.[0];
    if (!item || item.phase !== 'waiting' || !allowed(item)) return;
    const abort = new AbortController();
    item.abort = abort;
    item.phase = 'preparing';
    notify();
    void Promise.resolve().then(() => item.send(abort.signal, () => {
      if (abort.signal.aborted || !allowed(item)) return false;
      item.dispatched = true;
      item.phase = 'sending';
      notify();
      return true;
    })).then(() => {
      if (item.dispatched) remove(item);
      else item.phase = 'waiting';
    }).catch(error => {
      if (!item.dispatched && abort.signal.aborted) item.phase = 'waiting';
      else {
        item.phase = 'error';
        item.reason = error instanceof Error ? error.message : 'Message could not be sent.';
      }
    }).finally(() => { item.abort = undefined; notify(); });
  }
  const watcher = useRef(update); watcher.current = update;
  useEffect(() => { update(); });
  useEffect(() => {
    mounted.current = true;
    const update = () => watcher.current();
    const hide = () => { pageHidden.current = true; update(); };
    const show = () => { pageHidden.current = false; update(); };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      mounted.current = false;
      for (const queue of queues.current.values()) for (const item of queue) if (!item.dispatched) item.abort?.abort();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, []);
  return {
    items: queues.current.get(sessionKey) ?? [],
    start(action: PendingSend) {
      const queue = queues.current.get(sessionKey) ?? [];
      queue.push({ ...action, id: crypto.randomUUID(), sessionKey, phase: 'waiting', dispatched: false });
      queues.current.set(sessionKey, queue);
      notify();
    },
    retry(id: string) {
      const item = queues.current.get(sessionKey)?.find(item => item.id === id);
      if (!item || item.phase !== 'error' || item.dispatched) return;
      item.phase = 'waiting'; item.reason = undefined; notify();
    },
    cancel(id: string) {
      const item = queues.current.get(sessionKey)?.find(item => item.id === id);
      if (!item || item.phase === 'sending') return;
      item.abort?.abort(); remove(item);
    },
  };
}
