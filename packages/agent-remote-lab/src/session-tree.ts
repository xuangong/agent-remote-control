import type { AgentChildSession } from '@borgee/agent-remote-protocol';
import type { OpenedSession } from './directory-client.js';

export interface SessionEntry {
  hostId?: string;
  providerId: string;
  nativeSessionId: string;
  title: string;
  agentId?: string;
  parentNativeSessionId?: string;
  parentAgentId?: string;
  createdAt?: string;
  status?: AgentChildSession['status'];
  observation?: AgentChildSession['observation'];
  role?: string;
}
export interface SessionNode { key: string; session: SessionEntry; children: SessionNode[]; placeholder?: boolean }
export function sessionKey(item: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>): string {
  return JSON.stringify([item.hostId ?? 'local', item.providerId, item.nativeSessionId]);
}

/** Retain native identity when a parent view is closed or its catalog page is absent. */
export function sessionForest(entries: readonly SessionEntry[], known: readonly SessionEntry[] = []): SessionNode[] {
  const nodes = new Map<string, SessionNode>();
  const knowledge = new Map(known.map((item) => [sessionKey(item), item]));
  for (const item of entries) nodes.set(sessionKey(item), { key: sessionKey(item), session: item, children: [] });
  for (const node of nodes.values()) {
    const item = node.session;
    if (!item.parentNativeSessionId) continue;
    const parent = { hostId: item.hostId, providerId: item.providerId, nativeSessionId: item.parentNativeSessionId };
    const key = sessionKey(parent);
    if (!nodes.has(key)) nodes.set(key, { key, session: knowledge.get(key) ?? { ...parent, title: 'Parent session' }, children: [], placeholder: true });
  }
  const roots: SessionNode[] = [];
  for (const node of nodes.values()) {
    let ancestor = node;
    const visited = new Set([node.key]);
    let cyclic = false;
    while (ancestor.session.parentNativeSessionId) {
      const key = sessionKey({ ...ancestor.session, nativeSessionId: ancestor.session.parentNativeSessionId });
      if (visited.has(key)) { cyclic = true; break; }
      visited.add(key);
      const next = nodes.get(key);
      if (!next) break;
      ancestor = next;
    }
    const parent = node.session.parentNativeSessionId ? nodes.get(sessionKey({ ...node.session, nativeSessionId: node.session.parentNativeSessionId })) : undefined;
    if (parent && !cyclic) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort((a, b) => (a.session.createdAt ?? '').localeCompare(b.session.createdAt ?? ''));
  return roots;
}
export function openedEntry(item: OpenedSession, known: readonly SessionEntry[]): SessionEntry {
  return { ...known.find((entry) => sessionKey(entry) === sessionKey(item)), ...item };
}
export function sessionStatusLabel(item: SessionEntry): string {
  if (item.observation === 'saved_history') return 'Saved history';
  return item.status === 'running' ? 'Working' : item.status === 'waiting' ? 'Waiting' : item.status === 'closed' ? 'Closed' : item.status === 'failed' ? 'Failed' : item.status === 'starting' ? 'Starting' : item.status === 'idle' ? 'Idle' : '';
}
