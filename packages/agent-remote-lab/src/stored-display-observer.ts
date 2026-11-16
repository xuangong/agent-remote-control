import type { AgentReplica, AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { recoveryGeneration } from './conversation-recovery.js';
import { isStoredSource, pinStoredSession, saveStoredDisplay } from './stored-display.js';

/** A shared session owns what this device stores of it, independently of views and control readiness. */
export function observeStoredDisplay(baseUrl: string, target: ControllerLocation, replica: AgentReplica): () => void {
  const generation = recoveryGeneration(baseUrl);
  const unpin = pinStoredSession(baseUrl, target);
  let latest: AgentReplicaState | undefined, dirty = false, timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer); timer = undefined;
    if (dirty && latest && recoveryGeneration(baseUrl) === generation) {
      dirty = false;
      saveStoredDisplay(baseUrl, target, latest);
    }
  };
  const observe = () => {
    if (recoveryGeneration(baseUrl) !== generation) return;
    const state = replica.getState();
    // Rows that no connection has confirmed yet, and a replacement still waiting for its tail, are not what was last read.
    if (!isStoredSource(target, state) || state.agent === latest?.agent && state.timeline === latest?.timeline) return;
    latest = state; dirty = true;
    timer ??= setTimeout(flush, 2000);
  };
  const hide = () => { if (document.visibilityState === 'hidden') flush(); };
  const stop = replica.subscribe(observe);
  observe();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', flush);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', hide);
  return () => {
    stop(); flush(); clearTimeout(timer); unpin();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', hide);
  };
}
