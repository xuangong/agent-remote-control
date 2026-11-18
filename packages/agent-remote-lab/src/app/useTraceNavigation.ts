// Navigation history, the Trace request and attribution navigation.
import { resolveConversationLayout } from '../conversation-layout.js';
import { useEffect, useRef } from 'react';
import { saveLastSession } from '../conversation-recovery.js';
import type { OpenedSession } from '../directory-client.js';
import { useConversationHistory } from '../hooks/useConversationHistory.js';
import { viewKey } from './helpers.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { FocusedAskSlice } from './useFocusedAsk.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { HostAndStackSlice } from './useHostAndStack.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { WindowModeActionsSlice } from './useWindowModeActions.js';
import type { AppInputs } from './types.js';

export function useTraceNavigation(scope: Pick<AppInputs & SessionSuccessionBindingSlice & WorkbenchShellSlice & FocusedAskSlice & ViewSessionStateSlice & ActiveSessionSlice & SessionOpeningSlice & HostAndStackSlice & SideSelectionSlice & PanelsAndShortcutsSlice & WorkbenchRecordsSlice & SideNavigationSlice & WindowModeActionsSlice, 'activeAgentId' | 'addressSession' | 'baseUrl' | 'compositionProtected' | 'forkStore' | 'initialState' | 'letterRequest' | 'navigateAttribution' | 'navigateSide' | 'nextSideRequest' | 'openSession' | 'revealSession' | 'sessionEntries' | 'setLetterReveals' | 'setSideSelections' | 'setTraceNavigation' | 'sharedWindow' | 'showView' | 'sideAnchor' | 'sideFocus' | 'sideSelections' | 'stackPath' | 'stackRoot' | 'state' | 'succession' | 'traceNavigation' | 'traceRequestCounter' | 'visibleStackRoot' | 'windowMode' | 'windowWorkspace'>) {
  const { activeAgentId, addressSession, baseUrl, compositionProtected, forkStore, initialState, letterRequest, navigateAttribution, navigateSide, nextSideRequest, openSession, revealSession, sessionEntries, setLetterReveals, setSideSelections, setTraceNavigation, sharedWindow, showView, sideAnchor, sideFocus, sideSelections, stackPath, stackRoot, state, succession, traceNavigation, traceRequestCounter, visibleStackRoot, windowMode, windowWorkspace } = scope;


  const navigationIntent = succession.navigationIntent;

  const navigationSession = !windowMode || windowWorkspace.unavailable ? undefined : succession.active ? (succession.binding ? addressSession : succession.desired?.roleKey ? succession.selected : undefined) : addressSession;

  const shareSession = navigationSession ?? (succession.active ? succession.selected : undefined);

  const conversationHistory = useConversationHistory(succession.discovering || navigationIntent.sessionIntent === 'history' && !succession.binding || compositionProtected && !succession.selected ? undefined : navigationSession, sessionEntries, (session, intent, keepOriginal, layout) => {
    const view = intent === 'history' ? undefined : resolveConversationLayout(succession.document, layout);
    if (!windowMode) return Promise.resolve(false);
    return openSession(view?.primary ?? session, undefined, undefined, false,
      view ? () => resolveConversationLayout(succession.document, layout) : undefined, intent, keepOriginal, view?.primarySlot);
  }, navigationIntent.sessionIntent, navigationIntent.keepOriginal, { scope: baseUrl, windowId: sharedWindow?.id, layout: visibleStackRoot && navigationIntent.sessionIntent !== 'history' ? {
    primarySlot: viewKey(visibleStackRoot), selections: Object.fromEntries(stackPath.map(session => [viewKey(session), sideSelections[viewKey(session)] ?? null])),
    focus: sideFocus, anchor: sideAnchor, address: addressSession ? viewKey(addressSession) : undefined,
  } : undefined });

  useEffect(() => {
    if (!succession.discovering && (navigationIntent.sessionIntent !== 'history' || succession.binding) && (!compositionProtected || succession.selected) && navigationSession && !initialState) saveLastSession(baseUrl, { ...navigationSession, hostId: navigationSession.hostId ?? 'local', ...navigationIntent });
  }, [baseUrl, compositionProtected, navigationSession?.agentId, navigationSession?.hostId, navigationSession?.providerId, navigationSession?.nativeSessionId, navigationIntent, succession.discovering, initialState]);

  const activeCompositionLayout = JSON.stringify([sideSelections, sideFocus, sideAnchor, stackPath.map(viewKey)]);

  useEffect(() => { if (windowMode && !windowWorkspace.unavailable && !sharedWindow && succession.active && !succession.discovering) succession.captureLayout(); }, [activeCompositionLayout, windowWorkspace.unavailable, succession.discovering, succession.layoutRevision, windowMode]);

  const traceScope = JSON.stringify([state?.agent?.id, state?.timeline.epoch]);

  const traceRequest = traceNavigation?.scope === traceScope ? traceNavigation : undefined;

  useEffect(() => {
    setTraceNavigation(previous => previous?.scope === traceScope ? previous : undefined);
  }, [traceScope]);

  function inspectTimelineEntry(key: string, view: 'workbench' | 'trace') {
    if (activeAgentId) setLetterReveals(values => { const next = { ...values }; delete next[activeAgentId]; return next; });
    setTraceNavigation({ scope: traceScope, key, view, requestId: ++traceRequestCounter.current });
    if (view === 'workbench' && stackRoot) revealSession(stackRoot);
    showView(view);
  }


  const navigateAttributionRef = useRef(navigateAttribution);
 navigateAttributionRef.current = navigateAttribution;

  function closeSide(session: OpenedSession): void {
    letterRequest.current?.abort();
    const record = forkStore.find(session);
    const source = stackPath.find(candidate => sideSelections[viewKey(candidate)] === viewKey(session));
    if (!source) return;
    nextSideRequest(source);
    setSideSelections((current) => ({ ...current, [viewKey(source)]: null }));
    navigateSide(viewKey(source));
  }
  return { navigationIntent, shareSession, conversationHistory, traceScope, traceRequest, inspectTimelineEntry, navigateAttributionRef, closeSide };
}

export type TraceNavigationSlice = ReturnType<typeof useTraceNavigation>;
