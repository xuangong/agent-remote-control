import type { AgentReplica, AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { recoveryGeneration } from './conversation-recovery.js';
import { isWorkspaceSnapshotSource, saveWorkspaceSnapshot } from './workspace-cache.js';

/** A shared session owns its display persistence, independently of views and control readiness. */
export function observeWorkspaceDisplay(scope: string, target: ControllerLocation, replica: AgentReplica): () => void {
  const generation = recoveryGeneration(scope);
  let latest: AgentReplicaState | undefined, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (dirty && latest && recoveryGeneration(scope) === generation) {
      dirty = false;
      saveWorkspaceSnapshot(scope, target, latest);
    }
  };
  const observe = () => {
    if (recoveryGeneration(scope) !== generation) return;
    const state = replica.getState();
    if (!isWorkspaceSnapshotSource(target, state) || state.agent === latest?.agent && state.timeline === latest?.timeline) return;
    // Incomplete replacement history must not discard the last display that was actually observed.
    latest = state; dirty = true;
    timer ??= setTimeout(flush, 2000);
  };
  const hide = () => { if (document.visibilityState === 'hidden') flush(); };
  const stop = replica.subscribe(observe);
  observe();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hide);
  return () => {
    stop(); flush(); clearTimeout(timer);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hide);
  };
}
