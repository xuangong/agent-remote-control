import { windowSessionBinding } from '../window-workspace.js';
import { withNewAssistantPicture } from '../assistant-picture.js';
import { sideWindowOperation } from '../window-side-navigation.js';
import { sessionConnectionFailure } from '../components/SessionConnectionNotice.js';
import { type OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { viewKey } from './helpers.js';
import type { AppInputs } from './types.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ViewTargetsSlice } from './useViewTargets.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';

// Selecting and revealing a Side beside its source.
export function useSideSessions(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice, 'editWindow' | 'expandedKeys' | 'navigateSide' | 'navigation' | 'nextSideRequest' | 'openSession' | 'setSessionNotice' | 'setSideAnchor' | 'setSideFocus' | 'setSideSelections' | 'setSideSessions' | 'sharedViewForSlot' | 'sharedWindow' | 'stackPath' | 'succession' | 'viewSession' | 'windowMode' | 'windowWorkspace'>) {
  const { editWindow, expandedKeys, navigateSide, navigation, nextSideRequest, openSession, setSessionNotice, setSideAnchor, setSideFocus, setSideSelections, setSideSessions, sharedViewForSlot, sharedWindow, stackPath, succession, viewSession, windowMode, windowWorkspace } = scope;

  function selectSide(source: OpenedSession, session: OpenedSession): void {
    const sourceSlot = viewKey(viewSession(source));
    // In Bot mode a bot may belong to a group other than the Window shown in Window mode: its Side joins that group,
    // attached beside it, and so becomes a bot of the group (with the Side role).
    const placed = !windowMode && !(sharedWindow && sharedViewForSlot(sourceSlot)) ? succession.document.windowBindings?.find(entry => entry.slotId === sourceSlot) : undefined;
    const group = placed ? windowWorkspace.readGroup(placed.windowId) : undefined;
    if (placed && group) {
      const origin = group.window.views.find(view => view.id === placed.viewId);
      if (!origin?.binding || sessionKey(origin.binding) !== sessionKey(source)) throw new Error('The source view changed. Open the Side session again.');
      const binding = windowSessionBinding(session);
      const { operation, viewId } = sideWindowOperation(group.window, { windowId: group.window.id, viewId: origin.id, binding: origin.binding }, binding, crypto.randomUUID());
      const targetSlot = succession.document.slots.find(slot => slot.id === viewSession(session).viewId)!;
      const slot = operation.type !== 'view.select' && !succession.document.windowBindings?.some(entry => entry.slotId === targetSlot.id)
        ? succession.bindWindowView(group.window.id, viewId, binding, targetSlot.id)
        : succession.ensureWindowView(group.window.id, viewId, binding);
      const opened = { ...session, viewId: slot.id };
      succession.rememberSide(opened);
      setSideSessions(current => [...current.filter(entry => viewKey(entry) !== opened.viewId), opened]);
      nextSideRequest(source);
      void windowWorkspace.operateGroup(group.window.id, withNewAssistantPicture(group, windowWorkspace.groups, operation)).then(() => navigation.select({ kind: 'bot', groupId: group.window.id, viewId }))
        .catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
      return;
    }
    if (sharedWindow) {
      const origin = sharedViewForSlot(sourceSlot);
      if (!origin?.binding || sessionKey(origin.binding) !== sessionKey(source)) throw new Error('The source view changed. Open the Side session again.');
      const binding = windowSessionBinding(session);
      const { operation, viewId } = sideWindowOperation(windowWorkspace.readWindow(), { windowId: sharedWindow.id, viewId: origin.id, binding: origin.binding }, binding, crypto.randomUUID());
      const candidate = viewSession(session);
      const targetSlot = succession.document.slots.find(slot => slot.id === candidate.viewId)!;
      const slot = operation.type !== 'view.select' && !succession.document.windowBindings?.some(entry => entry.slotId === targetSlot.id)
        ? succession.bindWindowView(sharedWindow.id, viewId, binding, targetSlot.id)
        : succession.ensureWindowView(sharedWindow.id, viewId, binding);
      const opened = { ...session, viewId: slot.id };
      succession.rememberSide(opened);
      setSideSessions(current => [...current.filter(entry => viewKey(entry) !== opened.viewId), opened]);
      nextSideRequest(source);
      // In Bot mode the new Side is a bot of this group: open it, as for a group that is not the shown Window.
      const sharedGroup = windowWorkspace.readGroup(sharedWindow.id);
      if (windowMode) editWindow(operation);
      else void (sharedGroup ? windowWorkspace.operateGroup(sharedWindow.id, withNewAssistantPicture(sharedGroup, windowWorkspace.groups, operation)) : windowWorkspace.operate(operation)).then(() => navigation.select({ kind: 'bot', groupId: sharedWindow.id, viewId }))
        .catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
      return;
    }
    nextSideRequest(source);
    const opened = viewSession(session), sourceId = viewKey(viewSession(source));
    succession.rememberSide(opened);
    setSideSessions(current => [...current.filter(entry => viewKey(entry) !== opened.viewId), opened]);
    setSideSelections(current => ({ ...current, [sourceId]: opened.viewId }));
    navigateSide(opened.viewId);
  }
  function revealSession(session: OpenedSession): void {
    const id = (session as { viewId?: string }).viewId;
    const shared = id && sharedViewForSlot(id);
    if (shared) { windowWorkspace.authority?.operate({ type: 'view.select', viewId: shared.id }); return; }
    const visible = stackPath.find(entry => id ? viewKey(entry) === id : sessionKey(entry) === sessionKey(session));
    if (visible) { setSideFocus(viewKey(visible)); if (!expandedKeys.has(viewKey(visible))) setSideAnchor(viewKey(visible)); }
    else void openSession(session);
  }
  return { selectSide, revealSession };
}

export type SideSessionsSlice = ReturnType<typeof useSideSessions>;
