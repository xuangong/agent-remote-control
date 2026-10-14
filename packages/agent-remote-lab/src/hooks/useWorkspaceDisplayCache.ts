import { useEffect, useMemo } from 'react';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { SessionEntry } from '../session-tree.js';
import { recoveryGeneration } from '../conversation-recovery.js';
import { saveWorkspaceSnapshot } from '../workspace-cache.js';

type Target = Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>;
/** Coalesce display-only snapshots; native authorization and outboxes stay outside this cache. */
export function useWorkspaceDisplayCache(scope: string, target: Target | undefined, state: AgentReplicaState | undefined, allowed: boolean) {
  const key = JSON.stringify([target?.hostId, target?.providerId, target?.nativeSessionId]);
  const cache = useMemo(() => ({ target, state, allowed, mark: () => {} }), [scope, key]);
  cache.target = target; cache.state = state; cache.allowed = allowed;
  useEffect(() => {
    let dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
    const generation = recoveryGeneration(scope);
    const save = () => {
      clearTimeout(timer); timer = undefined;
      if (dirty && cache.allowed && cache.target && cache.state && recoveryGeneration(scope) === generation) {
        dirty = false; saveWorkspaceSnapshot(scope, cache.target, cache.state);
      }
    };
    const hide = () => { if (document.visibilityState === 'hidden') save(); };
    cache.mark = () => { dirty = true; timer ??= setTimeout(save, 2000); }; cache.mark();
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', hide);
    return () => { save(); clearTimeout(timer); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', hide); };
  }, [scope, cache]);
  useEffect(() => cache.mark(), [cache, state, allowed]);
}
