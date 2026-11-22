import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import type { ControllerLocation } from '@orchardworks/agent-remote-protocol/model';
import { loadStoredDisplay, readStoredDisplay, sessionIdentity } from '../kernel/stored-display.js';
import { storedRowsRelay, subscribeStoredRows } from '../kernel/workspace-access.js';

/**
 * The rows this device stored of a conversation, as a display, while the Relay has confirmed this person's lease; none before, and none again once the lease needs
 * confirming. A record the preload left on disk is loaded when asked for.
 */
export function useStoredDisplay(baseUrl: string, target: ControllerLocation | undefined): AgentReplicaState | undefined {
  const relay = useSyncExternalStore(listener => subscribeStoredRows(baseUrl, listener), () => storedRowsRelay(baseUrl));
  const identity = target && sessionIdentity(target);
  const key = relay !== undefined && identity ? JSON.stringify([relay, identity, target.providerId]) : undefined;
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
