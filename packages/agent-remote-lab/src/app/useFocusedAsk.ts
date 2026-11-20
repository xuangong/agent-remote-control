// The focused view, its Ask and its source.
import { fixtureStaleness, viewStaleness, type CapturedBot, type GroupBindingLookup } from '../state/source-currency.js';
import { windowBindingKey } from '../window-composition.js';
import { useSessionRelations } from '../hooks/useSessionRelations.js';
import type { SourceStaleness, AgentReplicaState } from '@orchardworks/agent-client';
import { useRef } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { errorWords, keyedError } from '../team-words.js';
import { compositionSession, compositionSelection } from '../session-composition.js';
import type { OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import type { LabSessionRef } from '../session-references.js';
import { sideLinkVisible, type SessionFork } from '../session-forks.js';
import { viewKey } from './helpers.js';
import { askUnavailableReason } from '../state/ask-visibility.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';

export function useFocusedAsk(scope: Pick<AppInputs & HostAndStackSlice & SideSelectionSlice & SessionOpeningSlice & WorkbenchRecordsSlice & ActiveSessionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & ConversationConnectionsSlice & RequestedSessionSlice & WorkbenchShellSlice & RemoteHostStateSlice, 'accessReady' | 'accessReadyRef' | 'ask' | 'askView' | 'baseUrl' | 'connections' | 'detachedSideRoot' | 'directory' | 'directoryView' | 'expandedKeys' | 'familyPath' | 'forkStore' | 'initialState' | 'mountedTransport' | 'remoteHosts' | 'replicas' | 'sessionEntries' | 'setFailure' | 'sharedSlots' | 'sharedWindow' | 'sideFocus' | 'stackPath' | 'stackRange' | 'stackRoot' | 'state' | 'succession' | 'toast' | 'transitioning' | 'transport' | 'userScoped' | 'visibleStackRoot' | 'windowWorkspace'>, late: AppLate) {
  const { accessReady, accessReadyRef, ask, askView, baseUrl, connections, detachedSideRoot, directory, directoryView, expandedKeys, familyPath, forkStore, initialState, mountedTransport, remoteHosts, replicas, sessionEntries, setFailure, sharedSlots, sharedWindow, sideFocus, stackPath, stackRange, stackRoot, state, succession, toast, transitioning, transport, userScoped, visibleStackRoot, windowWorkspace } = scope;
  const t = useTranslate();

  const focusedWindow = stackPath.find(session => viewKey(session) === sideFocus) ?? stackPath[stackRange.end];

  const focusedFamilyWindow = familyPath.find(session => viewKey(session) === sideFocus) ?? focusedWindow;

  const focusedFamilyIndex = focusedFamilyWindow ? Math.max(0, familyPath.findIndex(session => viewKey(session) === viewKey(focusedFamilyWindow))) : 0;

  const primaryExpanded = detachedSideRoot ? !!stackRoot && expandedKeys.has(viewKey(stackRoot)) : stackRange.start === 0 && (!stackRoot || expandedKeys.has(viewKey(stackRoot)));

  const addressSession = stackPath.find((session) => viewKey(session) === sideFocus) ?? visibleStackRoot;

  const focusedBinding = directoryView?.binding;

  const focusedMenuSession = sharedWindow ? focusedBinding && {
    hostId: focusedBinding.hostId, providerId: focusedBinding.providerId, nativeSessionId: focusedBinding.nativeSessionId,
    title: focusedBinding.title, parentNativeSessionId: focusedBinding.parentNativeSessionId,
    agentId: sessionEntries.find(entry => sessionKey(entry) === sessionKey(focusedBinding))?.agentId,
  } : addressSession;

  const focusedSessionKey = focusedMenuSession && sessionKey(focusedMenuSession);

  const focusedMenuStatus = focusedMenuSession?.agentId === state?.agent?.id ? state?.agent?.status
    : sessionEntries.find(entry => sessionKey(entry) === focusedSessionKey)?.status;

  const focusedAskSlot = directoryView && sharedSlots?.get(directoryView.id);

  const focusedAskSession = sharedWindow ? focusedAskSlot && directoryView?.binding
    && sessionKey(compositionSelection(focusedAskSlot)) === sessionKey(directoryView.binding)
    ? compositionSession(focusedAskSlot) : undefined : addressSession;

  const focusedAskOwner = focusedAskSession ? succession.ownerFor(viewKey(focusedAskSession)) : undefined;

  const focusedAskEntry = focusedAskSession && focusedAskOwner ? ask.entryFor(focusedAskSession, focusedAskOwner) : undefined;

  function currentGroupBinding(slotId: string | undefined) {
    if (!slotId) return;
    const mappings = succession.document.windowBindings?.filter(entry => entry.slotId === slotId) ?? [];
    if (!mappings.length) return;
    const owner = mappings[0]!;
    if (mappings.some(entry => entry.windowId !== owner.windowId || entry.viewId !== owner.viewId)) throw keyedError('team.view.conflictingOwners');
    const group = windowWorkspace.readGroup(owner.windowId);
    if (!group) throw keyedError(windowWorkspace.deletedWindowIds.includes(owner.windowId) ? 'team.view.deleted' : 'team.view.groupUnavailable');
    const view = group.window.views.find(view => view.id === owner.viewId);
    const binding = view?.binding;
    const mapped = binding && succession.document.windowBindings?.find(entry => entry.windowId === owner.windowId && entry.viewId === owner.viewId && entry.bindingKey === windowBindingKey(binding));
    if (!binding || mapped?.slotId !== slotId || !succession.document.slots.some(slot => slot.id === slotId)) throw keyedError('team.view.rebound');
    return { groupId: owner.windowId, viewId: owner.viewId, binding };
  }

  /** A source's state as its view shows it: the view's connection may hold its own replica, not the cached one. */
  function sourceStateFor(source: OpenedSession): AgentReplicaState | undefined {
    if (source.agentId === state?.agent?.id) return state;
    const connection = connections.find(source);
    return (connection?.agentId === source.agentId ? connection.replica : replicas.get(source.agentId))?.getState();
  }

  const focusedAskState = focusedAskSession ? sourceStateFor(focusedAskSession) : undefined;

  function sourceStale(source: OpenedSession): SourceStaleness | undefined {
    const viewId = (source as { viewId?: string }).viewId, sourceKey = sessionKey(source);
    let lookup: GroupBindingLookup = { kind: 'none' };
    try {
      const mapped = currentGroupBinding(viewId);
      if (mapped) lookup = { kind: 'bound', groupId: mapped.groupId, viewId: mapped.viewId, sessionKey: sessionKey(mapped.binding) };
    } catch { lookup = { kind: 'unresolvable' }; }
    const stale = viewStaleness({ captured: (source as { bot?: CapturedBot }).bot, lookup, sourceKey });
    if (stale) return stale;
    if (initialState && !succession.active) {
      const slot = succession.document.slots.find(slot => slot.id === viewId), agent = initialState.agent;
      return fixtureStaleness({ slotSelectionKey: slot && sessionKey(compositionSelection(slot)), sourceKey, source,
        agent: agent && { id: agent.id, providerId: agent.providerId, nativeSessionId: agent.runtimeInfo.sessionId } });
    }
    return succession.sourceStale(source);
  }

  const focusedAskUnavailable = askUnavailableReason({ hasSource: !!focusedAskSession, hasDirectory: !!directory, accessReady, transitioning,
    controllerOffline: remoteHosts.find(host => host.id === focusedAskSession?.hostId)?.online === false, hasTarget: !!focusedAskEntry?.record?.target,
    staleness: focusedAskSession ? sourceStale(focusedAskSession) : undefined, hasAgentState: !!focusedAskState?.agent }, t);

  const canOpenFocusedAsk = !!focusedAskSession && !focusedAskUnavailable;

  const refreshRelations = useSessionRelations(baseUrl, userScoped && accessReady, forkStore, ask.store, addressSession ? sessionKey(addressSession) : undefined, userScoped);

  const pendingSideSources = useRef(new Map<string, OpenedSession>());


  async function unlinkSide(record: SessionFork): Promise<void> {
    await refreshRelations.setLinked(record, false);
    const unlinked = forkStore.get(record.id);
    toast?.show(`unlink-side:${record.id}`, t('team.toast.sideUnlinkedTitle'), t('team.toast.sideUnlinkedMessage'), 'info', {
      label: t('team.toast.undo'), onClick: async () => { await refreshRelations.setLinked(unlinked, true); },
    });
  }

  /** A removed source also leaves its source's Sides, so the conversation stands on its own. */
  async function removedReference(ref: LabSessionRef, restore: () => Promise<void>, fork: SessionFork | undefined): Promise<void> {
    if (ref.origin === 'source' && fork && sideLinkVisible(fork)) await refreshRelations.setLinked(fork, false).catch(() => undefined);
    toast?.show(`reference:${ref.providerId}/${ref.nativeSessionId}`, t('team.toast.referenceRemovedTitle'), t('team.toast.referenceRemovedMessage'), 'info', {
      label: t('team.toast.undo'), onClick: async () => { await restore(); },
    });
  }

  async function restoredReference(fork: SessionFork | undefined): Promise<void> {
    const current = fork && forkStore.get(fork.id);
    if (current && !sideLinkVisible(current)) await refreshRelations.setLinked(current, true).catch(() => undefined);
  }

  function sourceCurrent(source: OpenedSession): boolean {
    return !sourceStale(source);
  }

  function assertSourceCurrent(source: OpenedSession): void {
    if (!accessReadyRef.current || mountedTransport.current !== transport || !sourceCurrent(source)) throw new Error(t('team.ask.error.sourceChanged'));
  }

  function openAsk(source: OpenedSession, sourceState: AgentReplicaState | undefined, clean = false) {
    askView.setVisible(true);
    const associationOwner = succession.ownerFor(viewKey(source));
    const existingOnly = !clean && !!ask.entryFor(source, associationOwner).record?.target;
    const requireSource = () => {
      if (!existingOnly) { assertSourceCurrent(source); return; }
      const slot = succession.document.slots.find(slot => slot.id === viewKey(source));
      if (!accessReadyRef.current || mountedTransport.current !== transport || !slot || sessionKey(compositionSelection(slot)) !== sessionKey(source)) {
        throw new Error(t('team.ask.error.sourceReferenceChanged'));
      }
    };
    try { requireSource(); } catch (error) { setFailure(errorWords(t, error, 'team.ask.error.couldNotOpen')); return; }
    void ask.open(sourceState, source, '', clean, { associationOwner, existingOnly, synchronize: async () => {
      requireSource(); await refreshRelations(); requireSource();
    } }).catch(error => setFailure(errorWords(t, error, 'team.ask.error.couldNotOpen')));
  }
  late.addressSession = addressSession;
  return { focusedWindow, focusedFamilyWindow, focusedFamilyIndex, primaryExpanded, addressSession, focusedMenuSession, focusedSessionKey, focusedMenuStatus, focusedAskSession, focusedAskEntry, currentGroupBinding, sourceStateFor, focusedAskState, focusedAskUnavailable, canOpenFocusedAsk, refreshRelations, pendingSideSources, unlinkSide, removedReference, restoredReference, sourceCurrent, assertSourceCurrent, openAsk };
}

export type FocusedAskSlice = ReturnType<typeof useFocusedAsk>;
