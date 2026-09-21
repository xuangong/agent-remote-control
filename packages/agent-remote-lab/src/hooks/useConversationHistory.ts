import { useEffect, useRef, useState } from 'react';
import { controllerPath } from '@orchardworks/agent-remote-hosted/controller-location';
import { sessionKey, sessionRootKey, type SessionEntry } from '../session-tree.js';

interface Visit { id: string; session: SessionEntry; root: string }
const storageKey = 'agent-remote-conversation-history';
function restoreVisits(): Visit[] {
  try {
    const visits: Visit[] = JSON.parse(window.sessionStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(visits) || !visits.some(visit => visit.id === window.history.state?.agentRemoteVisit)) return [];
    for (const visit of visits) {
      if (typeof visit.id !== 'string' || typeof visit.root !== 'string' || typeof visit.session?.title !== 'string' || typeof visit.session?.nativeSessionId !== 'string' || typeof visit.session?.providerId !== 'string') return [];
      controllerPath({ ...visit.session, hostId: visit.session.hostId ?? 'local' });
    }
    return visits;
  } catch { return []; }
}

export function useConversationHistory(current: SessionEntry | undefined, known: readonly SessionEntry[], open: (session: SessionEntry) => Promise<boolean>) {
  const [restored] = useState(restoreVisits);
  const visits = useRef<Visit[]>(restored);
  const position = useRef(restored.findIndex(visit => visit.id === window.history.state?.agentRemoteVisit));
  const traveling = useRef(false);
  const queued = useRef<number>();
  const restoring = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [, refresh] = useState(0);
  const mounted = useRef(true);
  const identity = current ? sessionKey(current) : undefined;
  const root = current ? sessionRootKey(current, known) : undefined;

  function write(visit: Visit, push: boolean): void {
    try { window.sessionStorage.setItem(storageKey, JSON.stringify(visits.current)); } catch { /* Navigation still works when browser storage is unavailable. */ }
    const state = { ...window.history.state, agentRemoteVisit: visit.id };
    const path = controllerPath({ ...visit.session, hostId: visit.session.hostId ?? 'local' });
    if (push) window.history.pushState(state, '', path);
    else window.history.replaceState(state, '', path);
  }

  useEffect(() => {
    if (!current || !root || traveling.current) return;
    const previous = visits.current[position.current];
    if (previous && sessionKey(previous.session) === identity) {
      previous.session = current;
      previous.root = root;
      write(previous, false);
      return;
    }
    const visit = { id: crypto.randomUUID(), session: current, root };
    visits.current = [...visits.current.slice(0, position.current + 1), visit];
    position.current = visits.current.length - 1;
    write(visit, previous !== undefined);
    refresh(value => value + 1);
  }, [identity, root, current?.agentId, current?.title, current?.parentNativeSessionId]);

  useEffect(() => {
    mounted.current = true;
    async function navigate(): Promise<void> {
      if (traveling.current) return;
      traveling.current = true;
      refresh(value => value + 1);
      while (queued.current !== undefined && mounted.current) {
        const index = queued.current;
        queued.current = undefined;
        const visit = visits.current[index]!;
        let opened = false;
        try { opened = await openRef.current(visit.session); } catch { /* The session opener presents its own failure. */ }
        if (!mounted.current) return;
        if (opened) position.current = index;
        if (queued.current !== undefined) continue;
        if (opened) {
          write(visit, false);
        } else {
          restoring.current = true;
          window.history.go(position.current - index);
        }
      }
      traveling.current = false;
      if (mounted.current) refresh(value => value + 1);
    }
    function pop(event: PopStateEvent): void {
      if (restoring.current) { restoring.current = false; refresh(value => value + 1); return; }
      const index = visits.current.findIndex(visit => visit.id === event.state?.agentRemoteVisit);
      if (index < 0 || (index === position.current && !traveling.current)) return;
      queued.current = index;
      void navigate();
    }
    window.addEventListener('popstate', pop);
    return () => { mounted.current = false; window.removeEventListener('popstate', pop); };
  }, []);

  const index = position.current;
  const canVisit = (target: number) => !traveling.current && !restoring.current && visits.current[target] !== undefined && root !== undefined && sessionRootKey(visits.current[target]!.session, known) === root;
  return {
    canBack: canVisit(index - 1), canForward: canVisit(index + 1),
    back: () => { if (canVisit(position.current - 1)) window.history.back(); },
    forward: () => { if (canVisit(position.current + 1)) window.history.forward(); },
  };
}
