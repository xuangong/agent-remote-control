// Title projection, native titles, prompt edit migrations and favorites recovery.
import { confirmTitle, groupProjectionTitles, retitleSessions, titledSessions as titledSessionsOf, windowProjectionTitles } from '../features/sessions/session-titles.js';
import { rekeySelections, swapKey } from '../features/windows/side-layout.js';
import { windowTitleEdits } from '../features/windows/window-titles.js';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { readPromptEditReservation, finishPromptEditReservation, type PromptEditReservation } from '../conversation/prompt-edit-intent.js';
import { useSessionMigrations } from '../hooks/useSessionMigrations.js';
import type { StarInput } from '../features/sessions/session-stars-client.js';
import { sessionConnectionFailure } from '../kernel/SessionConnectionNotice.js';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { SessionDirectoryClient, type OpenedSession } from '../kernel/directory-client.js';
import { useNativeTitles } from '../features/sessions/useNativeTitles.js';
import { sessionKey } from '../kernel/session-tree.js';
import { viewKey } from './helpers.js';
import type { SessionSuccessionBindingSlice } from './useSessionSuccessionBinding.js';
import type { ViewSessionStateSlice } from './useViewSessionState.js';
import type { AttentionAndRosterSlice } from './useAttentionAndRoster.js';
import type { ProviderCreationSlice } from './useProviderCreation.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { WorkbenchRecordsSlice } from './useWorkbenchRecords.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { DocksAndBotSelectionSlice } from './useDocksAndBotSelection.js';
import type { ActiveSessionSlice } from './useActiveSession.js';
import type { WindowViewActionsSlice } from './useWindowViewActions.js';
import type { SideNavigationSlice } from './useSideNavigation.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { PanelsAndShortcutsSlice } from './usePanelsAndShortcuts.js';
import type { SideSelectionSlice } from './useSideSelection.js';
import type { SessionOpeningSlice } from './useSessionOpening.js';
import type { AppInputs } from './types.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function useSessionTitles(scope: Pick<AppInputs & SessionSuccessionBindingSlice & ViewSessionStateSlice & AttentionAndRosterSlice & ProviderCreationSlice & RequestedSessionSlice & WorkbenchRecordsSlice & WorkbenchShellSlice & DocksAndBotSelectionSlice & ActiveSessionSlice & WindowViewActionsSlice & SideNavigationSlice & ConversationConnectionsSlice & PanelsAndShortcutsSlice & SideSelectionSlice & SessionOpeningSlice, 'accessReady' | 'activeOpened' | 'activeView' | 'baseUrl' | 'confirmedTitles' | 'editWindow' | 'favorites' | 'forkStore' | 'openSession' | 'openWindows' | 'rememberSession' | 'selectedBot' | 'selectedBotStatus' | 'sessionEntries' | 'setConfirmedTitleState' | 'setDetachedSideRoot' | 'setDirectoryRevision' | 'setOpenedSessions' | 'setSessionNotice' | 'setSideAnchor' | 'setSideFocus' | 'setSideSelections' | 'setSideSessions' | 'sharedWindow' | 'sideActivity' | 'sideSessions' | 'state' | 'succession' | 'supportingRailOpen' | 'trackEntryId' | 'trackedViews' | 'tracking' | 'transitionRef' | 'transport' | 'userScoped' | 'viewSession' | 'windowMode' | 'windowWorkspace'>) {
  const t = useTranslate();
  const { accessReady, activeOpened, activeView, baseUrl, confirmedTitles, editWindow, favorites, forkStore, openSession, openWindows, rememberSession, selectedBot, selectedBotStatus, sessionEntries, setConfirmedTitleState, setDetachedSideRoot, setDirectoryRevision, setOpenedSessions, setSessionNotice, setSideAnchor, setSideFocus, setSideSelections, setSideSessions, sharedWindow, sideActivity, sideSessions, state, succession, supportingRailOpen, trackEntryId, trackedViews, tracking, transitionRef, transport, userScoped, viewSession, windowMode, windowWorkspace } = scope;

  useEffect(() => { if (succession.observerReady) trackedViews.retain(tracking.sessions.map(trackEntryId)); }, [trackedViews, tracking.sessions, succession.observerReady]);

  const applySessionTitle = useCallback((session: StarInput) => {
    setConfirmedTitleState(current => confirmTitle(current, baseUrl, sessionKey(session), session.title));
    const update = (items: OpenedSession[]) => retitleSessions(items, sessionKey, sessionKey(session), session.title) as OpenedSession[];
    succession.updateTitles([session]);
    setOpenedSessions(update); setSideSessions(update); tracking.rename(session);
  }, [baseUrl, tracking.rename, succession.document]);

  // In Bot mode the selected bot's group is named like the open Window: its sessions, and the group itself while it is named after its first session.
  const titledBotGroup = !windowMode ? selectedBot.group : undefined;

  // Window views name sessions that need not be open on this page; Ask and Team views name their own.
  const titledSessions = useMemo(() => titledSessionsOf(sessionEntries, [...sharedWindow?.views ?? [], ...titledBotGroup?.window.views ?? []]),
    [sessionEntries, sharedWindow?.views, titledBotGroup?.window.views]);

  useNativeTitles({ entries: titledSessions, confirmed: confirmedTitles, apply: applySessionTitle,
    // A session's native title can appear once a turn ends, so a change in the sessions' activity asks again.
    trigger: `${state?.agent?.status ?? ''}|${Object.values(sideActivity).join(',')}|${selectedBotStatus ?? ''}`,
    describe: (hostId, providerId, nativeSessionId, signal) => new SessionDirectoryClient(baseUrl, undefined, hostId).nativeTitle(providerId, nativeSessionId, signal) });

  const titleProjection = useRef<ReadonlyMap<string, string>>();

  useEffect(() => {
    // A cached Window is renamed only once the service confirms it.
    const titles = windowProjectionTitles({ hasWindow: !!sharedWindow, provisional: windowWorkspace.provisional, confirmed: confirmedTitles, applied: titleProjection.current });
    if (!sharedWindow || !titles) return;
    titleProjection.current = titles;
    try {
      for (const edit of windowTitleEdits(sharedWindow, titles)) {
        // A view given another session meanwhile keeps it; that is not a failure to report.
        if (edit.type === 'view.bind') void windowWorkspace.operate(edit).catch(() => {});
        else editWindow(edit);
      }
    } catch (error) { setSessionNotice(sessionConnectionFailure(error, false, t)); }
  }, [sharedWindow?.id, sharedWindow?.revision, windowWorkspace.provisional, confirmedTitles]);

  const botTitleProjection = useRef<{ titles?: ReadonlyMap<string, string>; revision?: string }>({});

  useEffect(() => {
    const revision = JSON.stringify([titledBotGroup?.window.id, titledBotGroup?.window.revision]);
    const titles = groupProjectionTitles({ hasGroup: !!titledBotGroup, confirmed: confirmedTitles, revision, last: botTitleProjection.current });
    if (!titledBotGroup || !titles) return;
    botTitleProjection.current = { titles, revision };
    const edits = windowTitleEdits(titledBotGroup.window, titles);
    // A view given another session meanwhile keeps it, and a newer title wins: neither is a failure to report.
    if (edits.length) void windowWorkspace.operateGroup(titledBotGroup.window.id, edits.length === 1 ? edits[0]! : { type: 'batch', operations: edits }).catch(() => {});
  }, [titledBotGroup?.window.id, titledBotGroup?.window.revision, confirmedTitles]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = transport.onSessionTitle?.(session => {
      applySessionTitle(session);
      clearTimeout(timer); timer = setTimeout(() => setDirectoryRevision(value => value + 1), 100);
    });
    return () => { remove?.(); clearTimeout(timer); };
  }, [transport, applySessionTitle]);

  const promptEditReservation = useMemo<{ current: PromptEditReservation | undefined }>(() => ({ current: readPromptEditReservation(baseUrl) }), [baseUrl]);

  const promptMigrations = useSessionMigrations({ baseUrl, enabled: userScoped && accessReady, transport, current: activeOpened, loaded: openWindows,
    blocked: () => transitionRef.current || activeView !== 'workbench' || supportingRailOpen,
    needsPromptRestore: migration => promptEditReservation.current?.operationId === migration.id && !promptEditReservation.current.restored,
    stay: migration => {
      if (promptEditReservation.current?.operationId !== migration.id) return;
      finishPromptEditReservation(baseUrl, migration.id);
      promptEditReservation.current = undefined;
    },
    apply: migration => tracking.replace(migration),
    refreshReferences: () => { void favorites.refresh(); },
    follow: async (session, source) => {
      if (!sideSessions.some(item => sessionKey(item) === sessionKey(source))) return openSession(session);
      const result = await new SessionDirectoryClient(baseUrl, undefined, session.hostId).attach(session.providerId, session.nativeSessionId);
      const previousView = sideSessions.find(item => sessionKey(item) === sessionKey(source))!;
      const target = viewSession({ ...session, agentId: result.agentId });
      const fromId = viewKey(previousView), toId = viewKey(target);
      const fork = forkStore.findNavigationTarget(source);
      if (fork) forkStore.followEditedSide(fork.id, source, target);
      rememberSession(target);
      setSideSessions(values => values.map(item => sessionKey(item) === sessionKey(source) ? target : item));
      setSideSelections(values => rekeySelections(values, fromId, toId));
      setSideFocus(value => swapKey(value, fromId, toId));
      setSideAnchor(value => swapKey(value, fromId, toId));
      setDetachedSideRoot(value => swapKey(value, fromId, toId));
      return true;
    },
  });

  const recoverTrackingReferences = useRef(promptMigrations.refresh);

  recoverTrackingReferences.current = promptMigrations.refresh;

  useEffect(() => {
    succession.observeFavorites(favorites);
  }, [favorites.scope, favorites.ready, favorites.successionProgress, succession.discovering]);

  useEffect(() => {
    if (!favorites.ready || !tracking.sessions.some(session => !favorites.stars.some(star => sessionKey(star) === sessionKey(session)))) return;
    let canceled = false;
    // Favorites and fork broadcasts can arrive in either order. Recover replacements
    // before interpreting a missing bookmark as a removal.
    void recoverTrackingReferences.current().then(recovered => {
      if (recovered && !canceled && succession.observerReady) tracking.reconcileFavorites({ ...favorites, stars: [...favorites.stars, ...tracking.sessions.filter(session => !succession.canPrune(favorites, session))] });
    });
    return () => { canceled = true; };
  }, [favorites.scope, favorites.ready, favorites.stars, favorites.successionProgress, tracking.sessions, tracking.reconcileFavorites, succession.observerReady]);
  return { applySessionTitle, promptMigrations };
}

export type SessionTitlesSlice = ReturnType<typeof useSessionTitles>;
