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
import { localEdges, mergeSides, openSideKeys as openSideKeysOf, sameEdges, selectedEdges, selectionSteps, sharedFamilySides as sharedFamilySidesOf } from '../state/side-layout.js';
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

  const availableSides = mergeSides(storedSideSessions, projectedLayout?.sides, viewKey) as OpenedSession[];

  /** Every view attached in the selected primary family, in Window order, once its session is known. */
  function sharedFamilySides(): OpenedSession[] {
    const known = new Map(availableSides.map(session => [viewKey(session), session]));
    return sharedFamilySidesOf(sharedWindow?.views ?? [], {
      inFamily: viewId => !!sharedFamily?.has(viewId), slotOf: viewId => sharedSlots?.get(viewId), known: slotId => known.get(slotId),
      mounted: viewId => mountedViewSessions[viewId], sessionOfSlot: compositionSession, sessionKey, bindingKey: sessionKey,
    });
  }

  const sideSessions = windowSession.empty ? [] : sharedWindow ? sharedFamilySides() : availableSides;

  const sideSelections = useMemo<SideSelections>(() => selectedEdges(succession.document.edges), [succession.document, succession.document.editRevision]);

  const sideFocus = succession.document.focus, sideAnchor = succession.document.anchor;

  /** Sessions shown beside a source: each view attached to it in a shared Window, otherwise its selected Side. */
  function openSideKeys(sourceId: string): string[] {
    return openSideKeysOf(sourceId, {
      shared: !!sharedWindow,
      attachedKeys: id => {
        const source = sharedViewForSlot(id);
        return source ? sharedWindow!.views.flatMap(view => view.attachedTo === source.id && view.binding ? [sessionKey(view.binding)] : []) : [];
      },
      selectedKey: id => {
        const slot = succession.document.slots.find(slot => slot.id === sideSelections[id]);
        return slot ? sessionKey(compositionSelection(slot)) : undefined;
      },
    });
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
    const current = selectedEdges(succession.document.edges);
    const next = typeof change === 'function' ? change(current) : change;
    if (sharedWindow) {
      const operations: WindowEdit[] = [];
      const steps = selectionSteps(current, next, {
        sourceView: sharedViewOf, viewOfSlot: sharedViewForSlot,
        slotExists: slotId => succession.document.slots.some(slot => slot.id === slotId),
        slotOwned: slotId => !!succession.document.windowBindings?.some(entry => entry.slotId === slotId),
      });
      for (const step of steps) {
        if (step.type === 'select') { operations.push({ type: 'view.select', viewId: step.viewId }); continue; }
        // The source keeps the views already attached to it; the selection only adds or focuses one.
        const target = succession.document.slots.find(slot => slot.id === step.slotId)!;
        const view = { ...createWindowView(crypto.randomUUID(), windowSessionBinding(compositionSelection(target)), 'attached'), attachedTo: step.sourceViewId };
        if (step.owned) succession.ensureWindowView(sharedWindow.id, view.id, view.binding!);
        else succession.bindWindowView(sharedWindow.id, view.id, view.binding!, target.id);
        operations.push({ type: 'view.create', view }, { type: 'view.select', viewId: view.id });
      }
      if (operations.length) windowWorkspace.authority?.operate({ type: 'batch', operations });
      return;
    }
    const edges = localEdges(next);
    if (sameEdges(edges, succession.document.edges)) return;
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
