// Ask, the Side sessions of a view and their selection, focus and anchor.
import { createWindowView, type WindowEdit } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { windowBindingKey } from '../window-composition.js';
import { useEffect, useMemo } from 'react';
import { compositionSession, compositionSelection } from '../session-composition.js';
import type { OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { useAskConversations } from '../hooks/useAskConversations.js';
import type { SideSelections } from '../side-tree.js';
import { viewKey } from './helpers.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { RemoteHostStateSlice } from './useRemoteHostState.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { AppLate } from './types.js';

export function useSideSelection(scope: Pick<SessionSuccessionBindingSlice & WorkbenchShellSlice & RequestedSessionSlice & RemoteHostStateSlice & WorkbenchRecordsSlice & ViewSessionStateSlice & PanelsAndShortcutsSlice, 'compactLayout' | 'contextOpen' | 'directory' | 'mountedViewSessions' | 'pageOpen' | 'retryHosts' | 'selectedHost' | 'sessionPanel' | 'sessionsPageTitleRef' | 'sharedFamily' | 'sharedSlots' | 'sharedViewForSlot' | 'sharedWindow' | 'shellRef' | 'storedSideSessions' | 'succession' | 'transport' | 'windowMode' | 'windowSession' | 'windowWorkspace'>, late: AppLate) {
  const { compactLayout, contextOpen, directory, mountedViewSessions, pageOpen, retryHosts, selectedHost, sessionPanel, sessionsPageTitleRef, sharedFamily, sharedSlots, sharedViewForSlot, sharedWindow, shellRef, storedSideSessions, succession, transport, windowMode, windowSession, windowWorkspace } = scope;

  const ask = useAskConversations(succession.document, transport, directory, selectedHost.id, retryHosts, source => succession.resolveTarget(source, { nativePrefixOnly: true }).target, windowWorkspace.authority);

  const projectedLayout = succession.layoutView();

  const availableSides = projectedLayout ? [...storedSideSessions.filter(session => !projectedLayout.sides.some(side => viewKey(side) === viewKey(session))), ...projectedLayout.sides] : storedSideSessions;

  /** Every view attached in the selected primary family, in Window order, once its session is known. */
  function sharedFamilySides(): OpenedSession[] {
    const known = new Map(availableSides.map(session => [viewKey(session), session]));
    return (sharedWindow?.views ?? []).flatMap(view => {
      const slot = view.attachedTo && sharedFamily?.has(view.id) ? sharedSlots?.get(view.id) : undefined;
      const mounted = mountedViewSessions[view.id];
      const session = slot && (known.get(slot.id) ?? (mounted?.viewId === slot.id ? mounted : compositionSession(slot)));
      return session && view.binding && sessionKey(session) === sessionKey(view.binding) ? [session] : [];
    });
  }

  const sideSessions = windowSession.empty ? [] : sharedWindow ? sharedFamilySides() : availableSides;

  const sideSelections = useMemo<SideSelections>(() => Object.fromEntries(succession.document.edges.filter(edge => edge.selected).map(edge => [edge.source, edge.target])), [succession.document, succession.document.editRevision]);

  const sideFocus = succession.document.focus, sideAnchor = succession.document.anchor;

  /** Sessions shown beside a source: each view attached to it in a shared Window, otherwise its selected Side. */
  function openSideKeys(sourceId: string): string[] {
    if (sharedWindow) {
      const source = sharedViewForSlot(sourceId);
      return source ? sharedWindow.views.flatMap(view => view.attachedTo === source.id && view.binding ? [sessionKey(view.binding)] : []) : [];
    }
    const slot = succession.document.slots.find(slot => slot.id === sideSelections[sourceId]);
    return slot ? [sessionKey(compositionSelection(slot))] : [];
  }

  /**
   * The shared Window's view holding a slot, also while the bridge waits for discovery: a primary group opened beside a bot
   * moments ago (a restored Track) gets its Sides even before the bridge maps it.
   */
  function sharedViewOf(slotId: string) {
    const known = sharedViewForSlot(slotId), current = windowWorkspace.readWindow();
    if (known || !current) return known;
    const entry = succession.document.windowBindings?.find(entry => entry.windowId === current.id && entry.slotId === slotId);
    return entry ? current.views.find(view => view.id === entry.viewId && !!view.binding && windowBindingKey(view.binding) === entry.bindingKey) : undefined;
  }

  function setSideSelections(change: SideSelections | ((current: SideSelections) => SideSelections)) {
    const current = Object.fromEntries(succession.document.edges.filter(edge => edge.selected).map(edge => [edge.source, edge.target]));
    const next = typeof change === 'function' ? change(current) : change;
    if (sharedWindow) {
      const operations: WindowEdit[] = [];
      for (const [sourceId, targetId] of Object.entries(next)) {
        if (current[sourceId] === targetId) continue;
        const source = sharedViewOf(sourceId); if (!source) continue;
        const existing = targetId ? sharedViewForSlot(targetId) : undefined;
        if (existing?.attachedTo === source.id) {
          operations.push({ type: 'view.select', viewId: existing.id });
          continue;
        }
        // The source keeps the views already attached to it; the selection only adds or focuses one.
        const target = targetId && succession.document.slots.find(slot => slot.id === targetId);
        if (target) {
          const view = { ...createWindowView(crypto.randomUUID(), windowSessionBinding(compositionSelection(target)), 'attached'), attachedTo: source.id };
          const alreadyOwned = succession.document.windowBindings?.some(entry => entry.slotId === target.id);
          if (alreadyOwned) succession.ensureWindowView(sharedWindow.id, view.id, view.binding!);
          else succession.bindWindowView(sharedWindow.id, view.id, view.binding!, target.id);
          operations.push({ type: 'view.create', view }, { type: 'view.select', viewId: view.id });
        } else operations.push({ type: 'view.select', viewId: source.id });
      }
      if (operations.length) windowWorkspace.authority?.operate({ type: 'batch', operations });
      return;
    }
    const edges = Object.entries(next).flatMap(([source, target]) => target ? [{ source, target, selected: true }] : []);
    if (JSON.stringify(edges) === JSON.stringify(succession.document.edges)) return;
    succession.document.edges = edges; succession.document.editRevision++; succession.save();
  }

  function setSideFocus(change: string | undefined | ((current: string | undefined) => string | undefined)) {
    const next = typeof change === 'function' ? change(succession.document.focus) : change;
    if (sharedWindow) {
      // Restoring children can change the selected view before React renders the new layout.
      const current = windowWorkspace.readWindow();
      const view = next && current?.views.find(view => view.binding && succession.ensureWindowView(current.id, view.id, view.binding).id === next);
      if (view && view.id !== current?.selectedViewId) windowWorkspace.authority?.operate({ type: 'view.select', viewId: view.id });
      return;
    }
    if (next === succession.document.focus) return;
    succession.document.focus = next; succession.document.editRevision++; succession.save();
  }

  function setSideAnchor(change: string | undefined | ((current: string | undefined) => string | undefined)) {
    const next = typeof change === 'function' ? change(succession.document.anchor) : change;
    if (sharedWindow) return;
    if (next === succession.document.anchor) return;
    succession.document.anchor = next; succession.document.editRevision++; succession.save();
  }

  function navigateSide(key: string | undefined): void {
    setSideAnchor(key);
    setSideFocus(key);
  }

  useEffect(() => {
    if (!windowMode || (compactLayout ? !contextOpen : !pageOpen)) return;
    // The panel content sits in the compact drawer, or on the desktop page.
    const panel = shellRef.current?.querySelector<HTMLElement>(compactLayout ? '#lab-context' : '#lab-sessions-page');
    if (!panel) return;
    const scrollContainer = panel.querySelector<HTMLElement>(compactLayout ? '.lab-sidebar-content' : '.lab-sessions-page-body');
    if (scrollContainer) scrollContainer.scrollTop = 0;
    if (sessionPanel === 'new') panel.querySelector<HTMLElement>('#provider-select')?.focus({ preventScroll: true });
    else if (compactLayout) panel.querySelector<HTMLElement>('.lab-rail-close')?.focus({ preventScroll: true });
    if (!compactLayout) {
      // Opened from inside the Window (Choose session, Change session, the dock's +): the Window is hidden now, so focus
      // would fall to the document; it goes to the page's heading. Opened from the sidebar, focus stays on its entry.
      const active = document.activeElement;
      if (!active || active === document.body || active.closest('#lab-workbench')) sessionsPageTitleRef.current?.focus({ preventScroll: true });
    }
  }, [compactLayout, contextOpen, pageOpen, sessionPanel, windowMode]);
  late.sideSelections = sideSelections;
  late.sideFocus = sideFocus;
  late.sideAnchor = sideAnchor;
  late.ask = ask;
  late.setSideSelections = setSideSelections;
  late.setSideFocus = setSideFocus;
  late.setSideAnchor = setSideAnchor;
  return { ask, sideSessions, sideSelections, sideFocus, sideAnchor, openSideKeys, setSideSelections, setSideFocus, setSideAnchor, navigateSide };
}

export type SideSelectionSlice = ReturnType<typeof useSideSelection>;
