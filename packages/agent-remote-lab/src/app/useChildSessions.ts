import { besideChildSession, childOpensBeside, childRequestCurrent, directParentOf, knownChildOf, replacingChildSession } from '../features/session-links/child-session-plan.js';
import { sessionConnectionFailure } from '../kernel/SessionConnectionNotice.js';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import { SessionDirectoryClient, type OpenedSession } from '../kernel/directory-client.js';
import { sessionKey } from '../kernel/session-tree.js';
import type { AgentChildSessionView } from '@orchardworks/agent-client-web/react';
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
import type { OpenWindowsSlice } from './useOpenWindows.js';
import type { SideSessionsSlice } from './useSideSessions.js';
import { useTranslate } from '@orchardworks/agent-client-web/react';

// Opening a subagent (child) session of a parent.
export function useChildSessions(scope: Pick<AppInputs & WorkbenchRecordsSlice & FocusedAskSlice & SessionOpeningSlice & SideSelectionSlice & SessionSuccessionBindingSlice & ViewSessionStateSlice & WindowModeActionsSlice & HostAndStackSlice & WorkbenchShellSlice & ConversationConnectionsSlice & ActiveSessionSlice & PanelsAndShortcutsSlice & DocksAndBotSelectionSlice & WindowViewActionsSlice & RequestedSessionSlice & ViewTargetsSlice & ProviderCreationSlice & OpenWindowsSlice & SideSessionsSlice, 'activeOpened' | 'assertSourceCurrent' | 'baseUrl' | 'compactLayoutRef' | 'connections' | 'directory' | 'letterRequest' | 'navigationGeneration' | 'nextSideRequest' | 'openSession' | 'rememberSession' | 'selectedHost' | 'sessionEntries' | 'setFailure' | 'setSessionNotice' | 'setTransitioning' | 'sharedWindow' | 'sideRequestKey' | 'sideRequests' | 'stackPath' | 'state' | 'transitionRef' | 'viewSession' | 'windowSession' | 'openWindows' | 'selectSide'>) {
  const t = useTranslate();
  const { activeOpened, assertSourceCurrent, baseUrl, compactLayoutRef, connections, directory, letterRequest, navigationGeneration, nextSideRequest, openSession, rememberSession, selectedHost, sessionEntries, setFailure, setSessionNotice, setTransitioning, sharedWindow, sideRequestKey, sideRequests, stackPath, state, transitionRef, viewSession, windowSession, openWindows, selectSide } = scope;

  async function openChildSession(child: AgentChildSessionView, source?: OpenedSession, sourceState?: AgentReplicaState): Promise<void> {
    letterRequest.current?.abort();
    const parentState = sourceState ?? state;
    const parentId = parentState?.agent?.runtimeInfo.sessionId;
    const parentAgent = parentState?.agent;
    if (!parentAgent || !parentId || !directory) throw new Error(t('sessions.children.parentUnavailable'));
    let origin: OpenedSession = viewSession(source ?? activeOpened ?? { agentId: parentAgent.id, providerId: parentAgent.providerId, nativeSessionId: parentId, hostId: 'local', title: t('sessions.fallbackTitle.parent') });
    assertSourceCurrent(origin);
    const known = knownChildOf(sessionEntries, child.nativeSessionId, origin);
    if (childOpensBeside({ sharedWindow: !!sharedWindow, compact: !!compactLayoutRef.current })) {
      origin = viewSession(directParentOf(origin, known, openWindows));
      const cached = connections.find({ ...origin, nativeSessionId: child.nativeSessionId });
      const showChild = async (opened: OpenedSession) => {
        if (!stackPath.some(session => sessionKey(session) === sessionKey(origin)) && !await openSession(origin)) {
          throw new Error(t('sessions.children.parentOpenFailed'));
        }
        selectSide(origin, opened);
      };
      if (cached) {
        await showChild(besideChildSession(child, origin, cached.agentId));
        return;
      }
      const generation = navigationGeneration.current;
      const request = nextSideRequest(origin);
      const target = (origin.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, origin.hostId);
      try {
        const result = await target.attachChild(origin.providerId, origin.nativeSessionId, child.nativeSessionId);
        if (!childRequestCurrent({ generation, side: { issued: request, latest: sideRequests.current.get(sideRequestKey(origin)) } }, navigationGeneration.current)) return;
        assertSourceCurrent(origin);
        const opened = besideChildSession(child, origin, result.agentId);
        rememberSession(origin); rememberSession(opened); setSessionNotice(undefined);
        await showChild(opened);
      } catch (error) { setSessionNotice(sessionConnectionFailure(error, false, t)); throw error; }
      return;
    }
    const generation = navigationGeneration.current;
    if (transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    setSessionNotice({ tone: 'status', message: t('sessions.children.opening') });
    try {
      const hostId = origin.hostId ?? 'local';
      const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
      const result = await target.attachChild(origin.providerId, known?.parentNativeSessionId ?? origin.nativeSessionId, child.nativeSessionId);
      if (!childRequestCurrent({ generation }, navigationGeneration.current)) return;
      assertSourceCurrent(origin);
      rememberSession(origin);
      const opened = replacingChildSession(child, origin, known, result);
      rememberSession(opened); await windowSession.openAttached(opened);
    } catch (error) {
      if (navigationGeneration.current === generation) setSessionNotice(sessionConnectionFailure(error, false, t));
      throw error;
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  }
  return { openChildSession };
}

export type ChildSessionsSlice = ReturnType<typeof useChildSessions>;
