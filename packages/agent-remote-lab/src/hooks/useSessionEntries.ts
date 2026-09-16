import { useEffect, useMemo, useState } from 'react';
import type { AgentReplicaState } from '@agent-remote-controller/agent-remote-web';
import type { OpenedSession } from '../directory-client.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';

export function useSessionEntries(opened: readonly OpenedSession[], state?: AgentReplicaState): SessionEntry[] {
  const [observed, setObserved] = useState<{ entries: SessionEntry[]; childTitles: Map<string, string> }>(() => ({ entries: [], childTitles: new Map() }));
  const agent = state?.agent;
  const merged = useMemo(() => {
    const items = new Map(observed.entries.map((item) => [sessionKey(item), item]));
    const childTitles = new Map(observed.childTitles);
    for (const item of opened) {
      const key = sessionKey(item);
      items.set(key, { ...items.get(key), ...item, title: childTitles.get(key) ?? item.title });
    }
    if (agent?.runtimeInfo.sessionId) {
      const saved = [...items.values()].find((item) => item.agentId === agent.id);
      const current: SessionEntry = { ...saved, hostId: saved?.hostId ?? 'local', agentId: agent.id, providerId: agent.providerId,
        nativeSessionId: agent.runtimeInfo.sessionId, title: saved?.title ?? 'Current session', status: agent.status };
      items.set(sessionKey(current), { ...items.get(sessionKey(current)), ...current });
      for (const child of agent.runtimeInfo.childSessions ?? []) {
        const entry: SessionEntry = { ...child, hostId: current.hostId, providerId: current.providerId, parentAgentId: agent.id, parentNativeSessionId: current.nativeSessionId };
        items.set(sessionKey(entry), { ...items.get(sessionKey(entry)), ...entry });
        childTitles.set(sessionKey(entry), child.title);
      }
    }
    return { entries: [...items.values()], childTitles };
  }, [observed, opened, agent]);
  // Cache relationships independently of the active chat subscription and opened views.
  useEffect(() => { setObserved(merged); }, [opened, agent]);
  return merged.entries;
}
