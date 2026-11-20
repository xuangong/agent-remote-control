// Sending, the succession dialog and its progress.
import { nativeSessionRefKey, type AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import { labSessionSuccessionDirectory, type SessionSuccessionDirectory } from '../session-succession-directory.js';
import type { SessionViewNavigation } from '../session-view-navigation.js';
import { SessionHandoffRejectedError, RemoteOperationError, RemoteSessionClient } from '@orchardworks/agent-client';
import { SessionControlNotice } from '../components/SessionControlNotice.js';
import { loadSuccessionIntent, saveSuccessionIntent, clearSuccessionIntent, type SessionSuccessionIntent } from '../session-succession-intent.js';
import { SessionSuccessionDialog } from '../components/SessionSuccessionDialog.js';
import { useSuccessionContext } from '../hooks/useSuccessionContext.js';
import { handoffCommand, handoffProvider } from '../handoff-command.js';
import type { ScannedSession } from '../session-transfer.js';
import { useCallback, useState } from 'react';
import { compositionRoleKey } from '../session-composition.js';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { forkActions } from '../fork-actions.js';
import { canHandoffPrimary as canHandoffPrimaryOf, commandRefusal, conversationActionsAvailable, handoffCompletionMatches, handoffInputBlocker, primaryHandoffGated, successionAccessible } from '../state/succession-gates.js';
import { message, viewKey } from './helpers.js';
import type { AppActions } from './types.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { TraceNavigationSlice } from './useTraceNavigation.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { CommunicationsAndForksSlice } from './useCommunicationsAndForks.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { AppInputs } from './types.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function useSendingAndSuccession(scope: Pick<AppInputs & ConversationConnectionsSlice & WorkbenchShellSlice & SessionSuccessionBindingSlice & HostAndStackSlice & RequestedSessionSlice & ViewSessionStateSlice & SideNavigationSlice & WorkbenchRecordsSlice & TraceNavigationSlice & RemoteHostStateSlice & SessionOpeningSlice & FocusedAskSlice & CommunicationsAndForksSlice & ActiveSessionSlice, 'accessReady' | 'accessReadyRef' | 'actions' | 'activeAgentId' | 'activeOpened' | 'activeRemoteSession' | 'assertSourceCurrent' | 'baseUrl' | 'boundFork' | 'clientRef' | 'createFork' | 'currentGroupBinding' | 'detachedSideRoot' | 'directory' | 'fixtureAction' | 'forkStore' | 'hostOffline' | 'nativeTakeover' | 'navigationIntent' | 'openSession' | 'openingHandoff' | 'primaryIsBound' | 'remoteHosts' | 'runMutation' | 'selectedHost' | 'sessionEntries' | 'sessionState' | 'setNativeTakeover' | 'setRefusedOffline' | 'stackRoot' | 'state' | 'status' | 'succession' | 'transitionRef' | 'transitioning' | 'transport' | 'userScoped' | 'viewNavigation'>) {
  const t = useTranslate();
  const { accessReady, accessReadyRef, actions, activeAgentId, activeOpened, activeRemoteSession, assertSourceCurrent, baseUrl, boundFork, clientRef, createFork, currentGroupBinding, detachedSideRoot, directory, fixtureAction, forkStore, hostOffline, nativeTakeover, navigationIntent, openSession, openingHandoff, primaryIsBound, remoteHosts, runMutation, selectedHost, sessionEntries, sessionState, setNativeTakeover, setRefusedOffline, stackRoot, state, status, succession, transitionRef, transitioning, transport, userScoped, viewNavigation } = scope;


  const submittedClient = clientRef.current;

  function commandClient(): RemoteSessionClient {
    const refusal = commandRefusal({ accessReady: accessReadyRef.current, successionActive: succession.active, nativeConfirmed: !succession.active || succession.isCurrent(),
      clientIsSubmitted: !!submittedClient && clientRef.current === submittedClient });
    if (refusal === 'access-restoring') throw new Error(t('sessions.relations.accessRestoring'));
    if (refusal === 'native-unconfirmed') throw new Error(t('sessions.sending.nativeUnconfirmed'));
    if (refusal || !submittedClient) throw new RemoteOperationError('session_changed', t('sessions.sending.conversationChanged'), true);
    return submittedClient;
  }


  const [successionDialog, setSuccessionDialog] = useState<{ scope: string; source: OpenedSession; directory: SessionSuccessionDirectory; resume?: SessionSuccessionIntent['operation']; cancelRequested?: boolean; visible?: boolean; initialProvider?: string } | undefined>(() => {
    const saved = loadSuccessionIntent(baseUrl);
    return saved ? { scope: baseUrl, source: saved.source, resume: saved.operation, cancelRequested: saved.cancelRequested, visible: true, directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, saved.source.hostId)) } : undefined;
  });

  const primaryInputKey = JSON.stringify([baseUrl, stackRoot && sessionKey(stackRoot)]);

  const [pendingPrimaryInput, setPendingPrimaryInput] = useState<{ key: string; count: number }>();

  const [pendingGroupInputs, setPendingGroupInputs] = useState<Record<string, number>>({});

  const reportPendingPrimaryInput = useCallback((count: number) => setPendingPrimaryInput(current =>
    current?.key === primaryInputKey && current.count === count ? current : { key: primaryInputKey, count }), [primaryInputKey]);

  const pendingPrimaryCount = pendingPrimaryInput?.key === primaryInputKey ? pendingPrimaryInput.count : 0;

  const sourceIsGroupView = !!successionDialog && !!succession.document.windowBindings?.some(entry => entry.slotId === viewKey(successionDialog.source));

  const successionInputReason = handoffInputBlocker({ dialogOpen: !!successionDialog, sourceIsGroupView,
    groupPending: sourceIsGroupView && successionDialog ? pendingGroupInputs[viewKey(successionDialog.source)] ?? 0 : 0,
    sourceIsPrimary: !!successionDialog && !!stackRoot && sessionKey(successionDialog.source) === sessionKey(stackRoot), primaryPending: pendingPrimaryCount });

  const [successionGated, setSuccessionGated] = useState(() => !!loadSuccessionIntent(baseUrl));

  const handoffHost = (hostId: string | undefined) => remoteHosts.some(host => host.id === hostId && host.access !== 'shared' && host.online);

  const canHandoffPrimary = canHandoffPrimaryOf({ dialogOpen: !!successionDialog, hasDirectory: !!directory, userScoped, accessReady, hostOffline, status, primaryBound: primaryIsBound,
    transitioning, detachedSide: !!detachedSideRoot, fork: !!boundFork, readOnly: !!sessionState.readOnly, hasPrimary: !!stackRoot, isSubagent: !!stackRoot?.parentNativeSessionId,
    history: navigationIntent.sessionIntent === 'history', hostAllowsHandoff: !!stackRoot && handoffHost(stackRoot.hostId) });

  const openingControlNotice = nativeTakeover ? <SessionControlNotice
    control={{ access: 'read_only', available: false, nativeOwner: nativeTakeover.owner }}
    handoff={openingHandoff?.getState(nativeTakeover.owner.generation)} connected={accessReady && !hostOffline && !transitioning}
    onTakeControl={async options => {
      await openingHandoff!.run(nativeTakeover.owner.generation, async progress => {
        if (!directory || transitionRef.current || !accessReadyRef.current) throw new SessionHandoffRejectedError(t('sessions.sending.accessOrOpening'));
        const opened = await openSession(nativeTakeover.item, progress.checkOnly ? undefined : nativeTakeover.owner.generation, progress.onRestoring);
        if (!opened) throw new Error(t('sessions.conversation.navigationChanged'));
      }, options);
      setNativeTakeover(current => current === nativeTakeover ? undefined : current);
    }} /> : undefined;

  function assertSuccessionAccess() {
    if (!successionAccessible({ accessReady: accessReadyRef.current, dialogInScope: successionDialog?.scope === baseUrl, userScoped, hostAllowsHandoff: handoffHost(successionDialog?.source.hostId) })) throw new Error(t('sessions.sending.handoffNeedsAccess'));
  }

  async function executePrimaryCommand(id: string, args: string): Promise<AgentCommandResult> {
    if (id === handoffCommand.id) {
      const initialProvider = handoffProvider(args);
      if (!canHandoffPrimary || !stackRoot) throw new Error(t('sessions.sending.handoffAvailable'));
      assertSourceCurrent(stackRoot);
      setSuccessionDialog({ scope: baseUrl, source: stackRoot, visible: true, initialProvider, directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, stackRoot.hostId)) });
      return {};
    }
    if (!state || status !== 'ready' || hostOffline) throw new Error(t('sessions.sending.waitSync'));
    return createFork(state, activeOpened, id, args);
  }

  const primarySuccessionGated = primaryHandoffGated({ gated: successionGated, dialogInScope: successionDialog?.scope === baseUrl, hasPrimary: !!stackRoot,
    primaryIsSource: !!stackRoot && !!successionDialog && sessionKey(stackRoot) === sessionKey(successionDialog.source),
    desiredIsResumed: !!successionDialog?.resume && succession.desired?.operationId === successionDialog.resume.operationId });

  const contextTarget = succession.desired?.target.native;

  const successionContext = useSuccessionContext({ directory, operationId: succession.desired?.operationId,
    target: contextTarget?.controllerId ? { ...contextTarget, controllerId: contextTarget.controllerId } : undefined, enabled: userScoped && accessReady && !hostOffline && navigationIntent.sessionIntent !== 'history',
    refreshKey: `${state?.timeline.epoch}:${state?.timeline.entries.at(-1)?.seqEnd}:${pendingPrimaryCount}`,
  });

  // A bot's Handoff shows its progress over the page (portaled), whichever mode or conversation is shown, so App renders it
  // once, at its root. Rendered in the bot's conversation it froze while that conversation was hidden: a hidden
  // conversation keeps its last render (stage 6), so Details stopped opening in Window mode.
  const botHandoff = !!successionDialog && (!!(successionDialog.source as OpenedSession & { bot?: unknown }).bot || !!(successionDialog.source as OpenedSession & { fallback?: boolean }).fallback);

  const successionProgress = successionDialog ? <SessionSuccessionDialog
    source={successionDialog.source} directory={successionDialog.directory}
    progressPortal={botHandoff}
    blockedReason={successionInputReason}
    initialProvider={successionDialog.initialProvider} visible={successionDialog.visible}
    resume={successionDialog.resume} resumeCancellation={successionDialog.cancelRequested}
    onGatedChange={setSuccessionGated}
    onOpen={() => setSuccessionDialog(current => current ? { ...current, visible: true } : current)}
    onIntent={(operation, cancelRequested) => {
      saveSuccessionIntent(successionDialog.scope, { source: successionDialog.source, operation, cancelRequested });
      setSuccessionGated(true);
      setSuccessionDialog(current => current ? { ...current, resume: operation, cancelRequested } : current);
    }}
    assertAccess={assertSuccessionAccess} assertSource={() => { assertSuccessionAccess(); assertSourceCurrent(successionDialog.source); }}
    onSettled={async result => {
      const source = successionDialog.source, slotId = viewKey(source);
      const assertCompletionView = (requireVerified = false) => {
        assertSuccessionAccess();
        const mapped = currentGroupBinding(slotId);
        const slot = succession.document.slots.find(slot => slot.id === slotId);
        const roleKey = slot?.intent.kind === 'role' ? slot.intent.roleKey : undefined;
        if (!handoffCompletionMatches({ source, mappedKey: mapped && sessionKey(mapped.binding), receipt: result.record, role: result.role,
          checkpoint: succession.document.roles.find(role => compositionRoleKey(role) === roleKey), pending: successionDialog.resume,
          verified: succession.successionContextFor(slotId), requireVerified })) throw new Error(t('sessions.sending.sourceChanged'));
      };
      assertCompletionView();
      await succession.refreshSettled(result, source);
      assertCompletionView(true);
    }}
    onClose={retain => {
      if (retain) setSuccessionDialog(current => current ? { ...current, visible: false } : current);
      else { clearSuccessionIntent(successionDialog.scope); setSuccessionGated(false); setSuccessionDialog(undefined); }
    }} /> : undefined;


  const clientActions: AppActions = actions ?? {
    takeControl: options => commandClient().takeControl(options),
    searchTimeline: submittedClient ? (query, options) => commandClient().searchTimeline(query, options) : undefined,
    loadSearchMatch: submittedClient ? (match, options) => commandClient().loadSearchMatch(match, options) : undefined,
    loadOlder: submittedClient ? () => commandClient().loadOlder() : undefined,
    sendMessage: async (text, options) => { await commandClient().sendMessage(text, options).catch(error => { if ((error as { code?: unknown })?.code === 'host_offline') setRefusedOffline(selectedHost.id); throw error; }); },
    sendMessageContent: async (content, options) => { await commandClient().sendMessageContent(content, options); },
    uploadResource: (file, name, uploadId, options) => commandClient().uploadResource(file, name, uploadId, options),
    downloadResource: resourceId => commandClient().downloadResource(resourceId),
    uploadImage: (file, uploadId, options) => commandClient().uploadImage(file, uploadId, options),
    retryMessage: async (id) => { await commandClient().retryMessage(id); },
    deleteMessage: (id) => commandClient().deleteMessage(id),
    steer: async (text) => { await runMutation(() => commandClient().steer(text)); },
    cancel: async () => { await runMutation(() => commandClient().cancel()); },
    listCommands: () => commandClient().listCommands(),
    executeCommand: (id, args) => runMutation(() => commandClient().executeCommand(id, args)),
    setSessionSetting: async (id, value) => { await runMutation(() => commandClient().setSessionSetting(id, value)); },
    setPlanning: async (active) => { await runMutation(() => commandClient().setPlanning(active)); },
    respondToInteraction: async (requestId, response) => { await runMutation(() => commandClient().respondToInteraction(requestId, response)); },
    requestResource: async (binding) => (await commandClient().requestResource(binding.resourceId)).payload.state,
    resolveResource: (locator, sourceLocator) => commandClient().resolveResource(locator, sourceLocator),
    ...(fixtureAction && activeAgentId && state?.agent?.providerId === 'recorded' && !activeRemoteSession ? {
      advanceFixture: () => fixtureAction(activeAgentId, 'advance'),
      rehydrateFixture: () => fixtureAction(activeAgentId, 'rehydrate'),
      stopReader: () => fixtureAction(activeAgentId, 'stop-reader'),
    } : {}),
  };


  async function openScannedSession(target: ScannedSession) {
    const known = sessionEntries.find(entry => sessionKey(entry) === sessionKey(target));
    return openSession({ ...target, title: known?.title || target.nativeSessionId }, undefined, undefined, false, undefined, target.sessionIntent, target.keepOriginal);
  }


  const conversationActions = forkActions(clientActions, forkStore, boundFork, transport);

  // Retain message handlers so the composer can wait for readiness before sending.
  const availableConversationActions = conversationActionsAvailable({ accessReady, hostOffline, status }) ? conversationActions : {
    sendMessage: conversationActions.sendMessage,
    sendMessageContent: conversationActions.sendMessageContent,
    deleteMessage: conversationActions.deleteMessage,
  };


  const { communication: primaryCommunication, ...primaryNavigation }: Partial<SessionViewNavigation> = stackRoot ? viewNavigation(stackRoot, state) : {};
  return { successionDialog, setSuccessionDialog, setPendingGroupInputs, reportPendingPrimaryInput, successionGated, canHandoffPrimary, openingControlNotice, executePrimaryCommand, primarySuccessionGated, successionContext, botHandoff, successionProgress, clientActions, openScannedSession, conversationActions, availableConversationActions, primaryCommunication, primaryNavigation };
}

export type SendingAndSuccessionSlice = ReturnType<typeof useSendingAndSuccession>;
