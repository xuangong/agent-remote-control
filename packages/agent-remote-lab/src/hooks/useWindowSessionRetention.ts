import { useEffect, useMemo } from 'react';
import type { WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { ConversationConnections } from '../conversation-connections.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';

type Identity = Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>;
const RECENT_SESSION_LIMIT = 24;

/**
 * Retains open conversations by when they were last shown. Each Window's conversations form one unit, and a
 * conversation shown outside its Window's panes (such as one opened from Track and later replaced) is a unit
 * of its own. The most recently shown units are kept whole up to the limit; the current Window is always kept.
 */
export function useWindowSessionRetention(connections: ConversationConnections, window?: WorkspaceWindow, limit = RECENT_SESSION_LIMIT) {
  const retention = useMemo(() => {
    const owner = `window-sessions:${crypto.randomUUID()}`;
    const windows = new Map<string, { sessions: Map<string, Identity>; shownAt: number }>();
    const loose = new Map<string, { target: Identity; shownAt: number }>();
    const forgotten = new Set<string>();
    let shown = new Map<string, Identity>();
    let current: WorkspaceWindow | undefined, active = false, updating = false;
    // Only the order matters, and several changes can happen within one millisecond.
    let clock = 0;
    const publish = () => {
      // Conversations that closed no longer take a place.
      const open = (targets: Identity[]) => targets.filter(target => connections.find(target));
      const units = [
        ...[...windows].map(([id, unit]) => ({ shownAt: id === current?.id ? Infinity : unit.shownAt, targets: open([...unit.sessions.values()]) })),
        ...[...loose.values()].map(entry => ({ shownAt: entry.shownAt, targets: open([entry.target]) })),
      ].sort((a, b) => b.shownAt - a.shownAt);
      const retained = new Map<string, Identity>();
      for (const unit of units) {
        const next = unit.targets.filter(target => !retained.has(sessionKey(target)));
        if (unit.shownAt !== Infinity && retained.size + next.length > limit) break;
        for (const target of next) retained.set(sessionKey(target), target);
      }
      connections.retainSessions(owner, [...retained.values()]);
    };
    const observe = () => {
      if (!active || updating) return;
      updating = true;
      try {
        const now = ++clock;
        const stale = !!current && forgotten.has(current.id);
        if (current && !stale) {
          const sessions = new Map<string, Identity>();
          for (const view of current.views) {
            const target = view.binding;
            if (target && connections.find(target)) sessions.set(sessionKey(target), target);
          }
          const previous = windows.get(current.id);
          // A conversation that left the current Window keeps its own place in the order.
          for (const [key, target] of previous?.sessions ?? []) if (!sessions.has(key)) loose.set(key, { target, shownAt: now });
          windows.set(current.id, { sessions, shownAt: previous?.shownAt ?? now });
        }
        const inWindows = new Set([...windows.values()].flatMap(unit => [...unit.sessions.keys()]));
        const showing = new Map(connections.shownSessions().map(target => [sessionKey(target), target]));
        // So does one no longer shown outside any Window, for example without a Window workspace.
        if (!stale) for (const [key, target] of shown) if (!showing.has(key) && !inWindows.has(key)) loose.set(key, { target, shownAt: now });
        shown = showing;
        for (const key of [...inWindows, ...showing.keys()]) loose.delete(key);
        publish();
      } finally { updating = false; }
    };
    return {
      start() {
        active = true;
        const stop = connections.subscribe(observe);
        observe();
        return () => { active = false; stop(); windows.clear(); loose.clear(); forgotten.clear(); shown = new Map(); publish(); };
      },
      setWindow(value?: WorkspaceWindow) {
        const previous = current && windows.get(current.id);
        if (previous && current?.id !== value?.id) previous.shownAt = ++clock;
        current = value;
        observe();
      },
      forgetWindow(id: string) {
        forgotten.add(id);
        windows.delete(id);
        if (active) publish();
      },
    };
  }, [connections, limit]);
  useEffect(() => retention.start(), [retention]);
  useEffect(() => retention.setWindow(window), [retention, window]);
  return useMemo(() => ({ forgetWindow: retention.forgetWindow }), [retention]);
}
