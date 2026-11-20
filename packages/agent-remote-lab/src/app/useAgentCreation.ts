import { errorWords } from '@orchardworks/agent-client';
import { classifyCreationFailure, mayCreate, partialCreationMessage, planningOption, reservationFor } from '../state/agent-creation.js';
import { windowSessionBinding } from '../window-workspace.js';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { DirectoryError } from '../directory-client.js';
import { createAgentId } from './helpers.js';
import type { AppInputs } from './types.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { SharedFeedsAndTpmSlice } from './useSharedFeedsAndTpm.js';
import type { StackSelectionSlice } from './useStackSelection.js';
import type { SessionBindingSlice } from './useSessionBinding.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

// Creating a session from the New session form, or a bot from Bot mode.
export function useAgentCreation(scope: Pick<AppInputs & HostAndStackSlice & ViewSessionStateSlice & SideSelectionSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & WorkbenchRecordsSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice & ViewTargetsSlice & WindowViewActionsSlice & RemoteHostStateSlice & ProviderCreationSlice & ProviderStateSlice & SharedFeedsAndTpmSlice & StackSelectionSlice & SessionBindingSlice, 'attach' | 'closeContext' | 'createPlanning' | 'creationReservation' | 'creationUnavailableReason' | 'directory' | 'directoryDestination' | 'dispatchPanels' | 'navigation' | 'providerConnectionName' | 'providerId' | 'rememberSession' | 'retryHosts' | 'selectedHost' | 'sessionOptions' | 'setCreationLocked' | 'setDirectoryRevision' | 'setFailure' | 'setNewBot' | 'setProviderName' | 'setSessionNotice' | 'setTransitioning' | 'showView' | 'trackedViews' | 'transitionRef' | 'transport' | 'windowWorkspace' | 'rememberTrackedView' | 'bindDirectorySession'>) {
  const t = useTranslate();
  const { attach, closeContext, createPlanning, creationReservation, creationUnavailableReason, directory, directoryDestination, dispatchPanels, navigation, providerConnectionName, providerId, rememberSession, retryHosts, selectedHost, sessionOptions, setCreationLocked, setDirectoryRevision, setFailure, setNewBot, setProviderName, setSessionNotice, setTransitioning, showView, trackedViews, transitionRef, transport, windowWorkspace, rememberTrackedView, bindDirectorySession } = scope;

  /** Creates a session from the New session form or, for `bot`, Bot mode's New bot, which starts a group named after it. */
  async function createAgent(bot = false): Promise<void> {
    if (!mayCreate({ providerId, unavailableReason: creationUnavailableReason, opening: transitionRef.current, bot, hasDirectory: !!directory })) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined); setSessionNotice(undefined);
    if (bot) setNewBot(current => ({ ...current, failure: undefined }));
    const agentId = createAgentId();
    let botSession = false;
    try {
      if (bot && directory) {
        const reservation = reservationFor(creationReservation.current, true, () => ({ operationId: crypto.randomUUID(), providerId: providerId!, bot: true as const, options: { ...sessionOptions } }));
        creationReservation.current = reservation;
        setCreationLocked(true);
        const response = await directory.create(reservation.providerId, reservation.operationId, reservation.options);
        const session = { agentId: response.agentId, nativeSessionId: response.nativeSessionId ?? response.agentId, providerId: reservation.providerId, title: 'New session', hostId: selectedHost.id };
        creationReservation.current = undefined;
        setCreationLocked(false); botSession = true;
        rememberSession(session);
        setDirectoryRevision((current) => current + 1);
        // The session exists now: a group that is not confirmed stays in the roster with Retry.
        setNewBot({ open: false });
        const created = await windowWorkspace.createBotGroup(windowSessionBinding(session));
        navigation.select({ kind: 'bot', groupId: created.groupId, viewId: created.viewId });
        return;
      }
      if (directory) {
        const reservation = reservationFor(creationReservation.current, false, () => ({ operationId: crypto.randomUUID(), providerId: providerId!, destination: directoryDestination(), options: { ...sessionOptions, ...planningOption(createPlanning, providerId!) } }));
        creationReservation.current = reservation;
        setCreationLocked(true);
        const response = await directory.create(reservation.providerId, reservation.operationId, reservation.options);
        const session = { agentId: response.agentId, nativeSessionId: response.nativeSessionId ?? response.agentId, providerId: reservation.providerId, title: 'New session', hostId: selectedHost.id };
        rememberTrackedView(); trackedViews.select();
        closeContext(); showView('workbench');
        rememberSession(session); await bindDirectorySession(session, reservation.destination);
        creationReservation.current = undefined;
        setCreationLocked(false);
        setDirectoryRevision((current) => current + 1);
      } else {
        const response = await transport.createAgent(agentId, providerId, { sessionId: agentId, ...(createPlanning ? { planning: true } : {}) });
        rememberTrackedView(); trackedViews.select();
        attach(response.payload.agentId);
      }
      setProviderName(providerConnectionName(selectedHost.id, providerId));
      dispatchPanels({ type: 'sessionPanel.set', panel: 'list' });
    } catch (error) {
      const outcome = classifyCreationFailure({ code: error instanceof DirectoryError ? error.code : undefined, directoryError: error instanceof DirectoryError, hasDirectory: !!directory,
        reservationHeld: !!creationReservation.current, bot, botSessionCreated: botSession, message: errorWords(error, t, 'sessions.creation.failed') }, t);
      if (outcome.partialNotice) {
        const notice = sessionConnectionFailure(error, false, t);
        setSessionNotice({ ...notice, operation: t('sessions.connection.createSession'), message: partialCreationMessage(notice.message, t) });
      }
      if (outcome.releasesReservation) { creationReservation.current = undefined; setCreationLocked(false); }
      // Before the session exists the sheet shows why; after, the roster shows the group's creation state and its Retry.
      if (outcome.botSheetFailure) setNewBot(current => ({ ...current, failure: outcome.botSheetFailure }));
      if (outcome.failure) setFailure(outcome.failure);
    } finally {
      if (directory && selectedHost.id !== 'local') retryHosts();
      transitionRef.current = false;
      setTransitioning(false);
    }
  }
  return { createAgent };
}

export type AgentCreationSlice = ReturnType<typeof useAgentCreation>;
