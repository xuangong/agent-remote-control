import { isUncertainSend, RemoteOperationError } from '@orchardworks/agent-client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SharedByKey } from './shared-by-key.js';

/** Refusals that mean the session never took the message: it may be sent again. */
const NOT_DELIVERED = new Set(['native_session_owned', 'session_read_only', 'session_control_changed', 'host_offline', 'host_unavailable', 'controller_offline']);

/** What the composer that accepted a message supplies to deliver it; the message itself is plain data that any composer for the session can send. */
export interface PendingSendExecutor<P> {
  ready(payload: P): boolean;
  send(payload: P, signal: AbortSignal, dispatch: () => boolean): Promise<void>;
}
export interface WaitingSend<P = unknown> {
  id: string;
  sessionKey: string;
  text: string;
  payload: P;
  phase: 'waiting' | 'preparing' | 'sending' | 'error';
  dispatched: boolean;
  reason?: string;
  /** Held because the session cannot take it (ended, failed, refused, read-only, unopened): only Retry sends it. */
  held?: boolean;
  abort?: AbortController;
  /** The composer that is preparing or sending it; only that one cancels the preparation. */
  owner?: object;
}

interface Member { notify(): void }
interface Queue { items: WaitingSend<any>[]; members: Set<Member> }
const queues = new SharedByKey<Queue>();
const queueFor = (key: string) => queues.get(key, () => ({ items: [], members: new Set() }));
const notifyAll = (queue: Queue) => { for (const member of queue.members) member.notify(); };

/**
 * The waiting messages of a session, shared by every mounted composer for the same key: a composer that replaces another one finds
 * the queue and delivers it, and two composers never deliver the same message twice (the first to claim one owns it).
 * Automatic retries stop at the transport boundary, even when delivery is uncertain.
 */
export function usePendingSend<P>(sessionKey: string, visible: boolean, executor: PendingSendExecutor<P>) {
  const self = useRef<Member & { mounted: boolean }>();
  const pageHidden = useRef(false);
  const latest = useRef({ sessionKey, visible, executor });
  latest.current = { sessionKey, visible, executor };
  const [, refresh] = useState(0);
  if (!self.current) self.current = { mounted: true, notify: () => { if (self.current!.mounted) refresh(value => value + 1); } };
  const me = self.current;
  const queue = queueFor(sessionKey);
  // Every key this composer has shown stays held until it unmounts, as its own queues did before they were shared.
  const keys = useRef(new Map<string, () => void>());
  useLayoutEffect(() => {
    if (keys.current.has(sessionKey)) return;
    const joined = queueFor(sessionKey);
    joined.members.add(me);
    const release = queues.hold(sessionKey);
    keys.current.set(sessionKey, () => { joined.members.delete(me); release(); });
  }, [sessionKey]);
  const foreground = () => me.mounted && latest.current.visible && !pageHidden.current && document.visibilityState !== 'hidden';
  const allowed = (item: WaitingSend<P>) => foreground() && item.sessionKey === latest.current.sessionKey && latest.current.executor.ready(item.payload);
  const remove = (item: WaitingSend<P>) => {
    const own = queueFor(item.sessionKey);
    const index = own.items.indexOf(item);
    if (index !== -1) own.items.splice(index, 1);
    notifyAll(own);
  };
  function update(): void {
    for (const key of keys.current.keys()) {
      const first = queueFor(key).items[0];
      if (first?.phase === 'preparing' && first.owner === me && !allowed(first)) first.abort?.abort();
    }
    const item = queue.items[0] as WaitingSend<P> | undefined;
    if (!item || item.phase !== 'waiting' || !allowed(item)) return;
    const abort = new AbortController();
    item.abort = abort;
    item.owner = me;
    item.phase = 'preparing';
    notifyAll(queue);
    void Promise.resolve().then(() => latest.current.executor.send(item.payload, abort.signal, () => {
      if (abort.signal.aborted || !allowed(item)) return false;
      item.dispatched = true;
      item.phase = 'sending';
      notifyAll(queue);
      return true;
    })).then(() => {
      if (item.dispatched) remove(item);
      else item.phase = item.held ? 'error' : 'waiting';
    }).catch(error => {
      if (!item.dispatched && abort.signal.aborted) item.phase = item.held ? 'error' : 'waiting';
      else {
        // A session's definite refusal (a terminal in control, the Host offline) delivered nothing: the message can be retried.
        // Any other failure after dispatch is uncertain and asks the person to check delivery.
        if (item.dispatched && error instanceof RemoteOperationError && NOT_DELIVERED.has(error.code) && !isUncertainSend(error)) item.dispatched = false;
        item.phase = 'error';
        item.reason = error instanceof Error ? error.message : 'Message could not be sent.';
      }
    }).finally(() => { item.abort = undefined; item.owner = undefined; notifyAll(queue); });
  }
  const watcher = useRef(update); watcher.current = update;
  useEffect(() => { update(); });
  useEffect(() => {
    me.mounted = true;
    const update = () => watcher.current();
    const hide = () => { pageHidden.current = true; update(); };
    const show = () => { pageHidden.current = false; update(); };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    return () => {
      me.mounted = false;
      for (const key of keys.current.keys()) for (const item of queueFor(key).items) if (!item.dispatched && item.owner === me) item.abort?.abort();
      for (const leave of keys.current.values()) leave();
      keys.current.clear();
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', show);
    };
  }, []);
  return {
    items: queue.items as readonly WaitingSend<P>[],
    start(action: { text: string; payload: P }) {
      queue.items.push({ ...action, id: crypto.randomUUID(), sessionKey, phase: 'waiting', dispatched: false });
      notifyAll(queue);
    },
    retry(id: string) {
      const item = queue.items.find(item => item.id === id);
      if (!item || item.phase !== 'error' || item.dispatched) return;
      item.phase = 'waiting'; item.reason = undefined; item.held = false; notifyAll(queue);
    },
    /** Stops every message of this session that has not left, with a reason; each says Not sent until the person retries or cancels it. */
    hold(reason: string) {
      let changed = false;
      for (const item of queue.items) {
        if (item.dispatched || item.phase === 'error' || item.phase === 'sending') continue;
        item.held = true; item.reason = reason; changed = true;
        if (item.phase === 'preparing') item.abort?.abort(); else item.phase = 'error';
      }
      if (changed) notifyAll(queue);
    },
    cancel(id: string) {
      const item = queue.items.find(item => item.id === id);
      if (!item || item.phase === 'sending') return;
      item.abort?.abort(); remove(item);
    },
  };
}
