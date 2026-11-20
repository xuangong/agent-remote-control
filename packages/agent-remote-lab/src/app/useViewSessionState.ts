// Sessions mounted by views, their status, handoff, notices and failure toasts.
import { storeFor } from '../state/draft-ownership.js';
import { useWindowSessionBridge } from '../hooks/useWindowSessionBridge.js';
import { remoteSessionState, sessionHandoffScope, type RemoteSessionStatus } from '@orchardworks/agent-client';
import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import { DraftStore } from '../draft-store.js';
import { TrackedSessionViews } from '../tracked-session-views.js';
import { useFeedbackToast } from '../components/Toast.js';
import { sessionConnectionFailure, type SessionConnectionMessage } from '../components/SessionConnectionNotice.js';
import { useEffect, useMemo, useState } from 'react';
import type { StoreOwner } from '../session-composition.js';
import type { OpenedSession, SessionSummary } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { useDeploymentUpdate } from '../hooks/useDeploymentUpdate.js';
import { message, viewKey } from './helpers.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ProviderStateSlice } from './useProviderState.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function useViewSessionState(scope: Pick<AppInputs & SessionSuccessionBindingSlice & RequestedSessionSlice & WorkbenchShellSlice & ProviderStateSlice & ConversationConnectionsSlice, 'accessReady' | 'activated' | 'cachedSessionState' | 'cachedState' | 'catalogError' | 'draftStores' | 'missingSessions' | 'replicaRef' | 'requested' | 'selectedHost' | 'setSessionState' | 'sharedWindow' | 'storedSessionState' | 'storedState' | 'succession' | 'transport' | 'userScoped' | 'windowMode' | 'windowWorkspace' | 'withConfirmedTitle'>, late: AppLate) {
  const t = useTranslate();
  const { accessReady, activated, cachedSessionState, cachedState, catalogError, draftStores, missingSessions, replicaRef, requested, selectedHost, setSessionState, sharedWindow, storedSessionState, storedState, succession, transport, userScoped, windowMode, windowWorkspace, withConfirmedTitle } = scope;

  const [mountedViewSessions, setMountedViewSessions] = useState<Record<string, OpenedSession & { viewId: string }>>({});

  function receiveViewSession(bound: OpenedSession, slotId?: string, windowViewId?: string) {
    const current = windowWorkspace.readWindow();
    const view = current?.views.find(view => view.id === windowViewId);
    if (!current || !view?.binding || sessionKey(bound) !== sessionKey(view.binding)) return;
    const slot = succession.ensureWindowView(current.id, view.id, view.binding);
    if (slotId !== slot.id) return;
    const session = { ...withConfirmedTitle({ ...bound, title: view.binding.title }), viewId: slot.id };
    succession.rememberSide(session);
    setMountedViewSessions(values => JSON.stringify(values[view.id]) === JSON.stringify(session) ? values : { ...values, [view.id]: session });
  }

  const windowSession = useWindowSessionBridge({ window: sharedWindow, unavailable: windowWorkspace.unavailable, readOnly: windowWorkspace.provisional, readWindow: windowWorkspace.readWindow, operate: windowWorkspace.operate, succession, enabled: accessReady && activated && !windowWorkspace.unavailable && !windowWorkspace.provisional,
    onError: error => setSessionNotice(sessionConnectionFailure(error, false, t)) });

  const sharedSlots = windowSession.slots, sharedFamily = windowSession.family;

  const sharedViewForSlot = windowSession.viewForSlot;

  const compositionProtected = succession.active && succession.discovering;

  const trackedViews = useMemo(() => new TrackedSessionViews(succession.document, () => succession.save()), [succession.document]);

  // While the window has not yet said which conversation it shows, the rows this device stored of the requested one stay on screen instead of an empty shell.
  const heldWhileResolving = succession.active && !succession.state && !succession.selected && !!cachedState;

  const state = windowSession.empty ? undefined : succession.active ? heldWhileResolving ? cachedState : succession.state : storedState ?? cachedState;

  const sessionState = windowSession.empty ? remoteSessionState(undefined, 'idle') : succession.active ? heldWhileResolving ? cachedSessionState! : succession.sessionState : storedState || !cachedSessionState ? storedSessionState : cachedSessionState;

  const status = sessionState.connection;

  const handoff = sessionState.handoff;

  const [attachingAgentId, setAttachingAgentId] = useState<string>();

  const [transitioning, setTransitioning] = useState(false);

  const [, refreshOpeningHandoff] = useState(0);

  const [nativeTakeover, setNativeTakeover] = useState<{item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & {hostId?: string}; owner: NativeSessionOwner; message: string}>();

  const openingHandoff = nativeTakeover ? sessionHandoffScope(transport).forTarget(sessionKey({ ...nativeTakeover.item, hostId: nativeTakeover.item.hostId ?? selectedHost.id })) : undefined;

  useEffect(() => openingHandoff?.subscribe(() => refreshOpeningHandoff(version => version + 1)), [openingHandoff]);

  const [storedSessionNotice, setSessionNotice] = useState<SessionConnectionMessage>();

  function viewSession(session: OpenedSession, id?: string): OpenedSession & { viewId: string } {
    const slot = succession.ensureView(session, id ?? (session as { viewId?: string }).viewId);
    return { ...session, viewId: slot.id };
  }

  function draftOwnerBinding(owner: StoreOwner) {
    return { store: storeFor(draftStores, owner.scope, scope => new DraftStore(scope)), key: owner.key };
  }

  function draftBindingFor(session: OpenedSession) {
    const owner = succession.document.slots.find(slot => slot.id === viewKey(session))!.owners.text;
    return draftOwnerBinding(owner);
  }

  function setStatus(connection: RemoteSessionStatus): void { setSessionState(remoteSessionState(replicaRef.current?.getState() ?? state, connection)); }

  const selectedPrimaryBinding = sharedWindow?.views.find(view => view.id === sharedWindow.selectedPrimaryViewId)?.binding;

  const selectedPrimaryMissing = !!selectedPrimaryBinding && missingSessions.has(sessionKey(selectedPrimaryBinding));

  // The selected view already shows its missing session as an empty view.
  const sessionNotice = selectedPrimaryMissing && storedSessionNotice?.code === 'native_session_unavailable' ? undefined : storedSessionNotice;

  const [failure, setFailure] = useState<string | undefined>(requested.error);

  useFeedbackToast(t('sessions.toast.operation'), windowMode ? failure : undefined);

  useFeedbackToast(t('sessions.toast.connection'), !windowMode || nativeTakeover ? undefined : sessionNotice?.message, sessionNotice?.tone === 'alert' ? 'error' : 'info');

  useFeedbackToast(t('sessions.toast.providerCatalog'), windowMode ? catalogError : undefined);

  useDeploymentUpdate(userScoped);
  late.setAttachingAgentId = setAttachingAgentId;
  late.setSessionNotice = setSessionNotice;
  late.setNativeTakeover = setNativeTakeover;
  return { mountedViewSessions, receiveViewSession, windowSession, sharedSlots, sharedFamily, sharedViewForSlot, compositionProtected, trackedViews, state, sessionState, status, handoff, attachingAgentId, setAttachingAgentId, transitioning, setTransitioning, nativeTakeover, setNativeTakeover, openingHandoff, setSessionNotice, viewSession, draftOwnerBinding, draftBindingFor, selectedPrimaryMissing, sessionNotice, failure, setFailure };
}

export type ViewSessionStateSlice = ReturnType<typeof useViewSessionState>;
