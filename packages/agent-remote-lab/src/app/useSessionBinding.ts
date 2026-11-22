import { bindPlan, focusesVisibleSession, returnsToParent } from '../features/sessions/session-binding.js';
import { createWindowView, hasBotAppearance, isBotView, rebindsBot, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../kernel/window-workspace.js';
import { windowBindingKey } from '../kernel/window-composition.js';
import type { TrackedSessionView } from '../kernel/tracked-session-views.js';
import { sessionConnectionFailure } from '../kernel/SessionConnectionNotice.js';
import { compositionSelection } from '../kernel/session-composition.js';
import { DirectoryError, type OpenedSession, type SessionSummary } from '../kernel/directory-client.js';
import { sessionKey } from '../kernel/session-tree.js';
import { viewKey } from './helpers.js';
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
import { useTranslate } from '@orchardworks/agent-client-web/react';

// Opening a session in the shown Window, binding it to a view, and the entry points that open one.
export function useSessionBinding(scope: Pick<AppInputs & HostAndStackSlice & ViewSessionStateSlice & SideSelectionSlice & SessionSuccessionBindingSlice & PanelsAndShortcutsSlice & ActiveSessionSlice & WorkbenchRecordsSlice & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice & ViewTargetsSlice & WindowViewActionsSlice & RemoteHostStateSlice & ProviderCreationSlice & ProviderStateSlice & SharedFeedsAndTpmSlice & StackSelectionSlice, 'activeAgentId' | 'ancestors' | 'baseUrl' | 'closeContext' | 'closeInspector' | 'compactLayoutRef' | 'directory' | 'directoryDestination' | 'editWindow' | 'letterRequest' | 'navigation' | 'openedSessions' | 'pendingViewRestore' | 'providerId' | 'replicaFor' | 'selectedHost' | 'sessionEntries' | 'sessionWindows' | 'setDetachedSideRoot' | 'setFailure' | 'setNativeTakeover' | 'setSessionNotice' | 'setSideAnchor' | 'setSideFocus' | 'sharedViewForSlot' | 'sharedWindow' | 'showView' | 'succession' | 'trackedViews' | 'transitionRef' | 'transport' | 'windowSession' | 'windowWorkspace' | 'rememberTrackedView' | 'familyPath' | 'expandedKeys'>) {
  const t = useTranslate();
  const { activeAgentId, ancestors, baseUrl, closeContext, closeInspector, compactLayoutRef, directory, directoryDestination, editWindow, letterRequest, navigation, openedSessions, pendingViewRestore, providerId, replicaFor, selectedHost, sessionEntries, sessionWindows, setDetachedSideRoot, setFailure, setNativeTakeover, setSessionNotice, setSideAnchor, setSideFocus, sharedViewForSlot, sharedWindow, showView, succession, trackedViews, transitionRef, transport, windowSession, windowWorkspace, rememberTrackedView, familyPath, expandedKeys } = scope;

  async function openSession(item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & { hostId?: string; parentAgentId?: string; parentNativeSessionId?: string }, takeOver?: string, onRestoring?: () => void, letterNavigation = false, restoreView?: () => TrackedSessionView | undefined, sessionIntent?: 'history', keepOriginal?: boolean, primarySlot?: string, placement?: 'primary', targetPrimaryViewId?: string): Promise<boolean> {
    if (!sharedWindow) sessionWindows.focus();
    if (!letterNavigation) letterRequest.current?.abort();
    if (!directory || transitionRef.current) return false;
    rememberTrackedView();
    const selection = { ...item, hostId: item.hostId ?? selectedHost.id };
    if (focusesVisibleSession({ targetPrimaryViewId, placement, primarySlot, sessionIntent, keepOriginal, restoreView: !!restoreView, takeOver, onRestoring: !!onRestoring })) {
      const visible = familyPath.find(entry => sessionKey(entry) === sessionKey(selection));
      if (visible && !replicaFor(visible.agentId).getState().sessionControl?.nativeOwner) {
        setSideFocus(viewKey(visible));
        if (!expandedKeys.has(viewKey(visible))) setSideAnchor(viewKey(visible));
        showView('workbench'); closeContext(); closeInspector(); return true;
      }
    }
    // Returning to a native parent remains inside the tracked family. Other
    // primary navigation must not save its layout over the Track we just left.
    const returningToParent = returnsToParent({ sessionIntent, primarySlot, restoreView: !!restoreView, isAncestor: ancestors.some(ancestor => sessionKey(ancestor) === sessionKey(selection)) });
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
      setSessionNotice(sessionConnectionFailure(error, false, t));
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
    if (JSON.stringify(view.binding ?? null) !== destination.binding) throw new Error(t('sessions.binding.targetChanged'));
    // Rule 6: a pane of a group shown in Bot mode is a bot and keeps its conversation, so another session opens beside it:
    // a new view in its place, bound as an empty view is, so Track restore, drafts and succession work as usual. A session that
    // is already a bot here is selected instead. Navigation within the bot's own chain (its handoff history) stays in place.
    let target = view, expected = expectedBinding;
    const shownGroup = windowWorkspace.readGroup(current.id);
    // Opening another session over a bot opens it beside (rule 6), and always where the group would refuse the edit (rule 1):
    // in a group with bot details, a bot takes neither another session nor a history or subagent view of one.
    const plan = bindPlan({ hasGroup: !!shownGroup, targetIsBot: isBotView(view), targetId: view.id, targetPlacement: view.placement,
      rebindsBot: !!shownGroup && rebindsBot(shownGroup, view, windowSessionBinding(session)), botAppearance: !!shownGroup && hasBotAppearance(shownGroup),
      sessionIntent: session.sessionIntent, sameSession: isBotView(view) && windowBindingKey(view.binding) === windowBindingKey(windowSessionBinding(session)),
      existingBot: current.views.find(candidate => isBotView(candidate) && windowBindingKey(candidate.binding) === windowBindingKey(windowSessionBinding(session))) });
    if (plan.kind === 'select-existing') {
      await windowWorkspace.operate({ type: 'view.select', viewId: plan.viewId });
      return plan.primary
        ? windowSession.openPrimary(session, session.agentId ? session as OpenedSession : undefined, false, undefined, undefined, plan.viewId, session.sessionIntent) : true;
    }
    if (plan.kind === 'open-beside') {
      // A Side's place holds sessions of its source, so another session takes a primary group.
      const beside = createWindowView(crypto.randomUUID(), undefined, plan.placement);
      await windowWorkspace.operate({ type: 'batch', operations: [{ type: 'view.create', view: beside },
        ...(plan.afterId ? [{ type: 'view.move' as const, viewId: beside.id, afterId: plan.afterId }] : []), { type: 'view.select', viewId: beside.id }] });
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
    } catch (error) { setSessionNotice(sessionConnectionFailure(error, false, t)); return false; }
  }
  async function openPreviewSource(sessionId: string, itemId: string, hostId: string): Promise<void> {
    const source = [...sessionEntries, ...openedSessions].find(item => item.agentId === sessionId && item.hostId === hostId);
    if (!source) { setFailure(t('sessions.binding.previewSourceMissing')); return; }
    if (source && source.agentId !== activeAgentId && !await openSession(source)) return;
    window.requestAnimationFrame(() => {
      const entry = [...document.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.dataset.entryKey === itemId);
      entry?.scrollIntoView({ block: 'center' });
    });
  }
  return { openSession, bindDirectorySession, openLocalView, openDirectorySession, openPreviewSource };
}

export type SessionBindingSlice = ReturnType<typeof useSessionBinding>;
