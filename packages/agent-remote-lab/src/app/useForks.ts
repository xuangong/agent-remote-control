import { type AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import { sessionKey } from '../session-tree.js';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sideNavigationSource, sideNavigationTarget, sideLinkVisible, referenceForkContext, captureForkContext, type SessionFork } from '../session-forks.js';
import { configureFork, sendForkInput } from '../fork-actions.js';
import { viewKey } from './helpers.js';
import { messageWords } from './message-words.js';
import type { AppInputs } from './types.js';
import { sessionQuotaMessage, sessionQuotaReached } from '../state/agent-creation.js';
import { copiesConversation, firstInputPending, forkCommandRoute, forkCreateOptions, forkedSession, forkKey, forkSettings, needsWorkspaceLookup, selectsSideAfterFork, withForkContext, workspaceOptions } from '../state/fork-plan.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

// Opening a saved fork and creating one from a conversation command.
export function useForks(scope: Pick<AppInputs & WorkbenchShellSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & FocusedAskSlice & HostAndStackSlice & SideSelectionSlice & PanelsAndShortcutsSlice & ViewTargetsSlice & ActiveSessionSlice & SideNavigationSlice & ConversationConnectionsSlice & RequestedSessionSlice & WorkbenchRecordsSlice & ProviderCreationSlice & WindowViewActionsSlice & SessionOpeningSlice & RemoteHostStateSlice & WindowModeActionsSlice, 'ask' | 'askView' | 'assertSourceCurrent' | 'baseUrl' | 'directory' | 'draftBindingFor' | 'forkBusy' | 'forkReservation' | 'forkStore' | 'letterRequest' | 'nextSideRequest' | 'refreshRelations' | 'rememberSession' | 'remoteHosts' | 'retryHosts' | 'selectSide' | 'selectedHost' | 'setDirectoryRevision' | 'setFailure' | 'setForkInputStatus' | 'sideRequestKey' | 'sideRequests' | 'succession' | 'transport' | 'viewSession'>) {
  const t = useTranslate();
  const { ask, askView, assertSourceCurrent, baseUrl, directory, draftBindingFor, forkBusy, forkReservation, forkStore, letterRequest, nextSideRequest, refreshRelations, rememberSession, remoteHosts, retryHosts, selectSide, selectedHost, setDirectoryRevision, setFailure, setForkInputStatus, sideRequestKey, sideRequests, succession, transport, viewSession } = scope;

  async function openFork(record: SessionFork): Promise<void> {
    letterRequest.current?.abort();
    if (!record.target || !directory || !sideLinkVisible(forkStore.get(record.id))) return;
    const saved = sideNavigationTarget(record)!;
    const source = sideNavigationSource(record);
    const request = nextSideRequest(source);
    const target = (saved.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, saved.hostId);
    try {
      const result = await target.attach(saved.providerId, saved.nativeSessionId);
      const session = { ...saved, agentId: result.agentId };
      if (sessionKey(saved) === sessionKey(record.target)) {
        forkStore.bind(record.id, session);
        await configureFork(transport, forkStore, forkStore.get(record.id));
      } else forkStore.followEditedSide(record.id, saved, session);
      rememberSession(session);
      if (sideRequests.current.get(sideRequestKey(source)) === request && sideLinkVisible(forkStore.get(record.id)) && sessionKey(session) !== sessionKey(source)) selectSide(source, session);
    } catch (error) {
      if (sideRequests.current.get(sideRequestKey(source)) === request) setFailure(messageWords(error, t('sessions.forks.openFailed'), t));
    }
  }
  async function createFork(sourceState: AgentReplicaState, saved: OpenedSession | undefined, id: string, args: string): Promise<AgentCommandResult> {
    letterRequest.current?.abort();
    const agent = sourceState.agent;
    if (!directory || !agent?.runtimeInfo.sessionId) throw new Error(t('sessions.forks.cannotFork'));
    const source = viewSession(saved ?? { agentId: agent.id, nativeSessionId: agent.runtimeInfo.sessionId, providerId: agent.providerId, title: 'Conversation', hostId: 'local' });
    assertSourceCurrent(source);
    const associationOwner = succession.ownerFor(viewKey(source));
    const route = forkCommandRoute(id, args);
    if (route === 'ask-setting') return askView.execute(args);
    if (route === 'ask-open') {
      askView.setVisible(true);
      return ask.open(sourceState, source, args, false, { associationOwner, synchronize: async () => { assertSourceCurrent(source); await refreshRelations(); assertSourceCurrent(source); } });
    }
    if (forkBusy.current) throw new Error(t('sessions.forks.inProgress'));
    forkBusy.current = true;
    try {
      const target = (source.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
      const key = forkKey(sessionKey(source), id, args);
      let record = forkReservation.current?.key === key ? forkStore.get(forkReservation.current.record.id) : forkStore.all().find((fork) => fork.creationKey === key);
      if (!record) {
        if (sessionQuotaReached(remoteHosts.find((host) => host.id === source.hostId)?.sessionQuota)) throw new Error(sessionQuotaMessage);
        const context = copiesConversation(id) ? await captureForkContext(transport, source) : referenceForkContext(source);
        const settings = forkSettings(agent.runtimeInfo.settings ?? []);
        const placed = needsWorkspaceLookup(source) ? workspaceOptions(agent.cwd, (await target.workspaces(source.providerId)).workspaces)
          : forkCreateOptions({ cwd: agent.cwd, model: agent.model, capabilities: agent.capabilities, planningActive: agent.runtimeInfo.planning?.active === true }, source.providerId);
        record = forkStore.prepare(context, withForkContext(placed, context.mode, source), settings, key);
        forkReservation.current = { key, record };
      }
      assertSourceCurrent(source);
      let result: { agentId: string; nativeSessionId?: string };
      if (record.target) result = await target.attach(record.target.providerId, record.target.nativeSessionId);
      else {
        try { result = await target.create(source.providerId, record.id, record.options); }
        finally { if (source.hostId && source.hostId !== 'local') retryHosts(); }
      }
      const session = viewSession(forkedSession(source, result, record.capturedAt));
      forkStore.bind(record.id, session);
      assertSourceCurrent(source);
      await configureFork(transport, forkStore, forkStore.get(record.id));
      assertSourceCurrent(source);
      rememberSession(source); rememberSession(session);
      setDirectoryRevision((value) => value + 1);
      const draft = draftBindingFor(session);
      if (args.trim()) draft.store.set(draft.key, args.trim());
      if (selectsSideAfterFork(id, sideLinkVisible(forkStore.get(record.id)))) selectSide(source, session);
      assertSourceCurrent(source);
      if (firstInputPending(args, forkStore.get(record.id).delivery)) {
        setForkInputStatus({ agentId: session.agentId, pending: true });
        try { await sendForkInput(transport, forkStore, forkStore.get(record.id), args.trim()); }
        catch (error) { setForkInputStatus({ agentId: session.agentId, pending: false, error: messageWords(error, t('sessions.forks.firstInputFailed'), t) }); throw error; }
        setForkInputStatus(undefined);
        if (draft.store.get(draft.key) === args.trim()) draft.store.set(draft.key, '');
      }
      forkStore.finishCreation(record.id);
      forkReservation.current = undefined;
      return {};
    } finally { forkBusy.current = false; }
  }
  return { openFork, createFork };
}

export type ForksSlice = ReturnType<typeof useForks>;
