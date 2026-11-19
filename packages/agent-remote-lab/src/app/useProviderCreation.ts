// Provider catalog loading, the creation choice and attaching a session.
import { creationUnavailableReason as creationUnavailableReasonOf, providerChoices, providerConnectionName as providerConnectionNameOf, restoreHostSelection } from '../state/creation-choice.js';
import { mayResume, resumedSession } from '../state/agent-creation.js';
import { type SessionEntry, sessionKey } from '../session-tree.js';
import { remoteSessionState } from '@orchardworks/agent-client';
import { conversationLocalStorage } from '../conversation-storage.js';
import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { useCallback, useEffect, useLayoutEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { createAgentId, rememberedAgent, rememberAgent, message, openedSessionsKey, openedSessionMetadata } from './helpers.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';

export function useProviderCreation(scope: Pick<AppInputs & PanelsAndShortcutsSlice & ViewTargetsSlice & RequestedSessionSlice & ViewSessionStateSlice & WorkbenchRecordsSlice & RemoteHostStateSlice & ProviderStateSlice & ConversationConnectionsSlice & WorkbenchShellSlice & SessionSuccessionBindingSlice, 'accessReadyRef' | 'activated' | 'activeView' | 'availableProviders' | 'baseUrl' | 'beginCatchUp' | 'clientRef' | 'closeContext' | 'closeInspector' | 'closePage' | 'compactLayout' | 'compactLayoutRef' | 'connectionSummaryRef' | 'contextOpen' | 'creationReservation' | 'directory' | 'dispatchPanels' | 'focusTimelineAfterAttachRef' | 'hostError' | 'hostsLoaded' | 'initialState' | 'inspectorOpen' | 'mountedTransport' | 'navigationGeneration' | 'openedSessions' | 'openedSessionsRef' | 'pageFocusReturn' | 'pageOpen' | 'pendingViewRestore' | 'providerId' | 'providerRequestGenerationRef' | 'providers' | 'remoteHosts' | 'replicaFor' | 'requested' | 'requestedHostId' | 'restoredHostSelection' | 'selectedHost' | 'setAttachingAgentId' | 'setCatalogError' | 'setCatalogStatus' | 'setDetachedSideRoot' | 'setFailure' | 'setLocalProviderId' | 'setOpenedSessions' | 'setProviderName' | 'setProviders' | 'setSelectedHost' | 'setSessionNotice' | 'setSessionState' | 'setState' | 'setTransitioning' | 'setUncertainMutation' | 'sharedWindow' | 'showView' | 'state' | 'succession' | 'traceTabRef' | 'transitionRef' | 'transport' | 'unsubscribeReplicaRef' | 'windowMode' | 'windowSession' | 'workbenchPanelRef' | 'workbenchTabRef'>, late: AppLate) {
  const { accessReadyRef, activated, activeView, availableProviders, baseUrl, beginCatchUp, clientRef, closeContext, closeInspector, closePage, compactLayout, compactLayoutRef, connectionSummaryRef, contextOpen, creationReservation, directory, dispatchPanels, focusTimelineAfterAttachRef, hostError, hostsLoaded, initialState, inspectorOpen, mountedTransport, navigationGeneration, openedSessions, openedSessionsRef, pageFocusReturn, pageOpen, pendingViewRestore, providerId, providerRequestGenerationRef, providers, remoteHosts, replicaFor, requested, requestedHostId, restoredHostSelection, selectedHost, setAttachingAgentId, setCatalogError, setCatalogStatus, setDetachedSideRoot, setFailure, setLocalProviderId, setOpenedSessions, setProviderName, setProviders, setSelectedHost, setSessionNotice, setSessionState, setState, setTransitioning, setUncertainMutation, sharedWindow, showView, state, succession, traceTabRef, transitionRef, transport, unsubscribeReplicaRef, windowMode, windowSession, workbenchPanelRef, workbenchTabRef } = scope;

  // Focus inside the page would fall to the document once the page hides; it returns to the Window instead.
  useLayoutEffect(() => {
    if (pageOpen || !pageFocusReturn.current) return;
    pageFocusReturn.current = false;
    if (document.activeElement === document.body || document.activeElement?.closest('#lab-sessions-page')) workbenchPanelRef.current?.focus({ preventScroll: true });
  }, [pageOpen]);


  useEffect(() => {
    if (restoredHostSelection.current) return;
    const activeId = state?.agent?.id ?? rememberedAgent();
    const saved = requestedHostId ? undefined : openedSessions.find((item) => item.agentId === activeId && item.hostId && item.hostId !== 'local');
    const restoration = restoreHostSelection({ requested: { hostId: requestedHostId, providerId: requested.target?.providerId }, hosts: remoteHosts,
      remembered: saved?.hostId ? { hostId: saved.hostId, providerId: saved.providerId } : undefined });
    if (restoration.type === 'wait') return;
    restoredHostSelection.current = true;
    if (restoration.type === 'select') { setSelectedHost({ ...restoration.host, providerId: restoration.providerId }); setProviderName(restoration.providerName); }
  }, [openedSessions, remoteHosts, requestedHostId, state?.agent?.id]);


  const loadProviders = useCallback(async (): Promise<void> => {
    const generation = providerRequestGenerationRef.current + 1;
    providerRequestGenerationRef.current = generation;
    setCatalogStatus('loading');
    setCatalogError(undefined);
    try {
      const available = await transport.listProviders();
      if (providerRequestGenerationRef.current !== generation) return;
      setProviders(available);
      setLocalProviderId((selected) => available.some((provider) => provider.providerId === selected)
        ? selected
        : (available[0]?.providerId ?? ''));
      setCatalogStatus(available.length > 0 ? 'ready' : 'empty');
    } catch (error) {
      if (providerRequestGenerationRef.current !== generation) return;
      setCatalogStatus('error');
      setCatalogError(message(error, 'Provider list could not be loaded.'));
    }
  }, [transport]);


  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const summary = connectionSummaryRef.current;
      if (summary?.open && event.target instanceof Node && !summary.contains(event.target)) summary.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);


  const providerChoiceList = providerChoices(selectedHost.id, availableProviders);

  const selectedProviderChoice = providerChoiceList.find((choice) => choice.hostId === selectedHost.id && choice.providerId === providerId);

  const creationFacts = { selectedHostId: selectedHost.id, requestedHostId, hosts: remoteHosts, hostsLoaded, hostError: !!hostError,
    hostSelectionRestored: restoredHostSelection.current, providerId, reserved: !!creationReservation.current };

  const creationUnavailableReason = creationUnavailableReasonOf(creationFacts);


  const providerConnectionName = (hostId: string, selectedProviderId: string) => providerConnectionNameOf(hostId, selectedProviderId, providers, remoteHosts);


  const attach = useCallback((agentId: string, catchUpTarget?: TimelineCursor, restoreLayout = false): void => {
    if (!accessReadyRef.current) return;
    pendingViewRestore.current = undefined;
    setDetachedSideRoot(undefined);
    succession.leave(); setState(undefined); setSessionState(remoteSessionState(undefined, 'connecting'));
    const generation = ++navigationGeneration.current;
    showView('workbench');
    closeContext();
    if (compactLayoutRef.current) { closeInspector(); queueMicrotask(() => workbenchPanelRef.current?.focus()); }
    setSessionNotice(undefined); setUncertainMutation(false); setAttachingAgentId(agentId);
    void transport.fetchSnapshot(agentId).then(async snapshot => {
      if (!accessReadyRef.current || mountedTransport.current !== transport || navigationGeneration.current !== generation) return;
      const agent = snapshot.payload, nativeSessionId = agent.runtimeInfo.sessionId;
      if (agent.id !== agentId || !nativeSessionId || agent.providerId !== agent.runtimeInfo.providerId) throw new Error('The native session identity could not be confirmed.');
      const known = openedSessionsRef.current.find(session => session.agentId === agentId);
      const session = { ...known, agentId, providerId: agent.providerId, nativeSessionId, hostId: known?.hostId ?? 'local', title: known?.title ?? 'Conversation' };
      beginCatchUp(replicaFor(agentId), catchUpTarget);
      await windowSession.openAttached(session, restoreLayout);
      if (windowMode) rememberAgent(agentId);
    }).catch(error => { if (navigationGeneration.current === generation) { setAttachingAgentId(undefined); setSessionNotice(sessionConnectionFailure(error, false)); } });
  }, [baseUrl, transport, replicaFor, beginCatchUp]);


  useEffect(() => {
    if (initialState || !activated) return;
    void loadProviders();
  }, [initialState, loadProviders, activated]);


  useEffect(() => () => {
    providerRequestGenerationRef.current += 1;
    navigationGeneration.current += 1;
    unsubscribeReplicaRef.current?.();
    unsubscribeReplicaRef.current = undefined;
    clientRef.current = undefined;
  }, []);


  useEffect(() => {
    if (!windowMode || initialState || !activated || requested.target?.nativeSessionId || requested.error || sharedWindow || new URL(location.href).searchParams.has('window')) return;
    const remembered = rememberedAgent(), saved = openedSessionsRef.current.find(item => item.agentId === remembered);
    if (saved && directory && (!requestedHostId || (saved.hostId ?? 'local') === requestedHostId)) void succession.restore(saved);
    else if (!requestedHostId && remembered) attach(remembered, undefined, true);
  }, [attach, baseUrl, initialState, requestedHostId, activated]);


  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1180px)');
    const update = (event: MediaQueryListEvent) => {
      compactLayoutRef.current = event.matches;
      dispatchPanels({ type: 'compact.changed', compact: event.matches });
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    if (typeof media.addListener === 'function') {
      media.addListener(update);
      return () => media.removeListener(update);
    }
  }, []);


  useEffect(() => {
    if (!windowMode || !compactLayout || contextOpen || inspectorOpen || !focusTimelineAfterAttachRef.current) return;
    focusTimelineAfterAttachRef.current = false;
    workbenchPanelRef.current?.focus();
  }, [activeView, compactLayout, contextOpen, inspectorOpen]);


  useEffect(() => {
    if (!directory) return;
    try { conversationLocalStorage.setItem(openedSessionsKey(baseUrl), JSON.stringify(openedSessions)); } catch { /* Storage may be unavailable in private browser contexts. */ }
  }, [baseUrl, directory, openedSessions]);


  function rememberSession(value: OpenedSession): void {
    const item = openedSessionMetadata(value);
    const next = [item, ...openedSessionsRef.current.filter((entry) => !((entry.hostId ?? 'local') === (item.hostId ?? 'local') && entry.providerId === item.providerId && entry.nativeSessionId === item.nativeSessionId) && entry.agentId !== item.agentId)];
    openedSessionsRef.current = next;
    setOpenedSessions(next);
  }

  const trackEntryId = (item: SessionEntry) => 'entryId' in item && typeof item.entryId === 'string' ? item.entryId : sessionKey(item);


  async function resumeAgent(): Promise<void> {
    const persistence = state?.agent?.persistence;
    const session = openedSessions.find((item) => item.agentId === state?.agent?.id);
    if (!persistence || !mayResume({ hasPersistence: true, isChild: !!(session?.parentAgentId || session?.parentNativeSessionId), opening: transitionRef.current })) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined); setSessionNotice(undefined);
    const generation = navigationGeneration.current;
    try {
      if (directory) {
        closeContext(); showView('workbench');
        const hostId = session?.hostId ?? 'local';
        const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
        const response = await target.attach(persistence.providerId, persistence.sessionId);
        if (navigationGeneration.current !== generation) return;
        const resumed = resumedSession(session, persistence, response);
        rememberSession(resumed); await windowSession.openAttached(resumed);
      } else {
        const response = await transport.resumeAgent(createAgentId(), persistence);
        if (navigationGeneration.current !== generation) return;
        attach(response.payload.agentId);
      }
    } catch (error) {
      if (navigationGeneration.current === generation) setFailure(message(error, 'Agent could not be resumed.'));
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  }


  function handleViewKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    let next: 'workbench' | 'trace' | undefined;
    if (event.key === 'Home') next = 'workbench';
    else if (event.key === 'End') next = 'trace';
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = activeView === 'workbench' ? 'trace' : 'workbench';
    }
    if (!next) return;
    event.preventDefault();
    showView(next);
    if (next === 'trace') closePage();
    (next === 'workbench' ? workbenchTabRef : traceTabRef).current?.focus();
  }
  late.rememberSession = rememberSession;
  late.providerConnectionName = providerConnectionName;
  return { loadProviders, providerChoiceList, selectedProviderChoice, creationFacts, creationUnavailableReason, providerConnectionName, attach, rememberSession, trackEntryId, resumeAgent, handleViewKeyDown };
}

export type ProviderCreationSlice = ReturnType<typeof useProviderCreation>;
