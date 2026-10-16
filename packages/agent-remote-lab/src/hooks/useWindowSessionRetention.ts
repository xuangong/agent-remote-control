import { useEffect, useMemo } from 'react';
import type { WindowSessionBinding, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { ConversationConnections } from '../conversation-connections.js';
import { sessionKey } from '../session-tree.js';

const RECENT_SESSION_LIMIT = 24;

/** Retains recently presented Sessions independently of their current Window or pane. */
export function useWindowSessionRetention(connections: ConversationConnections, window?: WorkspaceWindow) {
  const retention = useMemo(() => {
    const owner = `window-sessions:${crypto.randomUUID()}`;
    const recent = new Map<string, { target: WindowSessionBinding; windows: Set<string> }>();
    const forgotten = new Set<string>();
    let current: WorkspaceWindow | undefined, active = false, updating = false;
    const publish = () => connections.retainSessions(owner, [...recent.values()].map(entry => entry.target));
    const observe = (touch = false) => {
      if (!active || updating) return;
      updating = true;
      try {
        if (current && !forgotten.has(current.id)) for (const view of current.views) {
          const target = view.binding;
          if (!target || !connections.find(target)) continue;
          const key = sessionKey(target), existing = recent.get(key);
          if (!touch && existing?.windows.has(current.id)) continue;
          const entry = existing ?? { target, windows: new Set<string>() };
          entry.windows.add(current.id);
          recent.delete(key); recent.set(key, entry);
        }
        while (recent.size > RECENT_SESSION_LIMIT) recent.delete(recent.keys().next().value!);
        publish();
      } finally { updating = false; }
    };
    return {
      start() {
        active = true;
        const stop = connections.subscribe(() => observe());
        observe();
        return () => { active = false; stop(); recent.clear(); forgotten.clear(); publish(); };
      },
      setWindow(value?: WorkspaceWindow) { current = value; observe(true); },
      forgetWindow(id: string) {
        forgotten.add(id);
        for (const [key, entry] of recent) {
          entry.windows.delete(id);
          if (!entry.windows.size) recent.delete(key);
        }
        if (active) publish();
      },
    };
  }, [connections]);
  useEffect(() => retention.start(), [retention]);
  useEffect(() => retention.setWindow(window), [retention, window]);
  return useMemo(() => ({ forgetWindow: retention.forgetWindow }), [retention]);
}
