import { useCallback, useEffect, useState } from 'react';
import { conversationSessionStorage } from '../conversation-storage.js';
import { sessionKey } from '../session-tree.js';

export interface SessionWindowTarget { hostId: string; providerId: string; nativeSessionId: string; title: string; parentNativeSessionId?: string }
export interface SessionWindowEntry { target: SessionWindowTarget; dockRequest?: string; closeWith?: string; groupId?: string }
export const sessionWindowId = (target: SessionWindowTarget) => `session:${sessionKey(target)}`;
const keyFor = (scope: string) => `agent-remote:recovery:${scope}:session-windows`;
function restore(scope: string): SessionWindowEntry[] {
  try {
    const saved: unknown = JSON.parse(conversationSessionStorage.getItem(keyFor(scope)) ?? '[]');
    if (!Array.isArray(saved)) return [];
    const seen = new Set<string>();
    return saved.flatMap(value => {
      const target = value?.target;
      if (!target || !['hostId', 'providerId', 'nativeSessionId', 'title'].every(key => typeof target[key] === 'string' && target[key])) return [];
      if (target.parentNativeSessionId !== undefined && typeof target.parentNativeSessionId !== 'string') return [];
      const id = sessionWindowId(target); if (seen.has(id)) return []; seen.add(id);
      return [{ target, ...(typeof value.closeWith === 'string' && value.closeWith !== id ? { closeWith: value.closeWith } : {}),
        ...(typeof value.groupId === 'string' && value.groupId ? { groupId: value.groupId } : {}) }];
    }).slice(-20);
  } catch { return []; }
}

/** Session identity and presentation outlive the feature that opened a window. */
export function useSessionWindows(scope: string) {
  const [value, setValue] = useState(() => ({ scope, entries: restore(scope) }));
  const entries = value.scope === scope ? value.entries : [];
  useEffect(() => { setValue(current => current.scope === scope ? current : { scope, entries: restore(scope) }); }, [scope]);
  useEffect(() => {
    if (value.scope !== scope) return;
    try { conversationSessionStorage.setItem(keyFor(scope), JSON.stringify(value.entries.map(({ target, closeWith, groupId }) => ({ target, closeWith, groupId })))); } catch { /* Keep windows usable without persistence. */ }
  }, [scope, value]);
  const open = useCallback((targets: SessionWindowTarget[], groupRoot?: SessionWindowTarget, groupId?: string) => {
    const request = crypto.randomUUID();
    setValue(current => {
      const next = current.scope === scope ? [...current.entries] : restore(scope);
      for (const target of targets) {
        const index = next.findIndex(entry => sessionWindowId(entry.target) === sessionWindowId(target));
        const closeWith = groupRoot && sessionWindowId(groupRoot) !== sessionWindowId(target) ? sessionWindowId(groupRoot) : undefined;
        const entry = { target, dockRequest: request, closeWith, groupId: groupRoot && !closeWith ? groupId : undefined };
        if (index >= 0) next[index] = entry;
        else next.push(entry);
      }
      return { scope, entries: next };
    });
  }, [scope]);
  const gather = useCallback((root: SessionWindowEntry, targets: SessionWindowTarget[]) => {
    const rootId = sessionWindowId(root.target), request = crypto.randomUUID();
    setValue(current => {
      // A late roster response must not resurrect a group the user already closed.
      if (current.scope !== scope || !current.entries.some(entry => sessionWindowId(entry.target) === rootId && entry.groupId === root.groupId)) return current;
      const next = [...current.entries];
      for (const target of targets) {
        if (sessionWindowId(target) === rootId) continue;
        const index = next.findIndex(entry => sessionWindowId(entry.target) === sessionWindowId(target));
        if (index >= 0) next[index] = { ...next[index]!, target, closeWith: rootId };
        else next.push({ target, closeWith: rootId, dockRequest: request });
      }
      return { scope, entries: next };
    });
  }, [scope]);
  const close = useCallback((target: SessionWindowTarget) => setValue(current => current.scope !== scope ? current : {
    scope, entries: current.entries.filter(entry => sessionWindowId(entry.target) !== sessionWindowId(target) && entry.closeWith !== sessionWindowId(target)),
  }), [scope]);
  return { entries, open, close, gather };
}
