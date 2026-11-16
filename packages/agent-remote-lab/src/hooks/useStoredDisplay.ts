import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { loadStoredDisplay, readStoredDisplay, sessionIdentity } from '../stored-display.js';
import { storedRowsScope, subscribeStoredRows } from '../workspace-access.js';

/**
 * The rows this device stored of a conversation, as a display, while the Relay has confirmed this person's lease; none before, and none again once the lease needs
 * confirming. A record the preload left on disk is loaded when asked for.
 */
export function useStoredDisplay(baseUrl: string, target: ControllerLocation | undefined): AgentReplicaState | undefined {
  const principal = useSyncExternalStore(listener => subscribeStoredRows(baseUrl, listener), () => storedRowsScope(baseUrl)?.principalId);
  const identity = target && sessionIdentity(target);
  const key = principal !== undefined && identity ? JSON.stringify([baseUrl, principal, identity, target.providerId]) : undefined;
  const memory = useMemo(() => key ? readStoredDisplay(baseUrl, target) : undefined, [key]);
  const [loaded, setLoaded] = useState<{ key: string; state: AgentReplicaState | undefined }>();
  useEffect(() => {
    if (!key || memory || !target) return;
    let stale = false;
    void loadStoredDisplay(baseUrl, target).then(() => { if (!stale) setLoaded({ key, state: readStoredDisplay(baseUrl, target) }); });
    return () => { stale = true; };
  }, [key, memory]);
  return key ? memory ?? (loaded?.key === key ? loaded.state : undefined) : undefined;
}
