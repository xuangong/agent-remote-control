// Remote Hosts, their offline refusal and the providers they offer.
import { availableProvidersOf, chosenProviderId } from '../features/sessions/creation-choice.js';
import { useEffect, useRef, useState } from 'react';
import { useRemoteHosts } from '../features/computers/useRemoteHosts.js';
import { unavailableSessions } from '../kernel/unavailable-sessions.js';
import { announceHostReturned } from '../kernel/session-restoration.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ProviderStateSlice } from './useProviderState.js';

export function useRemoteHostState(scope: Pick<RequestedSessionSlice & WorkbenchShellSlice & PanelsAndShortcutsSlice & ViewSessionStateSlice & WorkbenchRecordsSlice & ProviderStateSlice, 'accessReady' | 'compactLayout' | 'contextOpen' | 'creationLocked' | 'desktopContextVisible' | 'directory' | 'hostClient' | 'localProviderId' | 'navigation' | 'pageOpen' | 'providers' | 'restoredHostSelection' | 'selectedHost' | 'setCreatePlanning' | 'setSelectedHost' | 'setSessionOptions' | 'status' | 'transitioning' | 'transport'>) {
  const { accessReady, compactLayout, contextOpen, creationLocked, desktopContextVisible, directory, hostClient, localProviderId, navigation, pageOpen, providers, restoredHostSelection, selectedHost, setCreatePlanning, setSelectedHost, setSessionOptions, status, transitioning, transport } = scope;


  const { hosts: remoteHosts, loaded: hostsLoaded, error: hostError, retry: retryHosts } = useRemoteHosts(hostClient, accessReady && directory !== undefined, (compactLayout ? contextOpen : desktopContextVisible || pageOpen) || navigation.page?.destination === 'settings' || status !== 'ready' || creationLocked, selectedHost.id);

  const currentHost = remoteHosts.find((host) => host.id === selectedHost.id);

  /** The Host a send was just refused for as offline; the Host list catches up later and then decides. */
  const [refusedOffline, setRefusedOffline] = useState<string>();

  const hostsOnline = remoteHosts.map(host => host.online).join();

  useEffect(() => setRefusedOffline(undefined), [hostsOnline]);

  // A Host that comes back is asked again for the sessions it reported missing (see unavailableSessions), and the views
  // waiting on it try again at once instead of at their next backed-off retry.
  const offlineHosts = useRef(new Set<string>());

  useEffect(() => {
    for (const host of remoteHosts) {
      if (host.online === false) offlineHosts.current.add(host.id);
      else if (offlineHosts.current.delete(host.id)) { unavailableSessions(transport).forgetHost(host.id); announceHostReturned(host.id); }
    }
  }, [remoteHosts, transport]);

  const availableProviders = availableProvidersOf(selectedHost.id, providers, currentHost);

  const providerId = chosenProviderId(availableProviders, selectedHost.id === 'local' ? localProviderId : selectedHost.providerId);

  useEffect(() => {
    if (!currentHost || !restoredHostSelection.current || creationLocked || transitioning || selectedHost.providerId === providerId) return;
    setSelectedHost((host) => ({ ...host, providerId }));
    setSessionOptions({});
    setCreatePlanning(false);
  }, [currentHost, selectedHost.providerId, providerId, creationLocked, transitioning]);
  return { remoteHosts, hostsLoaded, hostError, retryHosts, currentHost, refusedOffline, setRefusedOffline, availableProviders, providerId };
}

export type RemoteHostStateSlice = ReturnType<typeof useRemoteHostState>;
