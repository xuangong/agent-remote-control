import { isConversationLayout, type ConversationLayout } from '../conversation-layout.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import { useEffect, useRef, useState } from 'react';
import { controllerPath } from '@orchardworks/agent-remote-hosted/controller-location';
import { sessionKey, sessionRootKey, type SessionEntry } from '../session-tree.js';

interface Visit { id: string; session: SessionEntry; root: string; sessionIntent?: 'history'; keepOriginal?: boolean; scope?: string; layout?: ConversationLayout; layoutUpdated?: number }
const storageKey = 'agent-remote-conversation-history';
function restoreVisits(scope?: string): Visit[] {
  try {
    const visits: Visit[] = JSON.parse(conversationSessionStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(visits) || !visits.some(visit => visit.id === window.history.state?.agentRemoteVisit)) return [];
    for (const visit of visits) {
      if (typeof visit.id !== 'string' || typeof visit.root !== 'string' || typeof visit.session?.title !== 'string' || typeof visit.session?.nativeSessionId !== 'string' || typeof visit.session?.providerId !== 'string') return [];
      if (visit.sessionIntent !== undefined && visit.sessionIntent !== 'history' || visit.keepOriginal !== undefined && typeof visit.keepOriginal !== 'boolean') return [];
      controllerPath({ ...visit.session, hostId: visit.session.hostId ?? 'local', sessionIntent: visit.sessionIntent, keepOriginal: visit.keepOriginal });
    }
    return visits.filter(visit => visit.scope === scope).map(visit => ({ ...visit, layout: isConversationLayout(visit.layout) ? visit.layout : undefined }));
  } catch { return []; }
}

export function readCurrentConversationLayout(scope: string): ConversationLayout | undefined {
  const visit = restoreVisits(scope).find(visit => visit.id === window.history.state?.agentRemoteVisit);
  if (!visit) return;
  const expected = controllerPath({ ...visit.session, hostId: visit.session.hostId ?? 'local', sessionIntent: visit.sessionIntent, keepOriginal: visit.keepOriginal });
  return `${window.location.pathname}${window.location.search}` === expected ? visit.layout : undefined;
}

export function useConversationHistory(current: SessionEntry | undefined, known: readonly SessionEntry[], open: (session: SessionEntry, sessionIntent?: 'history', keepOriginal?: boolean, layout?: ConversationLayout) => Promise<boolean>, sessionIntent?: 'history', keepOriginal?: boolean,
  presentation?: { scope: string; layout?: ConversationLayout }) {
  const [restored] = useState(() => restoreVisits(presentation?.scope));
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

  function persist(): void {
    const retained = new Set(visits.current.filter(visit => visit.layout).sort((a, b) => (b.layoutUpdated ?? 0) - (a.layoutUpdated ?? 0)).slice(0, 10).map(visit => visit.id));
    for (const visit of visits.current) if (!retained.has(visit.id)) { delete visit.layout; delete visit.layoutUpdated; }
    try { conversationSessionStorage.setItem(storageKey, JSON.stringify(visits.current)); } catch { /* Navigation remains available without storage. */ }
  }
  function rememberLayout(visit: Visit): void {
    if (!presentation?.layout || sessionIntent === 'history') return;
    if (JSON.stringify(visit.layout) === JSON.stringify(presentation.layout)) return;
    visit.layout = structuredClone(presentation.layout);
    visit.layoutUpdated = Math.max(Date.now(), ...visits.current.map(visit => (visit.layoutUpdated ?? 0) + 1));
    persist();
  }
  function write(visit: Visit, push: boolean): void {
    persist();
    const state = { ...window.history.state, agentRemoteVisit: visit.id };
    const path = controllerPath({ ...visit.session, hostId: visit.session.hostId ?? 'local', sessionIntent: visit.sessionIntent, keepOriginal: visit.keepOriginal });
    if (push) window.history.pushState(state, '', path);
    else window.history.replaceState(state, '', path);
  }

  useEffect(() => {
    if (!current || !root || traveling.current) return;
    const previous = visits.current[position.current];
    if (previous && sessionKey(previous.session) === identity && previous.sessionIntent === sessionIntent && !!previous.keepOriginal === !!keepOriginal) {
      previous.session = current;
      previous.root = root;
      write(previous, false);
      return;
    }
    const visit: Visit = { id: crypto.randomUUID(), session: current, root, sessionIntent, keepOriginal, scope: presentation?.scope };
    visits.current = [...visits.current.slice(0, position.current + 1), visit];
    visits.current = visits.current.slice(-100);
    position.current = visits.current.length - 1;
    write(visit, previous !== undefined);
    refresh(value => value + 1);
  }, [identity, root, sessionIntent, keepOriginal, current?.agentId, current?.title, current?.parentNativeSessionId]);

  useEffect(() => {
    if (traveling.current || !current) return;
    const visit = visits.current[position.current];
    if (visit && sessionKey(visit.session) === identity && visit.sessionIntent === sessionIntent) rememberLayout(visit);
  });

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
        try { opened = await openRef.current(visit.session, visit.sessionIntent, visit.keepOriginal, visit.layout); } catch { /* The session opener presents its own failure. */ }
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
      if (index < 0) { if (event.state?.agentRemoteVisit) window.location.reload(); return; }
      if (index === position.current && !traveling.current) return;
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
