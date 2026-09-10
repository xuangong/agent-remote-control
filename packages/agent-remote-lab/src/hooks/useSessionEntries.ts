import { useEffect, useMemo, useState } from 'react';
import type { AgentReplicaState } from '@borgee/agent-remote-web';
import type { OpenedSession } from '../directory-client.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';

export function useSessionEntries(opened: readonly OpenedSession[], state?: AgentReplicaState): SessionEntry[] {
  const [observed, setObserved] = useState<SessionEntry[]>([]);
  const agent = state?.agent;
  const entries = useMemo(() => {
    const items = new Map(observed.map((item) => [sessionKey(item), item]));
    for (const item of opened) items.set(sessionKey(item), { ...items.get(sessionKey(item)), ...item });
    if (agent?.runtimeInfo.sessionId) {
      const saved = opened.find((item) => item.agentId === agent.id) ?? observed.find((item) => item.agentId === agent.id);
      const current: SessionEntry = { ...saved, hostId: saved?.hostId ?? 'local', agentId: agent.id, providerId: agent.providerId,
        nativeSessionId: agent.runtimeInfo.sessionId, title: saved?.title ?? 'Current session', status: agent.status };
      items.set(sessionKey(current), { ...items.get(sessionKey(current)), ...current });
      for (const child of agent.runtimeInfo.childSessions ?? []) {
        const entry: SessionEntry = { ...child, hostId: current.hostId, providerId: current.providerId, parentAgentId: agent.id, parentNativeSessionId: current.nativeSessionId };
        items.set(sessionKey(entry), { ...items.get(sessionKey(entry)), ...entry });
      }
    }
    return [...items.values()];
  }, [observed, opened, agent]);
  // Cache relationships independently of the active chat subscription and opened views.
  useEffect(() => { setObserved(entries); }, [opened, agent]);
  return entries;
}
