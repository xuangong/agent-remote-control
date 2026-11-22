// The provider catalog, replica state, Team roster, missing sessions and the live budget.
import { useLiveBudget } from '../kernel/useLiveBudget.js';
import type { Team, AgentProviderDescriptor } from '@orchardworks/agent-remote-protocol';
import { remoteSessionState, type RemoteSessionState, type AgentReplicaState } from '@orchardworks/agent-client';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { CompositionDocument } from '../kernel/session-composition-model.js';
import type { OpenedSession } from '../kernel/directory-client.js';
import { sessionKey } from '../kernel/session-tree.js';
import type { QuestionDraft } from '@orchardworks/agent-client-web/react';
import type { ProviderCatalogStatus } from '../features/sessions/ProviderSessionControls.js';
import type { RequestedSessionSlice } from './useRequestedSession.js';
import type { ConversationConnectionsSlice } from './useConversationConnections.js';
import type { WorkbenchShellSlice } from './useWorkbenchShell.js';
import type { AppInputs } from './types.js';

export function useProviderState(scope: Pick<AppInputs & RequestedSessionSlice & ConversationConnectionsSlice & WorkbenchShellSlice, 'baseUrl' | 'cachedState' | 'initialProviderName' | 'initialSessionStatus' | 'initialState' | 'messageDrafts' | 'requested' | 'windowMode'>) {
  const { baseUrl, cachedState, initialProviderName, initialSessionStatus, initialState, messageDrafts, requested, windowMode } = scope;

  const [providers, setProviders] = useState<readonly AgentProviderDescriptor[]>([]);

  const [localProviderId, setLocalProviderId] = useState('');

  const [createPlanning, setCreatePlanning] = useState(false);

  const [questionDrafts, setQuestionDrafts] = useState<Readonly<Record<string, Readonly<Record<string, QuestionDraft>>>>>({});

  const [providerName, setProviderName] = useState(initialProviderName);

  const [catalogStatus, setCatalogStatus] = useState<ProviderCatalogStatus>(initialState ? 'ready' : 'loading');

  const [catalogError, setCatalogError] = useState<string>();

  const [storedState, setState] = useState<AgentReplicaState | undefined>(initialState);

  const [storedSessionState, setSessionState] = useState<RemoteSessionState>(() => remoteSessionState(initialState, initialSessionStatus));

  const cachedSessionState = useMemo(() => cachedState ? remoteSessionState(cachedState, 'connecting') : undefined, [cachedState]);

  const draftStores = useMemo(() => new Map([[baseUrl, messageDrafts]]), [baseUrl, messageDrafts]);

  const [teamRoster, setTeamRoster] = useState<{ baseUrl: string; teams: Team[] }>();

  const teamRosterRef = useRef(teamRoster);
 teamRosterRef.current = teamRoster;

  // An explicit Window restores its own bindings; session parameters may describe a pane that was closed.
  const [initialSession] = useState(() => initialState || !windowMode || new URLSearchParams(window.location.search).has('window') ? undefined : requested.target);

  // Sessions the Host confirmed missing during this page's lifetime. Their views show as empty instead of reopening them;
  // the Window keeps the reference until the view holds another session or closes, so a later page load checks again.
  const [missingSessions, setMissingSessions] = useState<ReadonlySet<string>>(() => new Set());

  const markSessionMissing = useCallback((session: Pick<OpenedSession, 'hostId' | 'providerId' | 'nativeSessionId'>) => {
    const key = sessionKey(session);
    setMissingSessions(current => current.has(key) ? current : new Set([...current, key]));
  }, []);

  const liveConnections = useLiveBudget(baseUrl);

  /** Whether a slot shows a sleeping bot, which nothing attaches until it wakes (set once the Window workspace exists). */
  const asleepSlot = useRef<(slotId: string, document: CompositionDocument) => boolean>(() => false);
  return { providers, setProviders, localProviderId, setLocalProviderId, createPlanning, setCreatePlanning, questionDrafts, setQuestionDrafts, providerName, setProviderName, catalogStatus, setCatalogStatus, catalogError, setCatalogError, storedState, setState, storedSessionState, setSessionState, cachedSessionState, draftStores, teamRoster, setTeamRoster, teamRosterRef, initialSession, missingSessions, markSessionMissing, liveConnections, asleepSlot };
}

export type ProviderStateSlice = ReturnType<typeof useProviderState>;
