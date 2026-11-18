// Opening, creating and binding sessions.
import { parseWindowFeature } from '../window-feature-views.js';
import { createWindowView, hasBotAppearance, isBotView, rebindsBot, type Team, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { windowBindingKey } from '../window-composition.js';
import { teamLayoutTargets } from '../team-layout.js';
import { tpmMainTarget } from '../tpm-main-sessions.js';
import type { TrackedSessionView } from '../tracked-session-views.js';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { compositionSelection } from '../session-composition.js';
import { DirectoryError, type OpenedSession, type SessionSummary } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { expandedSideRange } from '../side-tree.js';
import { createAgentId, message, viewKey } from './helpers.js';
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
import type { AppInputs } from './types.js';
import type { AppLate } from './types.js';

export function useSessionOpening(scope: Pick<AppInputs & HostAndStackSlice & ViewSessionStateSlice & SideSelectionSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & WorkbenchRecordsSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice & ViewTargetsSlice & WindowViewActionsSlice & RemoteHostStateSlice & ProviderCreationSlice & ProviderStateSlice & SharedFeedsAndTpmSlice, 'accessReadyRef' | 'activeAgentId' | 'ancestors' | 'attach' | 'baseUrl' | 'closeContext' | 'closeInspector' | 'compactLayout' | 'compactLayoutRef' | 'createPlanning' | 'creationReservation' | 'creationUnavailableReason' | 'directory' | 'directoryDestination' | 'dispatchPanels' | 'editWindow' | 'letterRequest' | 'mountedTransport' | 'navigation' | 'openedSessions' | 'pendingViewRestore' | 'presentedSelection' | 'providerConnectionName' | 'providerId' | 'rememberSession' | 'replicaFor' | 'retryHosts' | 'selectedHost' | 'sessionEntries' | 'sessionOptions' | 'sessionWindows' | 'setCreationLocked' | 'setDetachedSideRoot' | 'setDirectoryRevision' | 'setFailure' | 'setNativeTakeover' | 'setNewBot' | 'setProviderName' | 'setSessionNotice' | 'setSideAnchor' | 'setSideFocus' | 'setTransitioning' | 'sharedViewForSlot' | 'sharedWindow' | 'showView' | 'sideAnchor' | 'sideFocus' | 'sideSelections' | 'sideSessions' | 'sideTitle' | 'stackPath' | 'succession' | 'tpm' | 'tpmMainRequest' | 'tpmMainState' | 'trackedViews' | 'transitionRef' | 'transport' | 'visibleStackRoot' | 'windowSession' | 'windowWorkspace'>, late: AppLate) {
  const { accessReadyRef, activeAgentId, ancestors, attach, baseUrl, closeContext, closeInspector, compactLayout, compactLayoutRef, createPlanning, creationReservation, creationUnavailableReason, directory, directoryDestination, dispatchPanels, editWindow, letterRequest, mountedTransport, navigation, openedSessions, pendingViewRestore, presentedSelection, providerConnectionName, providerId, rememberSession, replicaFor, retryHosts, selectedHost, sessionEntries, sessionOptions, sessionWindows, setCreationLocked, setDetachedSideRoot, setDirectoryRevision, setFailure, setNativeTakeover, setNewBot, setProviderName, setSessionNotice, setSideAnchor, setSideFocus, setTransitioning, sharedViewForSlot, sharedWindow, showView, sideAnchor, sideFocus, sideSelections, sideSessions, sideTitle, stackPath, succession, tpm, tpmMainRequest, tpmMainState, trackedViews, transitionRef, transport, visibleStackRoot, windowSession, windowWorkspace } = scope;


  function rememberTrackedView(): void {
    if (!visibleStackRoot) return;
    trackedViews.remember({ primarySlot: viewKey(visibleStackRoot), focus: sideFocus, anchor: sideAnchor,
      selections: Object.fromEntries(stackPath.map(session => [viewKey(session), sideSelections[viewKey(session)] ?? null])) });
  }

  // A shared source can show several Sides, so its family is wider than the selected path.
  const familyPath = sharedWindow ? (visibleStackRoot ? [visibleStackRoot, ...sideSessions] : []).map(sideTitle) : stackPath;

  const selectedPathIndex = stackPath.findIndex(session => viewKey(session) === sideFocus);

  const sharedDesktopAnchor = sharedWindow && !compactLayout && selectedPathIndex >= 0
    ? stackPath[Math.min(stackPath.length - 1, selectedPathIndex + 1)] : undefined;

  const stackRange = expandedSideRange(stackPath, compactLayout ? sideFocus : sharedDesktopAnchor ? viewKey(sharedDesktopAnchor) : sideAnchor, compactLayout ? 1 : 2, viewKey);

  const expandedKeys = new Set(stackPath.slice(stackRange.start, stackRange.end + 1).filter(session => !sharedViewForSlot(viewKey(session))?.collapsed).map(viewKey));


  async function openSession(item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & { hostId?: string; parentAgentId?: string; parentNativeSessionId?: string }, takeOver?: string, onRestoring?: () => void, letterNavigation = false, restoreView?: () => TrackedSessionView | undefined, sessionIntent?: 'history', keepOriginal?: boolean, primarySlot?: string, placement?: 'primary', targetPrimaryViewId?: string): Promise<boolean> {
    if (!sharedWindow) sessionWindows.focus();
    if (!letterNavigation) letterRequest.current?.abort();
    if (!directory || transitionRef.current) return false;
    rememberTrackedView();
    const selection = { ...item, hostId: item.hostId ?? selectedHost.id };
    if (!targetPrimaryViewId && placement !== 'primary' && !primarySlot && sessionIntent !== 'history' && keepOriginal === undefined && !restoreView && !takeOver && !onRestoring) {
      const visible = familyPath.find(entry => sessionKey(entry) === sessionKey(selection));
      if (visible && !replicaFor(visible.agentId).getState().sessionControl?.nativeOwner) {
        setSideFocus(viewKey(visible));
        if (!expandedKeys.has(viewKey(visible))) setSideAnchor(viewKey(visible));
        showView('workbench'); closeContext(); closeInspector(); return true;
      }
    }
    // Returning to a native parent remains inside the tracked family. Other
    // primary navigation must not save its layout over the Track we just left.
    const returningToParent = sessionIntent !== 'history' && !primarySlot && !restoreView
      && ancestors.some(ancestor => sessionKey(ancestor) === sessionKey(selection));
    if (!returningToParent) trackedViews.select();
    pendingViewRestore.current = primarySlot && restoreView ? { scope: baseUrl, transport, slotId: primarySlot, read: restoreView } : undefined;
    setDetachedSideRoot(undefined);
    if (!takeOver && !onRestoring) setNativeTakeover(undefined);
    showView('workbench'); setFailure(undefined); setSessionNotice(undefined);
    closeContext();
    if (compactLayoutRef.current) closeInspector();
    // A bot keeps its conversation: a session that would take a bot's place in a group with bot details opens beside it, as
    // the directory does, rather than asking the group for an edit it refuses ("A bot keeps its conversation…").
    const shownWindow = sharedWindow && !takeOver && !onRestoring ? windowWorkspace.readWindow() ?? sharedWindow : undefined;
    const destination = shownWindow?.views.find(view => view.id === (targetPrimaryViewId ?? shownWindow.selectedPrimaryViewId));
    const beside = shownWindow && destination && rebindsBot(windowWorkspace.readGroup(shownWindow.id), destination, windowSessionBinding(selection, sessionIntent))
      ? { windowId: shownWindow.id, viewId: destination.id, binding: JSON.stringify(destination.binding ?? null) } : undefined;
    try {
      const result = beside ? await bindDirectorySession({ ...selection, ...(sessionIntent ? { sessionIntent } : {}) }, beside)
        : sharedWindow && !takeOver && !onRestoring
        ? await windowSession.openPrimary(selection, undefined, false, keepOriginal, primarySlot, targetPrimaryViewId, sessionIntent)
        : await succession.open(selection, sessionIntent, keepOriginal, primarySlot, takeOver, onRestoring);
      return result;
    } catch (error) {
      setSessionNotice(sessionConnectionFailure(error, false));
      if (error instanceof DirectoryError && error.nativeOwner) setNativeTakeover({ item: selection, owner: error.nativeOwner, message: error.message });
      if (takeOver || onRestoring) throw error;
      return false;
    }
  }

  async function bindDirectorySession(session: Parameters<typeof openSession>[0] & { agentId?: string; sessionIntent?: 'history' }, destination: ReturnType<typeof directoryDestination>, trackedView?: { primarySlot: string; read?: () => TrackedSessionView | undefined }) {
    if (!destination) return session.agentId ? windowSession.openAttached(session as OpenedSession) : openSession(session);
    const current = windowWorkspace.readWindow(), view = current?.views.find(view => view.id === destination.viewId);
    if (current?.id !== destination.windowId || !view) return false;
    const expectedBinding = JSON.parse(destination.binding) as WindowSessionBinding | null;
    if (JSON.stringify(view.binding ?? null) !== destination.binding) throw new Error('The target session view changed. Choose a session again.');
    // Rule 6: a pane of a group shown in Bot mode is a bot and keeps its conversation, so another session opens beside it:
    // a new view in its place, bound as an empty view is, so Track restore, drafts and succession work as usual. A session that
    // is already a bot here is selected instead. Navigation within the bot's own chain (its handoff history) stays in place.
    let target = view, expected = expectedBinding;
    const shownGroup = windowWorkspace.readGroup(current.id);
    // Opening another session over a bot opens it beside (rule 6), and always where the group would refuse the edit (rule 1):
    // in a group with bot details, a bot takes neither another session nor a history or subagent view of one.
    if (shownGroup && isBotView(view) && (rebindsBot(shownGroup, view, windowSessionBinding(session))
      || hasBotAppearance(shownGroup) && session.sessionIntent !== 'history' && windowBindingKey(view.binding) !== windowBindingKey(windowSessionBinding(session)))) {
      const binding = windowSessionBinding(session);
      const existing = current.views.find(candidate => isBotView(candidate) && windowBindingKey(candidate.binding) === windowBindingKey(binding));
      if (existing) {
        await windowWorkspace.operate({ type: 'view.select', viewId: existing.id });
        return existing.placement === 'primary'
          ? windowSession.openPrimary(session, session.agentId ? session as OpenedSession : undefined, false, undefined, undefined, existing.id, session.sessionIntent) : true;
      }
      // A Side's place holds sessions of its source, so another session takes a primary group.
      const placement = view.placement === 'dock' || view.placement === 'float' ? view.placement : 'primary';
      const beside = createWindowView(crypto.randomUUID(), undefined, placement);
      await windowWorkspace.operate({ type: 'batch', operations: [{ type: 'view.create', view: beside },
        ...(placement === 'dock' ? [{ type: 'view.move' as const, viewId: beside.id, afterId: view.id }] : []), { type: 'view.select', viewId: beside.id }] });
      target = beside; expected = null;
    }

    if (target.placement === 'primary') {
      const pending = trackedView?.read ? { scope: baseUrl, transport, slotId: trackedView.primarySlot, read: trackedView.read } : undefined;
      if (trackedView) pendingViewRestore.current = pending;
      let opened = false;
      try {
        opened = await windowSession.openPrimary(session, !trackedView && session.agentId ? session as OpenedSession : undefined, false, undefined, trackedView?.primarySlot, target.id, session.sessionIntent, expected);
        return opened;
      } finally { if (!opened && trackedView && pendingViewRestore.current === pending) pendingViewRestore.current = undefined; }
    }
    editWindow({ type: 'view.bind', viewId: target.id, binding: windowSessionBinding(session), expectedBinding: expected });
    return true;
  }

  async function openLocalView(slotId: string): Promise<void> {
    const slot = succession.document.slots.find(slot => slot.id === slotId);
    if (!slot) return;
    rememberTrackedView();
    const entry = succession.document.tracks.find(entry => entry.slotId === slotId), view = trackedViews.getForSlot(slotId);
    const sharedView = sharedViewForSlot(slotId);
    if (sharedWindow && sharedView) {
      editWindow({ type: 'view.select', viewId: sharedView.id });
      trackedViews.select(entry?.entryId);
      return;
    }
    if (await openSession(view?.primary ?? compositionSelection(slot), undefined, undefined, false, view ? () => trackedViews.getForSlot(slotId) : undefined,
      undefined, undefined, view?.primarySlot ?? slotId)) trackedViews.select(entry?.entryId);
  }

  /** Creates a session from the New session form or, for `bot`, Bot mode's New bot, which starts a group named after it. */
  async function createAgent(bot = false): Promise<void> {
    if (!providerId || creationUnavailableReason || transitionRef.current) return;
    if (bot && !directory) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined); setSessionNotice(undefined);
    if (bot) setNewBot(current => ({ ...current, failure: undefined }));
    const agentId = createAgentId();
    let botSession = false;
    try {
      if (bot && directory) {
        const reservation = creationReservation.current?.bot ? creationReservation.current
          : { operationId: crypto.randomUUID(), providerId, bot: true as const, options: { ...sessionOptions } };
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
        const reservation = creationReservation.current ?? { operationId: crypto.randomUUID(), providerId, destination: directoryDestination(), options: { ...sessionOptions, ...(createPlanning && providerId !== 'dsh' ? { planning: true } : {}) } };
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
      if (error instanceof DirectoryError && error.code === 'native_file_limit') {
        const notice = sessionConnectionFailure(error, false);
        setSessionNotice({ ...notice, operation: 'Create session', message: `${notice.message} Creation may have partially completed. Inspect the native session list before creating a new intent. Retry keeps the same reservation.` });
      }
      const invalid = error instanceof DirectoryError && ['invalid_request', 'workspace_not_found', 'provider_not_found', 'session_quota_exceeded', 'operation_conflict'].includes(error.code ?? '');
      if (invalid) { creationReservation.current = undefined; setCreationLocked(false); }
      const failed = `${message(error, 'Agent could not be created.')}${directory && !invalid && creationReservation.current ? ' Retry keeps the same session reservation and settings.' : ''}`;
      if (bot) {
        // Before the session exists the sheet shows why; after, the roster shows the group's creation state and its Retry.
        if (!botSession) setNewBot(current => ({ ...current, failure: failed }));
      } else if (!(error instanceof DirectoryError && error.code === 'native_file_limit')) setFailure(failed);
    } finally {
      if (directory && selectedHost.id !== 'local') retryHosts();
      transitionRef.current = false;
      setTransitioning(false);
    }
  }

  async function openDirectorySession(item: Parameters<typeof openSession>[0]): Promise<boolean> {
    try {
      const destination = directoryDestination();
      if (!destination) {
        // Without a shared Window, a selected local session view on desktop binds in place, as it did before Windows.
        const local = !sharedWindow && !compactLayoutRef.current ? sessionWindows.activeId : undefined;
        if (!local) return openSession(item);
        sessionWindows.bind(local, { ...item, hostId: item.hostId ?? selectedHost.id });
        void succession.refresh();
        showView('workbench'); closeContext(); return true;
      }
      const opened = bindDirectorySession({ ...item, hostId: item.hostId ?? selectedHost.id }, destination);
      showView('workbench'); closeContext(); return await opened;
    } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); return false; }
  }

  async function openTeamLayout(team: Team, sourceViewAddress?: string): Promise<boolean> {
    const layout = teamLayoutTargets(team, false);
    const current = windowWorkspace.readWindow();
    const captured = sourceViewAddress?.split('/');
    if (captured && current?.id !== captured[0]) return false;
    const existing = current?.views.find(view => { const feature = parseWindowFeature(view.feature); return feature?.kind === 'team' && feature.id === team.id && feature.role === 'leader'; });
    if (existing) {
      editWindow({ type: 'view.select', viewId: existing.id });
      const latest = windowWorkspace.readWindow();
      const leader = latest?.views.find(view => view.id === existing.id);
      const feature = parseWindowFeature(leader?.feature);
      if (latest?.id !== current?.id || feature?.kind !== 'team' || feature.id !== team.id || feature.role !== 'leader') return false;
      sessionWindows.open(layout.dock, layout.groupRoot, team.id); return true;
    }
    if (current) {
      const destination = current.views.find(view => view.id === (captured?.[1] ?? presentedSelection(current)?.id));
      if (captured && !destination) return false;
      const sameSource = destination?.binding && sessionKey(destination.binding) === sessionKey(layout.main);
      if (captured && !sameSource) return false;
      if (!sameSource) {
        if (!destination || destination.bindingPolicy === 'managed') {
          const source = createWindowView(crypto.randomUUID(), windowSessionBinding(layout.main));
          editWindow({ type: 'batch', operations: [{ type: 'view.create', view: source }, { type: 'view.select', viewId: source.id }] });
        } else if (!await bindDirectorySession(layout.main, { windowId: current.id, viewId: destination.id, binding: JSON.stringify(destination.binding ?? null) })) return false;
      }
      if (windowWorkspace.readWindow()?.id !== current.id) return false;
    } else if (!await openSession(layout.main, undefined, undefined, false, undefined, undefined, undefined, undefined, 'primary')) return false;
    sessionWindows.open(layout.dock, layout.groupRoot, team.id);
    return true;
  }

  async function openTpmMain(item: (typeof tpm.works)[number]): Promise<void> {
    const request = ++tpmMainRequest.current;
    const binding = item.work.mainBinding, ref = item.work.mainSessionRef;
    const target = tpmMainTarget(item);
    const current = () => accessReadyRef.current && tpmMainRequest.current === request && mountedTransport.current === transport
      && tpmMainState.current.scope === baseUrl && tpmMainState.current.transport === transport;
    try {
      if (!current()) throw new Error('Workspace access is restoring.');
      if (binding?.kind === 'primary_role') {
        if (!ref || !transport.fetchSessionSuccessionCurrent) throw new Error('The current main session mapping is unavailable. Refresh TPM and retry.');
        const latestRole = await transport.fetchSessionSuccessionCurrent(binding.roleId, { signal: AbortSignal.timeout(15000) });
        if (!current()) return;
        if (latestRole.locator.hostId !== item.hostId || latestRole.role.current.controllerId !== ref.controllerId
          || latestRole.role.current.providerId !== ref.providerId || latestRole.role.current.nativeSessionId !== ref.nativeSessionId) {
          await tpm.refresh();
          if (current()) throw new Error('The main session changed. TPM has been refreshed; open its current main session again.');
          return;
        }
      }
      if (!current()) return;
      const host = tpmMainState.current.hosts.find(host => host.id === target.hostId);
      const catalog = target.hostId === 'local' ? tpmMainState.current.providers : host?.providers;
      if ((target.hostId !== 'local' && (!host || !host.online)) || !catalog?.some(provider => provider.providerId === target.providerId)) {
        throw new Error('The main session provider is unavailable on this Host.');
      }
      const title = sessionEntries.find(entry => sessionKey(entry) === sessionKey(target))?.title ?? 'Main session';
      await openSession({ ...target, title });
    } catch (error) { if (current()) setFailure(message(error, 'The main session could not be opened.')); }
  }


  async function openPreviewSource(sessionId: string, itemId: string, hostId: string): Promise<void> {
    const source = [...sessionEntries, ...openedSessions].find(item => item.agentId === sessionId && item.hostId === hostId);
    if (!source) { setFailure("This preview source is not in the current session list. Open its session from the Host first."); return; }
    if (source && source.agentId !== activeAgentId && !await openSession(source)) return;
    window.requestAnimationFrame(() => {
      const entry = [...document.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.dataset.entryKey === itemId);
      entry?.scrollIntoView({ block: 'center' });
    });
  }
  late.expandedKeys = expandedKeys;
  return { rememberTrackedView, familyPath, stackRange, expandedKeys, openSession, bindDirectorySession, openLocalView, createAgent, openDirectorySession, openTeamLayout, openTpmMain, openPreviewSource };
}

export type SessionOpeningSlice = ReturnType<typeof useSessionOpening>;
