import { WindowSessionBridgeContext } from './window-session-bridge-context.js';
import { parseWindowFeature } from './window-feature-views.js';
import { useWindowSessionBridge } from './hooks/useWindowSessionBridge.js';
import { createWindowView, primaryWindowViews, windowPrimaryViewId, type WindowEdit } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from './window-workspace.js';
import { useWindowWorkspace } from './hooks/useWindowWorkspace.js';
import { useWindowSessionRetention } from './hooks/useWindowSessionRetention.js';
import { WindowLayoutContext, WindowPresentationContext } from './window-workspace-context.js';
import { WindowWorkspaces } from './components/WindowWorkspaces.js';
import { WindowMenu } from './components/WindowMenu.js';
import { useWindowVisibility } from './hooks/useWindowVisibility.js';
import { teamViewTarget } from './team-view-binding.js';
import { SessionViewOperationsContext } from './session-view-operations.js';
import { SessionDescriptionsContext } from './session-description-context.js';
import { describeSession } from './session-description.js';
import { attributionWindowOperation } from './session-attribution-navigation.js';
import { sideWindowOperation } from './window-side-navigation.js';
import type { SessionAttribution } from '@orchardworks/agent-remote-web';
import { labSessionSuccessionDirectory, type SessionSuccessionDirectory } from './session-succession-directory.js';
import { TeamViewScope, useTeamVisibility } from './hooks/useTeamVisibility.js';
import { teamLayoutTargets } from './team-layout.js';
import { TeamMenu } from './components/TeamMenu.js';
import { TeamGatherButton } from './components/TeamGatherButton.js';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { useSessionWindows } from './hooks/useSessionWindows.js';
import { SessionWindow } from './components/SessionWindow.js';
import { SessionFamily, type FamilySessionPresentationContext } from './components/SessionFamily.js';
import { PrimarySessionFamily } from './components/PrimarySessionFamily.js';
import { AskButton } from './components/AskButton.js';
import { AskViewScope, useAskVisibility } from './hooks/useAskVisibility.js';
import { isAskSelected, resolveAskPresentation } from './ask-presentation.js';
import { resolveConversationLayout } from './conversation-layout.js';
import { communicationResolver, communicationDirection, loadSessionCommunication, waitForCommunicationSession, type CommunicationSnapshot } from './session-communication.js';
import { CommunicationNavigationContext, type CommunicationNavigation } from '@orchardworks/agent-remote-web/react';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { SessionEntry } from './session-tree.js';
import { useSessionRelations } from './hooks/useSessionRelations.js';
import { sessionViewNavigation, type SessionViewNavigation, type SessionViewNavigationActions } from './session-view-navigation.js';
import { remoteSessionState, type RemoteSessionState, sessionHandoffScope, SessionHandoffRejectedError, type SessionHandoffState } from '@orchardworks/agent-remote-web';
import {SessionControlNotice, type TakeControlOptions} from './components/SessionControlNotice.js';
import type {NativeSessionOwner} from '@orchardworks/agent-remote-protocol';
import { ConversationConnections, ConversationConnectionScope } from './conversation-connections.js';
import { CachePrivacySettings } from './components/CachePrivacySettings.js';
import { LayoutDiagnosticsSettings } from './components/LayoutDiagnosticsSettings.js';
import { stopLayoutDiagnostics } from './layout-diagnostics.js';
import { conversationLocalStorage, conversationSessionStorage } from './conversation-storage.js';
import { WorkspaceReady, workspaceFetch, workspaceSocket, readWorkspaceAccess } from './workspace-access.js';
import { readWorkspaceSnapshot } from './workspace-cache.js';
import { ControllerUpdates } from './components/ControllerUpdates.js';
import { readPromptEditReservation, finishPromptEditReservation, type PromptEditReservation } from './prompt-edit-intent.js';
import { useSessionMigrations } from './hooks/useSessionMigrations.js';
import { ReplicaCache } from './replica-cache.js';
import { DraftStore } from './draft-store.js';
import { useSessionStars } from './hooks/useSessionStars.js';
import type { StarInput } from './session-stars-client.js';
import { loadSuccessionIntent, saveSuccessionIntent, clearSuccessionIntent, type SessionSuccessionIntent } from './session-succession-intent.js';
import { SessionSuccessionDialog } from './components/SessionSuccessionDialog.js';
import { SessionSuccessionHistory } from './components/SessionSuccessionHistory.js';
import { useSuccessionContext } from './hooks/useSuccessionContext.js';
import { handoffCommand, handoffProvider } from './handoff-command.js';
import { RenameSessionDialog } from './components/favorites/RenameSessionDialog.js';
import { SessionTitle } from './components/SessionTitle.js';
import { useSessionCatchUp } from './hooks/useSessionCatchUp.js';
import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { TrackViewScope, useSessionAttention } from './hooks/useSessionAttention.js';
import { TpmViewScope, useTpmVisibility } from './hooks/useTpmVisibility.js';
import { useTpmWork, type TpmService } from './hooks/useTpmWork.js';
import { useTpmMainSessions } from './hooks/useTpmMainSessions.js';
import { tpmMainTarget } from './tpm-main-sessions.js';
import { TpmMenu } from './components/TpmMenu.js';
import { TpmWorkspace } from './components/TpmWorkspace.js';
import { useSessionSuccession } from './hooks/useSessionSuccession.js';
import { useSessionTracking } from './hooks/useSessionTracking.js';
import { FavoritesHeading, FavoritesList, FavoritesMenu, StarButton } from './components/SessionFavorites.js';
import { SessionTrackingMenu } from './components/SessionTrackingMenu.js';
import { TrackedSessionViews, unlinkSideView, type TrackedSessionView } from './tracked-session-views.js';
import { ToastProvider, useFeedbackToast, useToast } from './components/Toast.js';
import { SessionConnectionNotice, sessionConnectionFailure, type SessionConnectionMessage } from './components/SessionConnectionNotice.js';
import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { readControllerLocation, type ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { MobileDisplaySettings } from './components/MobileDisplaySettings.js';
import type { ScannedSession } from './session-transfer.js';
import { SessionLink, SessionTransferDialog } from './components/SessionLink.js';
import { SessionHeadingActions } from './components/SessionHeadingActions.js';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@orchardworks/agent-remote-protocol';
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type {
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentProviderDescriptor,
  AgentSessionConfig,
  AgentSessionResponse,
  ResourceBinding,
  WindowSessionBinding,
} from '@orchardworks/agent-remote-protocol';
import {
  AgentReplica,
  RemoteOperationError,
  HttpWebSocketTransport,
  RemoteSessionClient,
  HttpPreviewClient,
  type AgentReplicaState,
  type RemoteAgentTransport,
  type RemoteSessionStatus,
} from '@orchardworks/agent-remote-web';
import { ReadingPositions, RecoveryScope, readLastSession, saveLastSession } from './conversation-recovery.js';
import { compositionSession, compositionSelection, type StoreOwner } from './session-composition.js';
import { useRemoteHosts } from './hooks/useRemoteHosts.js';
import { useVisualViewport } from './hooks/useVisualViewport.js';
import { HostPairing, type HostPairingService, type RemoteHost } from './components/HostPairing.js';
import { DirectoryError, RemoteHostClient, SessionDirectoryClient, type CreateSessionOptions, type OpenedSession, type SessionSummary } from './directory-client.js';
import { SessionConfiguration, SessionDirectory } from './components/SessionDirectory.js';
import { useSessionEntries } from './hooks/useSessionEntries.js';
import { readCurrentConversationLayout, useConversationHistory } from './hooks/useConversationHistory.js';
import { sessionKey, sessionRootKey } from './session-tree.js';
import { ViewOptions } from './components/ViewOptions.js';
import { PreviewProvider, PreviewWorkspace, type AgentChildSessionView } from '@orchardworks/agent-remote-web/react';
import { ChatSessionManager } from './components/ChatSessionManager.js';
import { LabWorkbench, type LabWorkbenchActions } from './components/LabWorkbench.js';
import { SideConversation } from './components/SideConversation.js';
import { SessionAsk } from './components/SessionAsk.js';
import { useAskConversations } from './hooks/useAskConversations.js';
import { ForkEntries, ForkReference } from './components/ForkReference.js';
import { sideNavigationSource, sideNavigationTarget, sideLinkVisible, referenceForkContext, captureForkContext, forkDisplayState, ForkStore, type SessionFork } from './session-forks.js';
import { CollapsedConversations } from './components/CollapsedConversations.js';
import { MinimizeMainSession, SessionDockProvider, SessionDockRail } from './components/SessionDock.js';
import { ConversationPane, ConversationSplit } from './components/ConversationSplit.js';
import { expandedSideRange, sidePath, type SideSelections } from './side-tree.js';
import { configureFork, forkActions, forkCommands, sendForkInput } from './fork-actions.js';
import type { QuestionDraft } from '@orchardworks/agent-remote-web/react';
import { ReplicaInspector } from './components/ReplicaInspector.js';
import { ProviderSessionControls, type ProviderCatalogStatus } from './components/ProviderSessionControls.js';
import { RecordedPlaybackControls } from './components/RecordedPlaybackControls.js';
import { SupportingRail } from './components/SupportingRail.js';
import { SidebarResize, useSidebarWidth } from './components/SidebarResize.js';
import { TraceView } from './components/TraceView.js';
import { HostPreviewGroups } from './components/HostPreviewGroups.js';
import { HostVscodeTunnel } from './components/HostVscodeTunnel.js';
import { HttpVscodeTunnelClient, VscodeTunnelScope } from './vscode-tunnel.js';

export interface LabTransport extends RemoteAgentTransport {
  listProviders(): Promise<readonly AgentProviderDescriptor[]>;
  createAgent(agentId: string, providerId: string, config: AgentSessionConfig): Promise<AgentSessionResponse>;
  resumeAgent(agentId: string, persistence: AgentPersistenceHandle): Promise<AgentSessionResponse>;
}

export interface AppActions extends LabWorkbenchActions {
  loadOlder?(): void | Promise<void>;
  retryMessage?(id: string): Promise<void>;
  deleteMessage?(id: string): void;
  sendMessage?(text: string, options?: AgentMessageOptions): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
  respondToInteraction?(requestId: string, response: AgentInteractionResponse): Promise<void>;
  requestResource?(binding: ResourceBinding): Promise<void | ResourceResponseState>;
  resolveResource?(locator: string, sourceLocator?: string): Promise<ResourceBinding>;
  advanceFixture?(): void | Promise<void>;
  rehydrateFixture?(): void | Promise<void>;
  stopReader?(): void | Promise<void>;
}

export interface AppProps {
  baseUrl?: string;
  accountAction?: ReactNode;
  userScoped?: boolean;
  transport?: LabTransport;
  directory?: SessionDirectoryClient;
  hostService?: HostPairingService;
  initialState?: AgentReplicaState;
  initialSessionStatus?: RemoteSessionStatus;
  initialProviderName?: string;
  actions?: AppActions;
  fixtureAction?(agentId: string, action: 'advance' | 'rehydrate' | 'stop-reader'): void | Promise<void>;
}

export function App(props: AppProps) {
  return <ToastProvider><AppContent {...props} /></ToastProvider>;
}

function AppContent({
  baseUrl = window.location.origin,
  transport: injectedTransport,
  directory: injectedDirectory,
  hostService,
  initialState,
  initialSessionStatus = 'idle',
  initialProviderName,
  actions,
  fixtureAction,
  accountAction,
  userScoped = false,
}: AppProps) {
  const accessReady = useContext(WorkspaceReady);
  const [activated, setActivated] = useState(accessReady);
  useEffect(() => { if (accessReady) setActivated(true); }, [accessReady]);
  const accessReadyRef = useRef(accessReady); accessReadyRef.current = accessReady;
  const shellRef = useVisualViewport();
  useEffect(() => () => stopLayoutDiagnostics('unmount'), []);
  const readingPositions = useMemo(() => new ReadingPositions(baseUrl), [baseUrl]);
  const transport = useMemo<LabTransport>(() => injectedTransport
    ?? new HttpWebSocketTransport(baseUrl, { sessionChannels: true, sessionSuccessions: true, fetch: workspaceFetch, webSocketFactory: workspaceSocket }) as LabTransport, [baseUrl, injectedTransport]);
  const mountedTransport = useRef<LabTransport>();
  useEffect(() => {
    mountedTransport.current = transport;
    return () => {
      mountedTransport.current = undefined;
      // StrictMode immediately reuses this transport after its effect cleanup probe.
      if (!injectedTransport) queueMicrotask(() => {
        if (mountedTransport.current !== transport) (transport as HttpWebSocketTransport).dispose();
      });
    };
  }, [transport, injectedTransport]);
  const favorites = useSessionStars(baseUrl, userScoped && accessReady, transport);
  const [renamingSession, setRenamingSession] = useState<{ scope: string; session: StarInput }>();
  const [confirmedTitleState, setConfirmedTitleState] = useState<{ scope: string; titles: ReadonlyMap<string, string> }>();
  const confirmedTitles = confirmedTitleState?.scope === baseUrl ? confirmedTitleState.titles : undefined;
  const withConfirmedTitle = useCallback((session: OpenedSession): OpenedSession => {
    const title = confirmedTitles?.get(sessionKey(session));
    return title !== undefined && title !== session.title ? { ...session, title } : session;
  }, [confirmedTitles]);
  const [requested] = useState<{ target?: ControllerLocation; error?: string }>(() => {
    try {
      const target = readControllerLocation(new URLSearchParams(window.location.search));
      return { target: Object.keys(target).length ? target : readLastSession(baseUrl) };
    }
    catch { return { error: 'Invalid session link.' }; }
  });
  const [initialLayout] = useState(() => readCurrentConversationLayout(baseUrl));
  const [cachedState] = useState(() => {
    const cachedAccess = readWorkspaceAccess();
    return userScoped && cachedAccess && new URL(cachedAccess.basePath, window.location.origin).href === baseUrl
      ? readWorkspaceSnapshot(baseUrl, requested.target) : undefined;
  });
  const requestedHostId = requested.target?.hostId;
  const [selectedHost, setSelectedHost] = useState<RemoteHost>(() => requestedHostId
    ? { id: requestedHostId, name: 'Requested Host', online: false, providers: [], providerId: '' }
    : { id: 'local', name: 'Recorded fixture', online: true });
  const vscodeTunnelClient = useMemo(() => new HttpVscodeTunnelClient(baseUrl), [baseUrl]);
  const hostClient = useMemo(() => hostService ?? new RemoteHostClient(baseUrl), [baseUrl, hostService]);
  const previewClient = useMemo(() => new HttpPreviewClient(baseUrl, workspaceFetch), [baseUrl]);
  const directory = useMemo(() => !activated ? undefined : injectedDirectory ?? (!injectedTransport && !initialState ? new SessionDirectoryClient(baseUrl, undefined, selectedHost.id) : undefined), [baseUrl, injectedDirectory, injectedTransport, initialState, selectedHost.id, activated]);
  const restoredHostSelection = useRef(false);
  const [openedSessionRecords, setOpenedSessions] = useState<OpenedSession[]>(() => directory || cachedState ? readOpenedSessions(baseUrl) : []);
  const openedSessions = useMemo(() => openedSessionRecords.map(withConfirmedTitle), [openedSessionRecords, withConfirmedTitle]);
  const openedSessionsRef = useRef(openedSessions);
  openedSessionsRef.current = openedSessions;
  const forkStore = useMemo(() => new ForkStore(baseUrl), [baseUrl]);
  const [forkRevision, setForkRevision] = useState(0);
  useEffect(() => forkStore.subscribe(() => setForkRevision((value) => value + 1)), [forkStore]);
  const [sideSessionRecords, setSideSessions] = useState<OpenedSession[]>([]);
  const storedSideSessions = useMemo(() => sideSessionRecords.map(withConfirmedTitle), [sideSessionRecords, withConfirmedTitle]);
  const [letterReveals, setLetterReveals] = useState<Record<string, { key: string; requestId: number; align: 'start' }>>({});
  const letterRequest = useRef<AbortController>();
  useEffect(() => () => letterRequest.current?.abort(), [baseUrl, transport]);
  const [sideActivity, setSideActivity] = useState<Record<string, import('@orchardworks/agent-remote-protocol').AgentStatus | undefined>>({});
  const observeSideActivity = useCallback((agentId: string, activity: import('@orchardworks/agent-remote-protocol').AgentStatus | undefined) => {
    setSideActivity(current => current[agentId] === activity ? current : { ...current, [agentId]: activity });
  }, []);
  // An unlinked window stays mounted so drafts, scrolling and subscriptions survive.
  const [detachedSideRoot, setDetachedSideRoot] = useState<string>();
  const appliedUnlinks = useMemo(() => new Map<string, number>(), [forkStore]);
  const toast = useToast();
  function navigateSide(key: string | undefined): void {
    setSideAnchor(key);
    setSideFocus(key);
  }
  const sideRequests = useRef(new Map<string, number>());
  const forkReservation = useRef<{ key: string; record: SessionFork }>();
  const forkBusy = useRef(false);
  const [forkInputStatus, setForkInputStatus] = useState<{ agentId: string; pending: boolean; error?: string }>();
  const [sessionOptions, setSessionOptions] = useState<CreateSessionOptions>({});
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const creationReservation = useRef<{ operationId: string; options: CreateSessionOptions; providerId: string; destination?: { windowId: string; viewId: string; binding: string } }>();
  const [creationLocked, setCreationLocked] = useState(false);
  const { value: catchUp, begin: beginCatchUp, focus: focusCatchUp } = useSessionCatchUp();
  useEffect(() => beginCatchUp(), [baseUrl, transport, beginCatchUp]);
  const replicas = useMemo(() => new ReplicaCache(), [baseUrl, transport]);
  const connections = useMemo(() => new ConversationConnections(transport, baseUrl, (agentId, session) => session ? {
    async resumeNative(owner, options) {
      if (!accessReadyRef.current) throw new SessionHandoffRejectedError('Workspace access is restoring.');
      const target = new SessionDirectoryClient(baseUrl, undefined, session.hostId ?? 'local');
      const result = await target.attach(session.providerId, session.nativeSessionId, options.signal, options.checkOnly ? undefined : owner.generation);
      if (result.agentId !== agentId) throw new Error('Native resume returned a different session binding.');
    },
  } : undefined), [baseUrl, transport]);
  useEffect(() => () => connections.clear(), [connections]);
  const replicaFor = useCallback((agentId: string) => {
    return replicas.obtain(agentId);
  }, [replicas]);
  const [uncertainMutation, setUncertainMutation] = useState(false);
  const messageDrafts = useMemo(() => new DraftStore(baseUrl), [baseUrl]);
  const clientRef = useRef<RemoteSessionClient>();
  const primaryBinding = useRef<{ baseUrl: string; transport: LabTransport; agentId: string }>();
  const replicaRef = useRef<AgentReplica>();
  const unsubscribeReplicaRef = useRef<() => void>();
  const transitionRef = useRef(false);
  const navigationGeneration = useRef(0);
  const pendingViewRestore = useRef<{ scope: string; transport: LabTransport; slotId: string; read(): TrackedSessionView | undefined }>();
  const providerRequestGenerationRef = useRef(0);
  const workbenchTabRef = useRef<HTMLButtonElement>(null);
  const traceTabRef = useRef<HTMLButtonElement>(null);
  const sessionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [contextFromSessions, setContextFromSessions] = useState(true);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sessionPanel, setSessionPanel] = useState<'list' | 'favorites' | 'new' | 'settings'>('list');
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
  const [headerViewTarget, setHeaderViewTarget] = useState<HTMLDivElement | null>(null);
  const [sidebarViewTarget, setSidebarViewTarget] = useState<HTMLDivElement | null>(null);
  const [minimizedViewTarget, setMinimizedViewTarget] = useState<HTMLDivElement | null>(null);
  const [sessionViewTarget, setSessionViewTarget] = useState<HTMLDivElement | null>(null);
  const [windowViewTarget, setWindowViewTarget] = useState<HTMLDivElement | null>(null);
  const [dockViewTarget, setDockViewTarget] = useState<HTMLDivElement | null>(null);
  const [mobileViewTarget, setMobileViewTarget] = useState<HTMLDivElement | null>(null);
  const [traceViewTarget, setTraceViewTarget] = useState<HTMLDivElement | null>(null);
  const connectionSummaryRef = useRef<HTMLDetailsElement>(null);
  const workbenchPanelRef = useRef<HTMLElement>(null);
  const compactLayoutRef = useRef(isCompactLayout());
  const focusTimelineAfterAttachRef = useRef(false);
  const [providers, setProviders] = useState<readonly AgentProviderDescriptor[]>([]);
  const [localProviderId, setLocalProviderId] = useState('');
  const [createPlanning, setCreatePlanning] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Readonly<Record<string, Readonly<Record<string, QuestionDraft>>>>>({});
  const [providerName, setProviderName] = useState(initialProviderName);
  const [catalogStatus, setCatalogStatus] = useState<ProviderCatalogStatus>(initialState ? 'ready' : 'loading');
  const [catalogError, setCatalogError] = useState<string>();
  const [storedState, setState] = useState<AgentReplicaState | undefined>(initialState ?? cachedState);
  const [storedSessionState, setSessionState] = useState<RemoteSessionState>(() => remoteSessionState(initialState ?? cachedState, cachedState ? 'connecting' : initialSessionStatus));
  const draftStores = useMemo(() => new Map([[baseUrl, messageDrafts]]), [baseUrl, messageDrafts]);
  const [teamRoster, setTeamRoster] = useState<{ baseUrl: string; teams: Team[] }>();
  const teamRosterRef = useRef(teamRoster); teamRosterRef.current = teamRoster;
  // An explicit Window restores its own bindings; session parameters may describe a pane that was closed.
  const [initialSession] = useState(() => initialState || new URLSearchParams(window.location.search).has('window') ? undefined : requested.target);
  const succession = useSessionSuccession({
    targetRevision: JSON.stringify(teamRoster),
    validateTarget(selection, viewId, document) {
      const roster = teamRosterRef.current;
      const target = teamViewTarget(document, roster?.baseUrl === baseUrl ? roster.teams : undefined, selection, viewId);
      if (target && sessionKey(target) !== sessionKey(selection)) throw new Error('The Team execution locator is still synchronizing. Its history and draft are preserved.');
    },
    scope: baseUrl, transport, enabled: activated && accessReady,
    initial: initialSession, initialDisplayState: cachedState, initialLayout: initialSession ? initialLayout : undefined,
    connections, replicaFor, directory: hostId => hostId === selectedHost.id && directory ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId),
    cachedReplicaFor: target => {
      const saved = openedSessionsRef.current.find(item => sessionKey(item) === sessionKey(target));
      return saved ? replicas.get(saved.agentId) : undefined;
    },
    layout: () => ({ path: stackPath, selections: sideSelections, focus: sideFocus, anchor: sideAnchor, address: addressSession ? viewKey(addressSession) : undefined, collapsed: stackPath.filter(session => !expandedKeys.has(viewKey(session))).map(viewKey) }),
    textStore: scope => { let store = draftStores.get(scope); if (!store) { store = new DraftStore(scope); draftStores.set(scope, store); } return store; },
    tracking: () => tracking, ask: () => ask,
    retireNative: () => {
      navigationGeneration.current++;
      unsubscribeReplicaRef.current?.(); unsubscribeReplicaRef.current = undefined;
      clientRef.current = undefined; replicaRef.current = undefined; primaryBinding.current = undefined;
    },
    bindNative: binding => {
      clientRef.current = binding.client; replicaRef.current = binding.replica;
      primaryBinding.current = { baseUrl, transport, agentId: binding.session.agentId };
    },
    confirmed: session => {
      rememberSession(session); setAttachingAgentId(undefined); setSessionNotice(undefined);
      const pending = pendingViewRestore.current; pendingViewRestore.current = undefined;
      const view = pending?.scope === baseUrl && pending.transport === transport && pending.slotId === session.viewId ? pending.read() : undefined;
      if (view) { setSideSelections(current => ({ ...current, ...view.selections })); setSideFocus(view.focus); setSideAnchor(view.anchor); }
      setProviderName(providerConnectionName(session.hostId ?? 'local', session.providerId));
    },
    failed: (error, selection, retrying = false) => {
      setSessionNotice(sessionConnectionFailure(error, retrying));
      if (error instanceof DirectoryError && error.nativeOwner) setNativeTakeover({ item: selection, owner: error.nativeOwner, message: error.message });
    },
  });
  const [nativeBootstrap] = useState(() => !initialSession?.nativeSessionId && !!initialSession?.agentId);
  const [bootstrapComplete, setBootstrapComplete] = useState(!nativeBootstrap);
  useEffect(() => { if (nativeBootstrap && succession.binding) setBootstrapComplete(true); }, [nativeBootstrap, succession.binding]);
  // A supplied snapshot is a standalone rendering input; it does not require a Window controller.
  const workspaceController = useWindowWorkspace(baseUrl, userScoped, accessReady, succession.document, !initialState && bootstrapComplete);
  const sharedWindow = initialState ? undefined : workspaceController.window;
  const windowRetention = useWindowSessionRetention(connections, sharedWindow);
  useEffect(() => {
    for (const id of workspaceController.deletedWindowIds) windowRetention.forgetWindow(id);
  }, [workspaceController.deletedWindowIds, windowRetention]);
  const windowWorkspace = { ...workspaceController,
    ...(initialState ? { window: undefined, authority: undefined, sessionBridge: undefined, unavailable: false } : {}),
  };
  const primaryGroups = sharedWindow ? primaryWindowViews(sharedWindow) : [];
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
  const windowSession = useWindowSessionBridge({ window: sharedWindow, unavailable: windowWorkspace.unavailable, readWindow: windowWorkspace.readWindow, operate: windowWorkspace.operate, succession, enabled: accessReady && activated && !windowWorkspace.unavailable,
    onError: error => setSessionNotice(sessionConnectionFailure(error, false)) });
  const sharedSlots = windowSession.slots, sharedFamily = windowSession.family;
  const sharedViewForSlot = windowSession.viewForSlot;
  const compositionProtected = succession.active && succession.discovering;
  const trackedViews = useMemo(() => new TrackedSessionViews(succession.document, () => succession.save()), [succession.document]);
  function viewSession(session: OpenedSession, id?: string): OpenedSession & { viewId: string } {
    const slot = succession.ensureView(session, id ?? (session as { viewId?: string }).viewId);
    return { ...session, viewId: slot.id };
  }
  function draftBindingFor(session: OpenedSession) {
    const owner = succession.document.slots.find(slot => slot.id === viewKey(session))!.owners.text;
    return draftOwnerBinding(owner);
  }
  function draftOwnerBinding(owner: StoreOwner) {
    let store = draftStores.get(owner.scope);
    if (!store) { store = new DraftStore(owner.scope); draftStores.set(owner.scope, store); }
    return { store, key: owner.key };
  }
  const state = windowSession.empty ? undefined : succession.active ? succession.state : storedState;
  const sessionState = windowSession.empty ? remoteSessionState(undefined, 'idle') : succession.active ? succession.sessionState : storedSessionState;
  const status = sessionState.connection;
  const handoff = sessionState.handoff;
  function setStatus(connection: RemoteSessionStatus): void { setSessionState(remoteSessionState(replicaRef.current?.getState() ?? state, connection)); }
  const [attachingAgentId, setAttachingAgentId] = useState<string>();
  const [transitioning, setTransitioning] = useState(false);
  const [, refreshOpeningHandoff] = useState(0);
  const [nativeTakeover, setNativeTakeover] = useState<{item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & {hostId?: string}; owner: NativeSessionOwner; message: string}>();
  const openingHandoff = nativeTakeover ? sessionHandoffScope(transport).forTarget(sessionKey({ ...nativeTakeover.item, hostId: nativeTakeover.item.hostId ?? selectedHost.id })) : undefined;
  useEffect(() => openingHandoff?.subscribe(() => refreshOpeningHandoff(version => version + 1)), [openingHandoff]);
  const [sessionNotice, setSessionNotice] = useState<SessionConnectionMessage>();
  const [failure, setFailure] = useState<string | undefined>(requested.error);
  useFeedbackToast('Session operation', failure);
  useFeedbackToast('Session connection', nativeTakeover ? undefined : sessionNotice?.message, sessionNotice?.tone === 'alert' ? 'error' : 'info');
  useFeedbackToast('Provider catalog', catalogError);
  const [activeView, setActiveView] = useState<'workbench' | 'trace'>('workbench');
  const [traceNavigation, setTraceNavigation] = useState<{ scope: string; key: string; requestId: number; view: 'workbench' | 'trace' }>();
  const traceRequestCounter = useRef(0);
  const [scanOpen, setScanOpen] = useState(false);
  const opensSession = !!(initialState || cachedState || requested.target?.nativeSessionId || requested.target?.agentId);
  const [contextOpen, setContextOpen] = useState(() => compactLayoutRef.current && !opensSession);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const sidebar = useSidebarWidth(inspectorOpen);
  const [headerHidden, setHeaderHidden] = useState(true);
  const [desktopContextVisible, setDesktopContextVisible] = useState(() => !opensSession);
  const [compactLayout, setCompactLayout] = useState(compactLayoutRef.current);
  const closeContext = useCallback(() => { setContextOpen(false); setDesktopContextVisible(false); }, []);

  const { hosts: remoteHosts, error: hostError, retry: retryHosts } = useRemoteHosts(hostClient, accessReady && directory !== undefined, (compactLayout ? contextOpen : desktopContextVisible) || status !== 'ready' || creationLocked, selectedHost.id);
  const currentHost = remoteHosts.find((host) => host.id === selectedHost.id);
  const availableProviders = selectedHost.id === 'local' ? providers : hostProviders(currentHost);
  const preferredProviderId = selectedHost.id === 'local' ? localProviderId : selectedHost.providerId;
  const providerId = availableProviders.find((provider) => provider.providerId === preferredProviderId)?.providerId
    ?? availableProviders[0]?.providerId ?? '';
  useEffect(() => {
    if (!currentHost || !restoredHostSelection.current || creationLocked || transitioning || selectedHost.providerId === providerId) return;
    setSelectedHost((host) => ({ ...host, providerId }));
    setSessionOptions({});
    setCreatePlanning(false);
  }, [currentHost, selectedHost.providerId, providerId, creationLocked, transitioning]);
  const ask = useAskConversations(succession.document, transport, directory, selectedHost.id, retryHosts, source => succession.resolveTarget(source, { nativePrefixOnly: true }).target, windowWorkspace.authority);
  const projectedLayout = succession.layoutView();
  const availableSides = projectedLayout ? [...storedSideSessions.filter(session => !projectedLayout.sides.some(side => viewKey(side) === viewKey(session))), ...projectedLayout.sides] : storedSideSessions;
  const sideSessions = windowSession.empty ? [] : sharedWindow ? availableSides.filter(session => { const view = sharedViewForSlot(viewKey(session)); return view && sharedFamily?.has(view.id) && view.id !== sharedWindow.selectedPrimaryViewId; }) : availableSides;
  const sideSelections = useMemo<SideSelections>(() => Object.fromEntries(succession.document.edges.filter(edge => edge.selected).map(edge => [edge.source, edge.target])), [succession.document, succession.document.editRevision]);
  const sideFocus = succession.document.focus, sideAnchor = succession.document.anchor;
  function selectedChildKey(sourceId: string) {
    if (sharedWindow) {
      const source = sharedViewForSlot(sourceId);
      const child = source && sharedWindow.views.find(view => view.attachedTo === source.id);
      return child?.binding ? sessionKey(child.binding) : undefined;
    }
    const slot = succession.document.slots.find(slot => slot.id === sideSelections[sourceId]);
    return slot ? sessionKey(compositionSelection(slot)) : undefined;
  }
  function setSideSelections(change: SideSelections | ((current: SideSelections) => SideSelections)) {
    const current = Object.fromEntries(succession.document.edges.filter(edge => edge.selected).map(edge => [edge.source, edge.target]));
    const next = typeof change === 'function' ? change(current) : change;
    if (sharedWindow) {
      const operations: WindowEdit[] = [];
      for (const [sourceId, targetId] of Object.entries(next)) {
        if (current[sourceId] === targetId) continue;
        const source = sharedViewForSlot(sourceId); if (!source) continue;
        const previous = sharedWindow.views.find(view => view.attachedTo === source.id);
        const existing = targetId ? sharedViewForSlot(targetId) : undefined;
        if (existing?.attachedTo === source.id) {
          operations.push({ type: 'view.select', viewId: existing.id });
          continue;
        }
        if (previous) operations.push({ type: 'view.close', viewId: previous.id });
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
  useEffect(() => {
    if (compactLayout && !contextOpen) return;
    const panel = shellRef.current?.querySelector<HTMLElement>('#lab-context');
    if (!panel) return;
    const scrollContainer = panel.querySelector<HTMLElement>('.lab-sidebar-content');
    if (scrollContainer) scrollContainer.scrollTop = 0;
    if (sessionPanel === 'new') panel.querySelector<HTMLElement>('#provider-select')?.focus({ preventScroll: true });
    else if (compactLayout) panel.querySelector<HTMLElement>('.lab-rail-close')?.focus({ preventScroll: true });
  }, [compactLayout, contextOpen, sessionPanel]);

  useEffect(() => {
    if (restoredHostSelection.current || remoteHosts.length === 0) return;
    if (requestedHostId) {
      const host = remoteHosts.find((item) => item.id === requestedHostId);
      if (!host) return;
      restoredHostSelection.current = true;
      const descriptor = host.providers?.find((provider) => provider.providerId === requested.target?.providerId) ?? host.providers?.[0];
      const selectedProviderId = requested.target?.providerId ?? descriptor?.providerId ?? host.providerId ?? 'dsh';
      setSelectedHost({ ...host, providerId: selectedProviderId });
      setProviderName(descriptor ? `${descriptor.displayName} · ${host.name}` : selectedProviderId);
      return;
    }
    const activeId = state?.agent?.id ?? rememberedAgent();
    const saved = openedSessions.find((item) => item.agentId === activeId && item.hostId && item.hostId !== 'local');
    if (!saved) { restoredHostSelection.current = true; return; }
    const host = remoteHosts.find((item) => item.id === saved.hostId);
    if (!host) return;
    restoredHostSelection.current = true;
    setSelectedHost({ ...host, providerId: saved.providerId });
    const descriptor = host.providers?.find((provider) => provider.providerId === saved.providerId);
    setProviderName(descriptor ? `${descriptor.displayName} · ${host.name}` : saved.providerId);
  }, [openedSessions, remoteHosts, requestedHostId, state?.agent?.id]);

  const loadProviders = useCallback(async (): Promise<void> => {
    const generation = providerRequestGenerationRef.current + 1;
    providerRequestGenerationRef.current = generation;
    setCatalogStatus('loading');
    setCatalogError(undefined);
    try {
      const available = await transport.listProviders();
      if (providerRequestGenerationRef.current !== generation) return;
      setProviders(available);
      setLocalProviderId((selected) => available.some((provider) => provider.providerId === selected)
        ? selected
        : (available[0]?.providerId ?? ''));
      setCatalogStatus(available.length > 0 ? 'ready' : 'empty');
    } catch (error) {
      if (providerRequestGenerationRef.current !== generation) return;
      setCatalogStatus('error');
      setCatalogError(message(error, 'Provider list could not be loaded.'));
    }
  }, [transport]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      const summary = connectionSummaryRef.current;
      if (summary?.open && event.target instanceof Node && !summary.contains(event.target)) summary.open = false;
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);

  const providerChoices = availableProviders.map((provider) => ({
    ...provider,
    hostId: selectedHost.id,
    selectionId: selectedHost.id === 'local' ? provider.providerId : JSON.stringify([selectedHost.id, provider.providerId]),
  }));
  const selectedProviderChoice = providerChoices.find((choice) => choice.hostId === selectedHost.id && choice.providerId === providerId);
  const selectedHostOffline = selectedHost.id !== 'local' && remoteHosts.find((host) => host.id === selectedHost.id)?.online !== true;
  const selectedQuota = remoteHosts.find((host) => host.id === selectedHost.id)?.sessionQuota;
  const creationQuotaExhausted = selectedQuota !== undefined && selectedQuota.used >= selectedQuota.limit && !creationReservation.current;
  const requestedHostUnavailable = requestedHostId && requestedHostId !== 'local' && !restoredHostSelection.current && !remoteHosts.some((host) => host.id === requestedHostId)
    ? 'Requested Host is unavailable or is not shared with you. Retry Hosts or select another Host.' : undefined;
  const creationUnavailableReason = requestedHostUnavailable ?? (selectedHostOffline ? 'This Host is offline. Reconnect it or select another Host.'
    : creationQuotaExhausted ? 'Session creation limit reached. Existing sessions remain available. Ask the owner to raise your limit.'
    : selectedHost.id !== 'local' && !providerId ? 'No providers available on this Host. Check installed agents and provider settings.' : undefined);

  function providerConnectionName(hostId: string, selectedProviderId: string): string {
    if (hostId === 'local') return providers.find((provider) => provider.providerId === selectedProviderId)?.displayName ?? selectedProviderId;
    const host = remoteHosts.find((candidate) => candidate.id === hostId);
    const descriptor = host?.providers?.find((provider) => provider.providerId === selectedProviderId);
    return descriptor && host ? `${descriptor.displayName} · ${host.name}` : selectedProviderId;
  }

  function selectHost(host: RemoteHost, preferredId = providerId): void {
    if (creationLocked || transitionRef.current && !sidebarWindow) return;
    restoredHostSelection.current = true;
    const advertised = host.id === 'local' ? providers : hostProviders(host);
    const nextProviderId = advertised.find((provider) => provider.providerId === preferredId)?.providerId
      ?? advertised[0]?.providerId ?? '';
    setSelectedHost({ ...host, providerId: nextProviderId });
    if (host.id === 'local') setLocalProviderId(nextProviderId);
    setSessionOptions({});
    setCreatePlanning(false);
  }

  function selectProvider(selectionId: string): void {
    const choice = providerChoices.find((item) => item.selectionId === selectionId);
    if (!choice) return;
    selectHost(currentHost ?? selectedHost, choice.providerId);
  }

  const attach = useCallback((agentId: string, catchUpTarget?: TimelineCursor, restoreLayout = false): void => {
    if (!accessReadyRef.current) return;
    pendingViewRestore.current = undefined;
    setDetachedSideRoot(undefined);
    succession.leave(); setState(undefined); setSessionState(remoteSessionState(undefined, 'connecting'));
    const generation = ++navigationGeneration.current;
    setActiveView('workbench');
    closeContext();
    if (compactLayoutRef.current) { setInspectorOpen(false); queueMicrotask(() => workbenchPanelRef.current?.focus()); }
    setSessionNotice(undefined); setUncertainMutation(false); setAttachingAgentId(agentId);
    void transport.fetchSnapshot(agentId).then(async snapshot => {
      if (!accessReadyRef.current || mountedTransport.current !== transport || navigationGeneration.current !== generation) return;
      const agent = snapshot.payload, nativeSessionId = agent.runtimeInfo.sessionId;
      if (agent.id !== agentId || !nativeSessionId || agent.providerId !== agent.runtimeInfo.providerId) throw new Error('The native session identity could not be confirmed.');
      const known = openedSessionsRef.current.find(session => session.agentId === agentId);
      const session = { ...known, agentId, providerId: agent.providerId, nativeSessionId, hostId: known?.hostId ?? 'local', title: known?.title ?? 'Conversation' };
      beginCatchUp(replicaFor(agentId), catchUpTarget);
      await windowSession.openAttached(session, restoreLayout);
      rememberAgent(agentId);
    }).catch(error => { if (navigationGeneration.current === generation) { setAttachingAgentId(undefined); setSessionNotice(sessionConnectionFailure(error, false)); } });
  }, [baseUrl, transport, replicaFor, beginCatchUp]);

  useEffect(() => {
    if (initialState || !activated) return;
    void loadProviders();
  }, [initialState, loadProviders, activated]);

  useEffect(() => () => {
    providerRequestGenerationRef.current += 1;
    navigationGeneration.current += 1;
    unsubscribeReplicaRef.current?.();
    unsubscribeReplicaRef.current = undefined;
    clientRef.current = undefined;
  }, []);

  useEffect(() => {
    if (initialState || !activated || requested.target?.nativeSessionId || requested.error || sharedWindow || new URL(location.href).searchParams.has('window')) return;
    const remembered = rememberedAgent(), saved = openedSessionsRef.current.find(item => item.agentId === remembered);
    if (saved && directory && (!requestedHostId || (saved.hostId ?? 'local') === requestedHostId)) void succession.restore(saved);
    else if (!requestedHostId && remembered) attach(remembered, undefined, true);
  }, [attach, baseUrl, initialState, requestedHostId, activated]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1180px)');
    const update = (event: MediaQueryListEvent) => {
      compactLayoutRef.current = event.matches;
      setCompactLayout(event.matches);
      setContextOpen(false);
      setInspectorOpen(false);
    };
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    if (typeof media.addListener === 'function') {
      media.addListener(update);
      return () => media.removeListener(update);
    }
  }, []);

  useEffect(() => {
    if (!compactLayout || contextOpen || inspectorOpen || !focusTimelineAfterAttachRef.current) return;
    focusTimelineAfterAttachRef.current = false;
    workbenchPanelRef.current?.focus();
  }, [activeView, compactLayout, contextOpen, inspectorOpen]);

  useEffect(() => {
    if (!directory) return;
    try { conversationLocalStorage.setItem(openedSessionsKey(baseUrl), JSON.stringify(openedSessions)); } catch { /* Storage may be unavailable in private browser contexts. */ }
  }, [baseUrl, directory, openedSessions]);

  function rememberSession(value: OpenedSession): void {
    const item = openedSessionMetadata(value);
    const next = [item, ...openedSessionsRef.current.filter((entry) => !((entry.hostId ?? 'local') === (item.hostId ?? 'local') && entry.providerId === item.providerId && entry.nativeSessionId === item.nativeSessionId) && entry.agentId !== item.agentId)];
    openedSessionsRef.current = next;
    setOpenedSessions(next);
  }

  function rememberTrackedView(): void {
    if (!visibleStackRoot) return;
    trackedViews.remember({ primarySlot: viewKey(visibleStackRoot), focus: sideFocus, anchor: sideAnchor,
      selections: Object.fromEntries(stackPath.map(session => [viewKey(session), sideSelections[viewKey(session)] ?? null])) });
  }
  const trackEntryId = (item: SessionEntry) => 'entryId' in item && typeof item.entryId === 'string' ? item.entryId : sessionKey(item);
  async function openTrackedSession(item: SessionEntry): Promise<void> {
    if (!directory || transitionRef.current) return;
    try {
      const destination = directoryDestination();
      if (destination && windowWorkspace.readWindow()?.views.find(view => view.id === destination.viewId)?.placement !== 'primary') {
        await bindDirectorySession(item, destination);
        setActiveView('workbench'); closeContext();
        return;
      }
      rememberTrackedView();
      const entryId = trackEntryId(item), slot = succession.document.slots.find(slot => slot.id === trackedViews.entry(entryId)?.slotId) ?? succession.ensureView(item);
      trackedViews.bind(entryId, slot.id);
      const view = tracking.observations[sessionKey(item)]?.changed ? undefined : trackedViews.get(entryId);
      const primary = view?.primary ?? compositionSelection(slot);
      const observation = tracking.observations[sessionKey(primary)];
      if (observation?.agentId && observation.connection === 'ready') beginCatchUp(replicaFor(observation.agentId), observation.cursor);
      if (!destination) {
        if (await openSession(primary, undefined, undefined, false, view ? () => trackedViews.get(entryId) : undefined, undefined, undefined, view?.primarySlot ?? slot.id)) trackedViews.select(entryId);
        return;
      }
      const selectedDestination = () => {
        const current = windowWorkspace.readWindow(), binding = current?.views.find(view => view.id === destination.viewId)?.binding;
        return current?.id === destination.windowId && current.selectedPrimaryViewId === destination.viewId
          && windowPrimaryViewId(current, current.selectedViewId) === destination.viewId
          && binding && sessionKey(binding) === sessionKey(primary) && binding.parentNativeSessionId === primary.parentNativeSessionId && !binding.sessionIntent;
      };
      letterRequest.current?.abort(); trackedViews.select();
      setDetachedSideRoot(undefined); setNativeTakeover(undefined);
      setActiveView('workbench'); setFailure(undefined); setSessionNotice(undefined); closeContext();
      if (compactLayoutRef.current) setInspectorOpen(false);
      const opened = await bindDirectorySession(primary, destination, { primarySlot: view?.primarySlot ?? slot.id,
        read: view ? () => selectedDestination() && windowWorkspace.readWindow()?.selectedViewId === destination.viewId ? trackedViews.get(entryId) : undefined : undefined });
      if (opened && selectedDestination()) trackedViews.select(entryId);
    } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
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

  async function openSession(item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & { hostId?: string; parentAgentId?: string; parentNativeSessionId?: string }, takeOver?: string, onRestoring?: () => void, letterNavigation = false, restoreView?: () => TrackedSessionView | undefined, sessionIntent?: 'history', keepOriginal?: boolean, primarySlot?: string, placement?: 'primary', targetPrimaryViewId?: string): Promise<boolean> {
    if (!sharedWindow) sessionWindows.focus();
    if (!letterNavigation) letterRequest.current?.abort();
    if (!directory || transitionRef.current) return false;
    rememberTrackedView();
    const selection = { ...item, hostId: item.hostId ?? selectedHost.id };
    if (!targetPrimaryViewId && placement !== 'primary' && !primarySlot && sessionIntent !== 'history' && keepOriginal === undefined && !restoreView && !takeOver && !onRestoring) {
      const visible = stackPath.find(entry => sessionKey(entry) === sessionKey(selection));
      if (visible && !replicaFor(visible.agentId).getState().sessionControl?.nativeOwner) {
        setSideFocus(viewKey(visible));
        if (!expandedKeys.has(viewKey(visible))) setSideAnchor(viewKey(visible));
        setActiveView('workbench'); closeContext(); setInspectorOpen(false); return true;
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
    setActiveView('workbench'); setFailure(undefined); setSessionNotice(undefined);
    closeContext();
    if (compactLayoutRef.current) setInspectorOpen(false);
    try {
      const result = sharedWindow && !takeOver && !onRestoring
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

  async function openChildSession(child: AgentChildSessionView, source?: OpenedSession, sourceState?: AgentReplicaState): Promise<void> {
    letterRequest.current?.abort();
    const parentState = sourceState ?? state;
    const parentId = parentState?.agent?.runtimeInfo.sessionId;
    const parentAgent = parentState?.agent;
    if (!parentAgent || !parentId || !directory) throw new Error('The parent session is unavailable.');
    let origin: OpenedSession = viewSession(source ?? activeOpened ?? { agentId: parentAgent.id, providerId: parentAgent.providerId, nativeSessionId: parentId, hostId: 'local', title: 'Parent conversation' });
    assertSourceCurrent(origin);
    if (sharedWindow || !compactLayoutRef.current) {
      const knownChild = sessionEntries.find(entry => entry.nativeSessionId === child.nativeSessionId && entry.providerId === origin.providerId && (entry.hostId ?? 'local') === (origin.hostId ?? 'local'));
      if (knownChild?.parentNativeSessionId && knownChild.parentNativeSessionId !== origin.nativeSessionId) {
        const actualParent = openWindows.find(session => session.nativeSessionId === knownChild.parentNativeSessionId && session.providerId === origin.providerId && (session.hostId ?? 'local') === (origin.hostId ?? 'local'));
        if (!actualParent) throw new Error('Open the direct parent session before opening this nested subagent.');
        origin = viewSession(actualParent);
      }
      const cached = connections.find({ ...origin, nativeSessionId: child.nativeSessionId });
      const showChild = async (opened: OpenedSession) => {
        if (!stackPath.some(session => sessionKey(session) === sessionKey(origin)) && !await openSession(origin)) {
          throw new Error('The parent session could not be opened.');
        }
        selectSide(origin, opened);
      };
      if (cached) {
        await showChild({ ...child, agentId: cached.agentId, providerId: origin.providerId, hostId: origin.hostId, parentAgentId: origin.agentId, parentNativeSessionId: origin.nativeSessionId });
        return;
      }
      const generation = navigationGeneration.current;
      const request = nextSideRequest(origin);
      const target = (origin.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, origin.hostId);
      try {
        const result = await target.attachChild(origin.providerId, origin.nativeSessionId, child.nativeSessionId);
        if (navigationGeneration.current !== generation || sideRequests.current.get(sideRequestKey(origin)) !== request) return;
        assertSourceCurrent(origin);
        const opened = { ...child, agentId: result.agentId, providerId: origin.providerId, hostId: origin.hostId, parentAgentId: origin.agentId, parentNativeSessionId: origin.nativeSessionId };
        rememberSession(origin); rememberSession(opened); setSessionNotice(undefined);
        await showChild(opened);
      } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); throw error; }
      return;
    }
    const known = sessionEntries.find(entry => entry.nativeSessionId === child.nativeSessionId
      && entry.providerId === origin.providerId && (entry.hostId ?? 'local') === (origin.hostId ?? 'local'));
    const generation = navigationGeneration.current;
    if (transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    setSessionNotice({ tone: 'status', message: 'Opening the existing child session. Waiting for the Host to confirm it is ready…' });
    try {
      const hostId = origin.hostId ?? 'local';
      const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
      const parentNativeSessionId = known?.parentNativeSessionId ?? origin.nativeSessionId;
      const result = await target.attachChild(origin.providerId, parentNativeSessionId, child.nativeSessionId);
      if (navigationGeneration.current !== generation) return;
      assertSourceCurrent(origin);
      rememberSession(origin);
      const opened = { agentId: result.agentId, providerId: origin.providerId, nativeSessionId: result.nativeSessionId,
        title: child.title, createdAt: child.createdAt, hostId, parentAgentId: known?.parentAgentId ?? origin.agentId, parentNativeSessionId };
      rememberSession(opened); await windowSession.openAttached(opened);
    } catch (error) {
      if (navigationGeneration.current === generation) setSessionNotice(sessionConnectionFailure(error, false));
      throw error;
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  }

  async function createAgent(): Promise<void> {
    if (!providerId || creationUnavailableReason || transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined); setSessionNotice(undefined);
    const agentId = createAgentId();
    try {
      if (directory) {
        const reservation = creationReservation.current ?? { operationId: crypto.randomUUID(), providerId, destination: directoryDestination(), options: { ...sessionOptions, ...(createPlanning && providerId !== 'dsh' ? { planning: true } : {}) } };
        creationReservation.current = reservation;
        setCreationLocked(true);
        const response = await directory.create(reservation.providerId, reservation.operationId, reservation.options);
        const session = { agentId: response.agentId, nativeSessionId: response.nativeSessionId ?? response.agentId, providerId: reservation.providerId, title: 'New session', hostId: selectedHost.id };
        rememberTrackedView(); trackedViews.select();
        closeContext(); setActiveView('workbench');
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
      setSessionPanel('list');
    } catch (error) {
      if (error instanceof DirectoryError && error.code === 'native_file_limit') {
        const notice = sessionConnectionFailure(error, false);
        setSessionNotice({ ...notice, operation: 'Create session', message: `${notice.message} Creation may have partially completed. Inspect the native session list before creating a new intent. Retry keeps the same reservation.` });
      }
      const invalid = error instanceof DirectoryError && ['invalid_request', 'workspace_not_found', 'provider_not_found', 'session_quota_exceeded', 'operation_conflict'].includes(error.code ?? '');
      if (invalid) { creationReservation.current = undefined; setCreationLocked(false); }
      if (!(error instanceof DirectoryError && error.code === 'native_file_limit')) setFailure(`${message(error, 'Agent could not be created.')}${directory && !invalid ? ' Retry keeps the same session reservation and settings.' : ''}`);
    } finally {
      if (directory && selectedHost.id !== 'local') retryHosts();
      transitionRef.current = false;
      setTransitioning(false);
    }
  }

  async function resumeAgent(): Promise<void> {
    const persistence = state?.agent?.persistence;
    const session = openedSessions.find((item) => item.agentId === state?.agent?.id);
    if (!persistence || session?.parentAgentId || session?.parentNativeSessionId || transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined); setSessionNotice(undefined);
    const generation = navigationGeneration.current;
    try {
      if (directory) {
        closeContext(); setActiveView('workbench');
        const hostId = session?.hostId ?? 'local';
        const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
        const response = await target.attach(persistence.providerId, persistence.sessionId);
        if (navigationGeneration.current !== generation) return;
        const resumed = { ...session, agentId: response.agentId, providerId: persistence.providerId,
          nativeSessionId: response.nativeSessionId ?? persistence.sessionId, hostId, title: session?.title ?? 'Resumed session' };
        rememberSession(resumed); await windowSession.openAttached(resumed);
      } else {
        const response = await transport.resumeAgent(createAgentId(), persistence);
        if (navigationGeneration.current !== generation) return;
        attach(response.payload.agentId);
      }
    } catch (error) {
      if (navigationGeneration.current === generation) setFailure(message(error, 'Agent could not be resumed.'));
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  }

  function handleViewKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    let next: 'workbench' | 'trace' | undefined;
    if (event.key === 'Home') next = 'workbench';
    else if (event.key === 'End') next = 'trace';
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      next = activeView === 'workbench' ? 'trace' : 'workbench';
    }
    if (!next) return;
    event.preventDefault();
    setActiveView(next);
    (next === 'workbench' ? workbenchTabRef : traceTabRef).current?.focus();
  }

  function openContext(fromSessions = false): void {
    setContextFromSessions(fromSessions);
    setSessionPanel('list');
    setDesktopContextVisible(true);
    setInspectorOpen(false);
    setContextOpen(true);
  }

  function openInspector(): void {
    setContextOpen(false);
    setInspectorOpen(true);
  }

  const contextVisible = compactLayout ? contextOpen : desktopContextVisible;
  function toggleContext(): void {
    if (compactLayout) { if (contextOpen) setContextOpen(false); else openContext(); }
    else setDesktopContextVisible((value) => !value);
  }
  function setAllPanelsVisible(visible: boolean): void {
    setHeaderHidden(!visible);
    setDesktopContextVisible(visible);
    setContextOpen(false);
    setInspectorOpen(visible && !compactLayout);
  }
  const supportingRailOpen = compactLayout && (contextOpen || inspectorOpen);
  const backgroundInert = supportingRailOpen ? { inert: '' } : {};

  const activeAgentId = state?.agent?.id ?? (succession.active ? undefined : attachingAgentId);
  const connectionAgentId = state?.agent?.id ?? attachingAgentId ?? 'standby';
  const activeOpened = windowSession.empty ? undefined : succession.binding?.session ?? openedSessions.find((item) => succession.active
    ? !!succession.selected && sessionKey(item) === sessionKey(succession.selected)
    : item.agentId === activeAgentId);
  const ancestors: OpenedSession[] = [];
  const visited = new Set<string>(activeAgentId ? [activeAgentId] : []);
  let ancestorId = activeOpened?.parentAgentId;
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor = openedSessions.find((item) => item.agentId === ancestorId);
    if (!ancestor) break;
    ancestors.unshift(ancestor);
    ancestorId = ancestor.parentAgentId;
  }
  const observedSessionEntries = useSessionEntries(openedSessions, state, confirmedTitles);
  const sessionEntries = useMemo(() => {
    const entries = new Map(observedSessionEntries.map(entry => [sessionKey(entry), entry]));
    for (const session of sideSessions) {
      if (session.agentId === state?.agent?.id) continue;
      const key = sessionKey(session);
      const observed = entries.get(key);
      entries.set(key, { ...observed, ...session, status: sideActivity[session.agentId] ?? observed?.status });
    }
    return [...entries.values()];
  }, [observedSessionEntries, sideSessions, sideActivity, state?.agent?.id]);
  useEffect(() => {
    succession.observeHistoryTitles(sessionEntries);
    succession.updateTitles(sessionEntries.filter(item => !!item.parentNativeSessionId));
    const childTitles = new Map(sessionEntries.filter((item) => item.parentNativeSessionId).map((item) => [sessionKey(item), item.title]));
    setOpenedSessions((current) => {
      const next = current.map((item) => {
        const title = childTitles.get(sessionKey(item));
        return title !== undefined && title !== item.title ? { ...item, title } : item;
      });
      return next.some((item, index) => item !== current[index]) ? next : current;
    });
  }, [sessionEntries]);
  const currentSession = windowSession.empty ? undefined : sessionEntries.find((item) => item.agentId === activeAgentId) ?? succession.selected;
  const askView = useAskVisibility();
  const askSurfaceVisible = askView.visible && activeView === 'workbench' && !supportingRailOpen;
  function presentedSelection(current: typeof sharedWindow) {
    const hiddenAsk = compactLayout && !askView.visible
      ? current?.views.find(view => parseWindowFeature(view.feature)?.kind === 'ask' && isAskSelected(current, view)) : undefined;
    const id = hiddenAsk ? current?.views.find(view => view.id === hiddenAsk.closeWith)?.id ?? current?.selectedPrimaryViewId : current?.selectedViewId;
    return current?.views.find(view => view.id === id);
  }
  const directoryView = presentedSelection(sharedWindow);
  const presentedViewId = directoryView?.id;
  let presentedRootView = directoryView;
  while (presentedRootView?.attachedTo) presentedRootView = sharedWindow?.views.find(view => view.id === presentedRootView!.attachedTo);
  const presentedPrimaryViewId = sharedWindow && presentedViewId && windowPrimaryViewId(sharedWindow, presentedViewId);
  const presentedFeature = parseWindowFeature(presentedRootView?.feature);
  const sessionWindows = useSessionWindows(baseUrl, { document: succession.document, ensureView: succession.ensureView, ensureWindowView: succession.ensureWindowView, save: () => succession.save(true), shared: windowWorkspace.authority });
  const sidebarWindow = sessionWindows.entries.find(entry => entry.id === (sharedWindow ? presentedRootView?.id : sessionWindows.selectedId) && !entry.managed);
  function focusManagedWindow(event: { target: EventTarget }) {
    if (event.target instanceof Element && event.target.closest('[data-pane-selection-ignore]')) return;
    if (!sharedWindow && event.target instanceof Element && event.target.closest('.lab-ask-window') && !event.target.closest('[data-view-id]')) sessionWindows.focus();
  }
  function chooseWindowSession(id: string) {
    sessionWindows.focus(id); showWindowSessionChooser();
  }
  function showWindowSessionChooser() {
    setActiveView('workbench'); setSessionPanel('list'); setDesktopContextVisible(true); setContextOpen(true);
  }
  function editWindow(operation: Parameters<typeof windowWorkspace.operate>[0]) {
    void windowWorkspace.operate(operation).catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
  }
  function selectPrimaryGroup(id: string) {
    const current = windowWorkspace.readWindow();
    if (current?.selectedPrimaryViewId === id && current.selectedViewId && windowPrimaryViewId(current, current.selectedViewId) === id) return;
    windowWorkspace.authority?.operate({ type: 'view.select', viewId: id });
  }
  function createSessionView() {
    try { sessionWindows.create(); showWindowSessionChooser(); }
    catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }
  function windowDraftBinding(entry: (typeof sessionWindows.entries)[number]) {
    const slot = succession.document.slots.find(slot => slot.id === entry.slotId);
    if (slot && entry.managed) {
      const origin = slot.origin.target;
      const key = sessionKey({ hostId: origin.hostId, ...origin.native });
      return { draftBinding: { store: messageDrafts, key: `session:${key}` }, imageDraftBinding: { scope: baseUrl, key: JSON.stringify([baseUrl, key]) } };
    }
    return slot ? { draftBinding: draftOwnerBinding(slot.owners.text), imageDraftBinding: slot.owners.image } : {};
  }
  async function openDirectorySession(item: Parameters<typeof openSession>[0]): Promise<boolean> {
    try {
      const destination = directoryDestination();
      if (!destination) return openSession(item);
      const opened = bindDirectorySession({ ...item, hostId: item.hostId ?? selectedHost.id }, destination);
      setActiveView('workbench'); closeContext(); return await opened;
    } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); return false; }
  }
  function directoryDestination() {
    const current = windowWorkspace.readWindow();
    const view = presentedSelection(current);
    if (!current || !view) return;
    if (view.bindingPolicy === 'managed') throw new Error('This view belongs to an Ask, Team, or TPM. Select an ordinary session view or create an empty view first.');
    return { windowId: current.id, viewId: view.id, binding: JSON.stringify(view.binding ?? null) };
  }
  async function bindDirectorySession(session: Parameters<typeof openSession>[0] & { agentId?: string; sessionIntent?: 'history' }, destination: ReturnType<typeof directoryDestination>, trackedView?: { primarySlot: string; read?: () => TrackedSessionView | undefined }) {
    if (!destination) return session.agentId ? windowSession.openAttached(session as OpenedSession) : openSession(session);
    const current = windowWorkspace.readWindow(), view = current?.views.find(view => view.id === destination.viewId);
    if (current?.id !== destination.windowId || !view) return false;
    const expectedBinding = JSON.parse(destination.binding) as WindowSessionBinding | null;
    if (view.placement === 'primary') {
      const pending = trackedView?.read ? { scope: baseUrl, transport, slotId: trackedView.primarySlot, read: trackedView.read } : undefined;
      if (trackedView) pendingViewRestore.current = pending;
      let opened = false;
      try {
        opened = await windowSession.openPrimary(session, !trackedView && session.agentId ? session as OpenedSession : undefined, false, undefined, trackedView?.primarySlot, view.id, session.sessionIntent, expectedBinding);
        return opened;
      } finally { if (!opened && trackedView && pendingViewRestore.current === pending) pendingViewRestore.current = undefined; }
    }
    editWindow({ type: 'view.bind', viewId: view.id, binding: windowSessionBinding(session), expectedBinding });
    return true;
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
  const askTriggerRef = useRef<HTMLButtonElement>(null);
  const tpmView = useTpmVisibility();
  const teamView = useTeamVisibility();
  const [teamReveal, setTeamReveal] = useState<{ baseUrl: string; teamId: string; requestId: string }>();
  const windowView = useWindowVisibility();
  const updateTeamRoster = useCallback((baseUrl: string, teams: Team[]) => setTeamRoster({ baseUrl, teams }), []);
  const [tpmListOpen, setTpmListOpen] = useState(false);
  const tpmTriggerRef = useRef<HTMLButtonElement>(null);
  const candidateTpmService = hostClient as Partial<TpmService>;
  const tpmService = candidateTpmService.tpmList && candidateTpmService.tpmWork && candidateTpmService.tpmCreate && candidateTpmService.tpmAction ? candidateTpmService as TpmService : undefined;
  const tpmHosts = [...(providers.length > 0 ? [{ id: 'local', name: 'Lab server', online: true }] : []), ...remoteHosts];
  const attachTpm = useCallback(async (item: SessionEntry): Promise<OpenedSession> => {
    if (!accessReadyRef.current) throw new Error('Workspace access is restoring.');
    const target = new SessionDirectoryClient(baseUrl, undefined, item.hostId ?? 'local');
    const attached = await target.attach(item.providerId, item.nativeSessionId);
    return { hostId: item.hostId, providerId: item.providerId, nativeSessionId: attached.nativeSessionId ?? item.nativeSessionId, title: item.title, agentId: attached.agentId };
  }, [baseUrl]);
  const tpm = useTpmWork(tpmService, tpmHosts, accessReady && !!directory, attachTpm, tpmView.visible, baseUrl, windowWorkspace.authority,
    sharedWindow && presentedViewId ? { windowId: sharedWindow.id, viewId: presentedViewId } : undefined);
  const tpmMainSessions = useTpmMainSessions(baseUrl, accessReady, tpmView.visible && (tpmListOpen || tpm.expanded), tpm.works, [...favorites.stars, ...sessionEntries], transport);
  const tpmMainState = useRef({ scope: baseUrl, transport, hosts: remoteHosts, providers, works: tpm.works });
  tpmMainState.current = { scope: baseUrl, transport, hosts: remoteHosts, providers, works: tpm.works };
  const tpmMainRequest = useRef(0);
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
  const activeRemoteSession = activeOpened?.hostId !== undefined && activeOpened.hostId !== 'local';
  const activeHost = remoteHosts.find((host) => host.id === activeOpened?.hostId);
  const selectedRemoteHost = selectedHost.id !== 'local' ? remoteHosts.find((host) => host.id === selectedHost.id) : undefined;
  const previewHost = activeHost ?? selectedRemoteHost;
  const hostOffline = activeHost?.online === false;
  const connectionProviderName = providerName ?? state?.agent?.providerId ?? (succession.selected ? providerConnectionName(succession.selected.hostId ?? 'local', succession.selected.providerId) : 'No active Agent');
  const connectionStatusLabel = hostOffline ? 'Host offline' : state?.agent?.status === 'failed' ? 'Agent failed' : sessionStatusLabel(status);

  async function openPreviewSource(sessionId: string, itemId: string, hostId: string): Promise<void> {
    const source = [...sessionEntries, ...openedSessions].find(item => item.agentId === sessionId && item.hostId === hostId);
    if (!source) { setFailure("This preview source is not in the current session list. Open its session from the Host first."); return; }
    if (source && source.agentId !== activeAgentId && !await openSession(source)) return;
    window.requestAnimationFrame(() => {
      const entry = [...document.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.dataset.entryKey === itemId);
      entry?.scrollIntoView({ block: 'center' });
    });
  }


  async function runMutation<T>(operation: () => Promise<T>): Promise<T> {
    setUncertainMutation(false);
    try { return await operation(); } catch (error) {
      if (error instanceof RemoteOperationError && ['connection_disconnected', 'operation_timeout'].includes(error.code)) setUncertainMutation(true);
      throw error;
    }
  }

  const activeFork = forkStore.find(activeOpened ?? (state?.agent?.runtimeInfo.sessionId ? {
    providerId: state.agent.providerId, nativeSessionId: state.agent.runtimeInfo.sessionId, hostId: 'local',
  } : undefined));
  const boundFork = activeFork && activeAgentId ? { ...activeFork, target: { ...activeFork.target!, agentId: activeAgentId } } : undefined;

  const rootSession = succession.active ? succession.binding?.session ?? (succession.desired ? compositionSession(succession.desired.slot) : undefined) : activeOpened ?? (state?.agent?.runtimeInfo.sessionId ? {
    agentId: state.agent.id, nativeSessionId: state.agent.runtimeInfo.sessionId, providerId: state.agent.providerId, hostId: 'local', title: 'Conversation',
  } : undefined);
  const stackRoot = rootSession ? viewSession(rootSession) : undefined;
  const primaryDisplaySlot = stackRoot ? succession.document.slots.find(slot => slot.id === viewKey(stackRoot)) : succession.displaySlot;
  useEffect(() => { if (initialState && stackRoot && !succession.active) void succession.save(); }, [stackRoot?.viewId, initialState]);
  const visibleStackRoot = sideSessions.find(session => viewKey(session) === detachedSideRoot) ?? stackRoot;
  const featureBinding = directoryView?.binding;
  const featureSource = sharedWindow ? featureBinding && {
    hostId: featureBinding.hostId, providerId: featureBinding.providerId,
    nativeSessionId: featureBinding.nativeSessionId, title: confirmedTitles?.get(sessionKey(featureBinding)) ?? featureBinding.title,
  } : visibleStackRoot ? { ...visibleStackRoot, hostId: visibleStackRoot.hostId ?? 'local' }
    : currentSession ? { ...currentSession, hostId: currentSession.hostId ?? 'local' } : undefined;
  const renameHost = remoteHosts.find(host => host.id === visibleStackRoot?.hostId);
  const canRenamePrimary = userScoped && accessReady && renameHost?.online === true
    && renameHost.providers?.some(provider => provider.providerId === visibleStackRoot?.providerId && provider.sessionRename === true);
  const renamePrimaryTitle = canRenamePrimary && visibleStackRoot?.hostId ? () => {
    setRenamingSession({ scope: baseUrl, session: { ...visibleStackRoot, hostId: visibleStackRoot.hostId! } });
  } : undefined;
  const pageTitleBinding = (() => {
    if (!sharedWindow) return;
    const roots = [...primaryGroups, ...sharedWindow.views.filter(view => view.placement === 'dock'),
      ...sharedWindow.views.filter(view => view.placement === 'float')];
    return roots.find(view => view.binding)?.binding;
  })();
  const pageTitle = sharedWindow ? (pageTitleBinding && (confirmedTitles?.get(sessionKey(pageTitleBinding)) ?? pageTitleBinding.title)) || sharedWindow.title : featureSource?.title;
  useEffect(() => {
    document.title = pageTitle?.trim() ? `${pageTitle.trim()} · Agent Remote Control` : 'Agent Remote Control';
    return () => { document.title = 'Agent Remote Control'; };
  }, [pageTitle]);
  const stackPath = sidePath(visibleStackRoot, sideSessions, sideSelections, viewKey).map((session) => ({
    ...session, title: forkStore.find(session)?.firstInput?.trim().slice(0, 72) || session.title,
  }));
  const selectedPathIndex = stackPath.findIndex(session => viewKey(session) === sideFocus);
  const sharedDesktopAnchor = sharedWindow && !compactLayout && selectedPathIndex >= 0
    ? stackPath[Math.min(stackPath.length - 1, selectedPathIndex + 1)] : undefined;
  const stackRange = expandedSideRange(stackPath, compactLayout ? sideFocus : sharedDesktopAnchor ? viewKey(sharedDesktopAnchor) : sideAnchor, compactLayout ? 1 : 2, viewKey);
  const expandedKeys = new Set(stackPath.slice(stackRange.start, stackRange.end + 1).filter(session => !sharedViewForSlot(viewKey(session))?.collapsed).map(viewKey));
  const focusedWindow = stackPath.find(session => viewKey(session) === sideFocus) ?? stackPath[stackRange.end];
  const focusedPathIndex = focusedWindow ? stackPath.indexOf(focusedWindow) : 0;
  const primaryExpanded = detachedSideRoot ? !!stackRoot && expandedKeys.has(viewKey(stackRoot)) : stackRange.start === 0 && (!stackRoot || expandedKeys.has(viewKey(stackRoot)));
  const addressSession = stackPath.find((session) => viewKey(session) === sideFocus) ?? visibleStackRoot;
  const focusedBinding = directoryView?.binding;
  const focusedMenuSession = sharedWindow ? focusedBinding && {
    hostId: focusedBinding.hostId, providerId: focusedBinding.providerId, nativeSessionId: focusedBinding.nativeSessionId,
    title: focusedBinding.title, parentNativeSessionId: focusedBinding.parentNativeSessionId,
    agentId: sessionEntries.find(entry => sessionKey(entry) === sessionKey(focusedBinding))?.agentId,
  } : addressSession;
  const focusedSessionKey = focusedMenuSession && sessionKey(focusedMenuSession);
  const focusedMenuStatus = focusedMenuSession?.agentId === state?.agent?.id ? state?.agent?.status
    : sessionEntries.find(entry => sessionKey(entry) === focusedSessionKey)?.status;
  const focusedAskSlot = directoryView && sharedSlots?.get(directoryView.id);
  const focusedAskSession = sharedWindow ? focusedAskSlot && directoryView?.binding
    && sessionKey(compositionSelection(focusedAskSlot)) === sessionKey(directoryView.binding)
    ? compositionSession(focusedAskSlot) : undefined : addressSession;
  const focusedAskOwner = focusedAskSession ? succession.ownerFor(viewKey(focusedAskSession)) : undefined;
  const focusedAskEntry = focusedAskSession && focusedAskOwner ? ask.entryFor(focusedAskSession, focusedAskOwner) : undefined;
  const focusedAskState = focusedAskSession?.agentId === state?.agent?.id ? state
    : focusedAskSession ? replicaFor(focusedAskSession.agentId).getState() : undefined;
  const canOpenFocusedAsk = !!directory && !!focusedAskSession && accessReady && !transitioning
    && remoteHosts.find(host => host.id === focusedAskSession.hostId)?.online !== false
    && (!!focusedAskEntry?.record?.target || sourceCurrent(focusedAskSession) && !!focusedAskState?.agent);
  const refreshRelations = useSessionRelations(baseUrl, userScoped && accessReady, forkStore, ask.store, addressSession ? sessionKey(addressSession) : undefined, userScoped);
  const pendingSideSources = useRef(new Map<string, OpenedSession>());
  useLayoutEffect(() => {
    for (const record of forkStore.all()) {
      if (record.navigationSource) pendingSideSources.current.set(record.id,record.navigationSource);
      if (sideLinkVisible(record) || !record.target || appliedUnlinks.get(record.id) === (record.revision ?? 0)) continue;
      const navigationSource = pendingSideSources.current.get(record.id) ?? sideNavigationSource(record);
      pendingSideSources.current.delete(record.id);
      const navigationTarget = sideNavigationTarget(record)!;
      const sourceView = stackPath.find(session => sessionKey(session) === sessionKey(navigationSource)), targetView = sideSessions.find(session => sessionKey(session) === sessionKey(navigationTarget));
      if (!sourceView || !targetView) continue;
      appliedUnlinks.set(record.id, record.revision ?? 0);
      if (sharedWindow) {
        const target = sharedViewForSlot(viewKey(targetView));
        if (!target?.attachedTo) continue;
        const { schemaVersion: _, id: __, revision: ___, ...layout } = sharedWindow;
        windowWorkspace.authority?.operate({ type: 'layout.apply', layout: { ...layout, selectedViewId: target.id,
          views: sharedWindow.views.map(view => {
            if (view.id !== target.id) return view;
            const { attachedTo: ____, ...independent } = view;
            return { ...independent, placement: 'dock', collapsed: false };
          }) } });
        nextSideRequest(navigationSource);
        letterRequest.current?.abort();
        continue;
      }
      trackedViews.unlink(viewKey(sourceView), viewKey(targetView));
      nextSideRequest(navigationSource);
      if (!visibleStackRoot) continue;
      const sourceKey = viewKey(sourceView), targetKey = viewKey(targetView);
      const current = { primary: visibleStackRoot, primarySlot: viewKey(visibleStackRoot), selections: sideSelections, focus: sideFocus, anchor: sideAnchor };
      const next = unlinkSideView(current, sourceKey, targetKey);
      if (next === current) continue;
        letterRequest.current?.abort();
      setSideSelections(values => values[sourceKey] === targetKey ? { ...values, [sourceKey]: null } : values);
      if (next.focus !== sideFocus) {
        setDetachedSideRoot(targetKey);
        const branch = sidePath(targetView, sideSessions, sideSelections, viewKey);
        if (!branch.some(session => viewKey(session) === sideAnchor)) setSideAnchor(sideFocus ?? targetKey);
      } else {
        setSideFocus(next.focus);
        setSideAnchor(next.anchor);
      }
    }
  }, [forkStore, forkRevision, appliedUnlinks, trackedViews, visibleStackRoot, sideSessions, sideSelections, sideFocus, sideAnchor, sharedWindow]);

  async function unlinkSide(record: SessionFork): Promise<void> {
    await refreshRelations.setLinked(record, false);
    const unlinked = forkStore.get(record.id);
    toast?.show(`unlink-side:${record.id}`, 'Side session unlinked', 'The conversation is still available as an independent session.', 'info', {
      label: 'Undo', onClick: async () => { await refreshRelations.setLinked(unlinked, true); },
    });
  }
  function sourceCurrent(source: OpenedSession): boolean {
    if (initialState && !succession.active) {
      const id = (source as { viewId?: string }).viewId;
      const agent = initialState.agent, slot = succession.document.slots.find(slot => slot.id === id);
      return !!slot && sessionKey(compositionSelection(slot)) === sessionKey(source) && agent?.id === source.agentId
        && agent.providerId === source.providerId && agent.runtimeInfo.sessionId === source.nativeSessionId;
    }
    return succession.sourceCurrent(source);
  }
  function assertSourceCurrent(source: OpenedSession): void {
    if (!accessReadyRef.current || mountedTransport.current !== transport || !sourceCurrent(source)) throw new Error('The source session changed. Wait for its current native identity before continuing.');
  }
  function openAsk(source: OpenedSession, sourceState: AgentReplicaState | undefined, clean = false) {
    askView.setVisible(true);
    const associationOwner = succession.ownerFor(viewKey(source));
    const existingOnly = !clean && !!ask.entryFor(source, associationOwner).record?.target;
    const requireSource = () => {
      if (!existingOnly) { assertSourceCurrent(source); return; }
      const slot = succession.document.slots.find(slot => slot.id === viewKey(source));
      if (!accessReadyRef.current || mountedTransport.current !== transport || !slot || sessionKey(compositionSelection(slot)) !== sessionKey(source)) {
        throw new Error('The Ask source reference changed. Wait for its current identity before retrying.');
      }
    };
    try { requireSource(); } catch (error) { setFailure(message(error, 'Ask could not open.')); return; }
    void ask.open(sourceState, source, '', clean, { associationOwner, existingOnly, synchronize: async () => {
      requireSource(); await refreshRelations(); requireSource();
    } }).catch(error => setFailure(message(error, 'Ask could not open.')));
  }

  useEffect(() => {
    if (succession.active && !succession.binding) return;
    focusCatchUp(addressSession ? replicas.get(addressSession.agentId) : undefined);
  }, [addressSession?.agentId, succession.active, succession.binding, replicas, focusCatchUp]);
  const primaryIsBound = succession.active ? succession.isCurrent() : initialState?.agent?.id === stackRoot?.agentId || (primaryBinding.current?.baseUrl === baseUrl
    && primaryBinding.current.transport === transport && primaryBinding.current.agentId === stackRoot?.agentId);
  const openWindows = useMemo(() => sharedWindow ? sharedWindow.views.flatMap(view => {
    if (!view.binding || !windowPrimaryViewId(sharedWindow, view.id) && !mountedViewSessions[view.id]) return [];
    const mounted = mountedViewSessions[view.id], slot = sharedSlots?.get(view.id);
    const session = mounted && sessionKey(mounted) === sessionKey(view.binding) ? mounted : slot && compositionSession(slot);
    return session && sessionKey(session) === sessionKey(view.binding) ? [{ ...session, title: view.binding.title }] : [];
  }) : [...(stackRoot && primaryIsBound ? [stackRoot] : []), ...sideSessions], [sharedWindow, mountedViewSessions, sharedSlots, stackRoot, primaryIsBound, sideSessions]);
  function isViewVisible(slotId: string) {
    if (!sharedWindow) return expandedKeys.has(slotId);
    const view = sharedViewForSlot(slotId);
    if (!view) return false;
    let root = view;
    while (root.attachedTo) {
      const parent = sharedWindow.views.find(item => item.id === root.attachedTo);
      if (!parent) return false;
      root = parent;
    }
    if (compactLayout) return presentedViewId === view.id;
    return !view.collapsed && !root.collapsed;
  }
  const askSources = useMemo(() => {
    const slots = new Map(succession.document.slots.map(slot => [slot.id, slot]));
    return succession.document.asks.flatMap(owner => {
      const slot = slots.get(owner.sourceSlot), source = slot && compositionSession(slot);
      return source ? [{ owner: owner.id, source }] : [];
    });
  }, [succession.document, succession.document.editRevision]);
  const askActivitySessions = useMemo(() => askSources.flatMap(({ source, owner }) => {
    const entry = ask.entryFor(source, owner);
    const expanded = ask.isOpen(source, owner);
    if (!ask.isEnabled(source, owner) || !entry.record?.target || expanded && !entry.attached) return [];
    return [{ session: entry.record.target,
      visible: resolveAskPresentation({ window: sharedWindow, view: ask.sharedView(owner), visible: askSurfaceVisible, expanded, compact: compactLayout }).shown,
      liveAgentId: entry.attached ? entry.record.target.agentId : undefined }];
  }), [askSources, ask.revision, askSurfaceVisible, sharedWindow, compactLayout]);
  useEffect(() => {
    replicas.retain([
      ...connections.agentIds,
      ...(primaryBinding.current?.agentId ? [primaryBinding.current.agentId] : []),
      ...sideSessions.map(session => session.agentId),
      ...askActivitySessions.filter(item => item.visible).map(item => item.session.agentId),
      ...(addressSession ? [addressSession.agentId] : []),
    ]);
  });
  const visibleWindows = openWindows.filter(session => activeView === 'workbench' && !supportingRailOpen && isViewVisible(viewKey(session)));
  const attention = useSessionAttention(baseUrl, userScoped && accessReady, item => {
    setActiveView('workbench'); closeContext(); setInspectorOpen(false);
    const target = openWindows.find(session => sessionKey(session) === sessionKey(item));
    if (target) { revealSession(target); return; }
    const source = openWindows.find(session => {
      const entry = ask.entryFor(session, succession.ownerFor(viewKey(session)));
      return entry.record?.target && sessionKey(entry.record.target) === sessionKey(item);
    });
    if (source) { revealSession(source); openAsk(source, replicas.get(source.agentId)?.getState()); }
    else void openSession(item, undefined, undefined, false, undefined, 'history');
  });
  const notificationTargets = JSON.stringify([...openWindows, ...askActivitySessions.map(entry => entry.session)].map(sessionKey).sort());
  useEffect(() => {
    attention.notifier.setDisplayed(attention.enabled ? [...openWindows, ...askActivitySessions.map(entry => entry.session)] : []);
  }, [attention.notifier, notificationTargets, attention.enabled]);
  const tracking = useSessionTracking(baseUrl, transport, addressSession ? sessionKey(addressSession) : undefined, openWindows, askActivitySessions, connections, accessReady && succession.observerReady, visibleWindows, attention.observe);
  useEffect(() => { if (succession.observerReady) trackedViews.retain(tracking.sessions.map(trackEntryId)); }, [trackedViews, tracking.sessions, succession.observerReady]);
  const applySessionTitle = useCallback((session: StarInput) => {
    setConfirmedTitleState(current => {
      const titles = current?.scope === baseUrl ? current.titles : undefined;
      if (titles?.get(sessionKey(session)) === session.title) return current;
      return { scope: baseUrl, titles: new Map(titles).set(sessionKey(session), session.title) };
    });
    const update = (items: OpenedSession[]) => {
      if (!items.some(item => sessionKey(item) === sessionKey(session) && item.title !== session.title)) return items;
      return items.map(item => sessionKey(item) === sessionKey(session) ? { ...item, title: session.title } : item);
    };
    succession.updateTitles([session]);
    setOpenedSessions(update); setSideSessions(update); tracking.rename(session);
  }, [baseUrl, tracking.rename, succession.document]);
  const titleProjection = useRef<ReadonlyMap<string, string>>();
  useEffect(() => {
    if (!sharedWindow || !confirmedTitles?.size || titleProjection.current === confirmedTitles) return;
    titleProjection.current = confirmedTitles;
    let changed = false;
    const views = sharedWindow.views.map(view => {
      const title = view.binding && confirmedTitles.get(sessionKey(view.binding));
      if (title === undefined || title === view.binding!.title) return view;
      changed = true; return { ...view, binding: { ...view.binding!, title } };
    });
    if (!changed) return;
    const { schemaVersion: _, id: __, revision: ___, ...layout } = sharedWindow;
    try { editWindow({ type: 'layout.apply', layout: { ...layout, views } }); }
    catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }, [sharedWindow?.id, sharedWindow?.revision, confirmedTitles]);
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
      setSideSelections(values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === fromId ? toId : value])));
      setSideFocus(value => value === fromId ? toId : value);
      setSideAnchor(value => value === fromId ? toId : value);
      setDetachedSideRoot(value => value === fromId ? toId : value);
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

  const navigationIntent = succession.navigationIntent;
  const navigationSession = windowWorkspace.unavailable ? undefined : succession.active ? (succession.binding ? addressSession : succession.desired?.roleKey ? succession.selected : undefined) : addressSession;
  const shareSession = navigationSession ?? (succession.active ? succession.selected : undefined);
  const conversationHistory = useConversationHistory(succession.discovering || navigationIntent.sessionIntent === 'history' && !succession.binding || compositionProtected && !succession.selected ? undefined : navigationSession, sessionEntries, (session, intent, keepOriginal, layout) => {
    const view = intent === 'history' ? undefined : resolveConversationLayout(succession.document, layout);
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
  useEffect(() => { if (!windowWorkspace.unavailable && !sharedWindow && succession.active && !succession.discovering) succession.captureLayout(); }, [activeCompositionLayout, windowWorkspace.unavailable, succession.discovering, succession.layoutRevision]);
  const traceScope = JSON.stringify([state?.agent?.id, state?.timeline.epoch]);
  const traceRequest = traceNavigation?.scope === traceScope ? traceNavigation : undefined;
  useEffect(() => {
    setTraceNavigation(previous => previous?.scope === traceScope ? previous : undefined);
  }, [traceScope]);
  function inspectTimelineEntry(key: string, view: 'workbench' | 'trace') {
    if (activeAgentId) setLetterReveals(values => { const next = { ...values }; delete next[activeAgentId]; return next; });
    setTraceNavigation({ scope: traceScope, key, view, requestId: ++traceRequestCounter.current });
    if (view === 'workbench' && stackRoot) revealSession(stackRoot);
    setActiveView(view);
  }

  function viewNavigation(rawSource: OpenedSession, sourceState?: AgentReplicaState, actions?: SessionViewNavigationActions) {
    const source = actions ? rawSource : viewSession(rawSource);
    const available = directory && accessReady && sourceCurrent(source) && !transitioning && remoteHosts.find(host => host.id === source.hostId)?.online !== false;
    return sessionViewNavigation({ source, state: sourceState, entries: sessionEntries,
      openSession: actions?.openSession ?? (available ? (session, intent) => openSession(session, undefined, undefined, false, undefined, intent) : undefined),
      openChildSession: actions?.openChildSession ?? (available ? child => openChildSession(child, source, sourceState) : undefined),
      communication: available ? letterNavigation(source, sourceState) : undefined,
      revealEntry: letterReveals[source.agentId],
    });
  }

  async function navigateAttribution(attribution: SessionAttribution): Promise<void> {
    const target = attribution.target;
    if (!target) return;
    if (target.kind === 'group') {
      if (target.groupType !== 'team' || teamRoster?.baseUrl !== baseUrl || !teamRoster.teams.some(team => team.id === target.groupId)) {
        throw new Error('This group is no longer available.');
      }
      teamView.setVisible(true);
      setTeamReveal({ baseUrl, teamId: target.groupId, requestId: crypto.randomUUID() });
      return;
    }
    const current = windowWorkspace.readWindow();
    setActiveView('workbench'); closeContext();
    if (compactLayout) setInspectorOpen(false);
    if (current) {
      const operation = attributionWindowOperation(current, target, attribution.value, crypto.randomUUID());
      if (operation.type === 'view.select') {
        let view = current.views.find(view => view.id === operation.viewId);
        while (view?.attachedTo) view = current.views.find(parent => parent.id === view!.attachedTo);
        const feature = parseWindowFeature(view?.feature);
        if (feature?.kind === 'ask') askView.setVisible(true);
        if (feature?.kind === 'tpm') tpmView.setVisible(true);
      }
      // Navigation finishes locally; Window save state owns background persistence feedback.
      void windowWorkspace.operate(operation).catch(() => {});
    } else if (!await openSession({ ...target, title: attribution.value }, undefined, undefined, false, undefined, target.sessionIntent)) {
      throw new Error('The related session could not be opened.');
    }
  }

  function nextSideRequest(source: OpenedSession): number {
    const key = sideRequestKey(source);
    const request = (sideRequests.current.get(key) ?? 0) + 1;
    sideRequests.current.set(key, request);
    return request;
  }
  function sideRequestKey(source: OpenedSession) {
    return (source as OpenedSession & { viewId?: string }).viewId ?? sessionKey(source);
  }
  function selectSide(source: OpenedSession, session: OpenedSession): void {
    if (sharedWindow) {
      const origin = sharedViewForSlot(viewKey(viewSession(source)));
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
      editWindow(operation);
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
  function closeSide(session: OpenedSession): void {
    letterRequest.current?.abort();
    const record = forkStore.find(session);
    const source = stackPath.find(candidate => sideSelections[viewKey(candidate)] === viewKey(session));
    if (!source) return;
    nextSideRequest(source);
    setSideSelections((current) => ({ ...current, [viewKey(source)]: null }));
    navigateSide(viewKey(source));
  }
  useEffect(() => {
    if (!sharedWindow && !compositionProtected && primaryExpanded && stackRoot && sideFocus === viewKey(stackRoot) && activeView === 'workbench') {
      const primary = workbenchPanelRef.current?.querySelector('.lab-primary-conversation');
      if (primary?.contains(document.activeElement)) return;
      primary?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    }
  }, [compositionProtected, sideFocus, primaryExpanded, stackRoot?.agentId, activeView]);
  function focusPrimaryContent(target: EventTarget): void {
    // Navigation and layout controls must not create a visit before performing their action.
    if (target instanceof Element && target.closest('.lab-conversation-history, .lab-session-heading-actions-trigger, .lab-timeline-tools-toggle, .lab-session-main-minimize')) return;
    sessionWindows.focus();
    if (stackRoot) focusSession(stackRoot);
  }
  function focusSession(session: OpenedSession): void {
    sessionWindows.focus();
    setSideFocus(viewKey(session));
  }

  function communicationSnapshots(source: OpenedSession, sourceState?: AgentReplicaState): CommunicationSnapshot[] {
    const snapshots = openWindows.map(session => ({ session, state: session.agentId === state?.agent?.id ? state : replicas.get(session.agentId)?.getState() }));
    return [...snapshots.filter(snapshot => sessionKey(snapshot.session) !== sessionKey(source)), { session: source, state: sourceState }];
  }
  function letterNavigation(source: OpenedSession, sourceState?: AgentReplicaState): CommunicationNavigation {
    const participants = communicationResolver(source, communicationSnapshots(source, sourceState));
    const visible = compactLayout ? [] : sharedWindow ? communicationFamily(source).flatMap(view => {
      if (!view.binding || view.collapsed) return [];
      return [{ ...view.binding, agentId: connections.find(view.binding)?.agentId ?? '', viewId: sharedSlots?.get(view.id)?.id }];
    }) : stackPath.slice(stackRange.start, stackRange.end + 1);
    return {
      direction: entry => communicationDirection(participants(entry).recipient, source, visible),
      open: entry => openCommunication(entry, source, sourceState),
    };
  }
  function communicationFamily(source: OpenedSession) {
    if (!sharedWindow) return [];
    let root = sharedViewForSlot(viewKey(source));
    while (root?.attachedTo) root = sharedWindow.views.find(view => view.id === root!.attachedTo);
    if (!root) return [];
    const path = [root];
    for (;;) {
      const child = sharedWindow.views.find(view => view.attachedTo === path.at(-1)!.id);
      if (!child) return path;
      path.push(child);
    }
  }
  async function openCommunication(entry: ProjectedTimelineEntry, source: OpenedSession, sourceState?: AgentReplicaState): Promise<void> {
    if (!directory || entry.item.type !== 'agent_communication') throw new Error('Session navigation is unavailable in this view.');
    letterRequest.current?.abort();
    const controller = new AbortController(); letterRequest.current = controller;
    const deadline = setTimeout(() => controller.abort(new Error('Opening the letter timed out. Retry when the Host is connected.')), 60000);
    assertSourceCurrent(source);
    const originView = sharedViewForSlot(viewKey(source));
    const originWindowId = sharedWindow?.id;
    const generation = navigationGeneration.current;
    const check = () => { assertSourceCurrent(source); controller.signal.throwIfAborted(); if (generation !== navigationGeneration.current) throw new Error('The workspace changed. Open the letter again.'); };
    const leases = new Map<string, ReturnType<ConversationConnections['acquire']>>();
    const snapshots = communicationSnapshots(source, sourceState);
    const attachParticipant = async (identity: SessionEntry): Promise<OpenedSession> => {
      check();
      const known = [...openWindows, ...openedSessionsRef.current].find(session => sessionKey(session) === sessionKey(identity));
      // Native agent addresses identify letter endpoints; they must not rename a saved conversation.
      const title = favorites.stars.find(session => sessionKey(session) === sessionKey(identity))?.title ?? known?.title ?? identity.title;
      const active = connections.find(identity);
      if (active) return { ...known, ...identity, title, agentId: active.agentId };
      if (known && known.agentId === state?.agent?.id && status === 'ready') return { ...known, title };
      const target = (identity.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, identity.hostId);
      const result = identity.parentNativeSessionId
        ? await target.attachChild(identity.providerId, identity.parentNativeSessionId, identity.nativeSessionId, controller.signal)
        : await target.attach(identity.providerId, identity.nativeSessionId, controller.signal);
      check();
      const opened = { ...known, ...identity, title, agentId: result.agentId };
      rememberSession(opened); return opened;
    };
    const observe = async (session: OpenedSession) => {
      let lease = leases.get(session.agentId);
      if (!lease) { lease = connections.acquire(session.agentId, replicaFor(session.agentId), session); leases.set(session.agentId, lease); }
      await waitForCommunicationSession(lease.client, controller.signal); check(); return lease;
    };
    try {
      let pair = communicationResolver(source, snapshots)(entry);
      // A child opened directly may not have its parent's native reference in view yet.
      if ((!pair.sender || !pair.recipient) && source.parentNativeSessionId) {
        const parent = await attachParticipant({ hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.parentNativeSessionId, title: 'Parent conversation' });
        const lease = await observe(parent);
        for (;;) {
          check();
          const parentState = lease.replica.getState();
          pair = communicationResolver(source, [...snapshots, { session: parent, state: parentState }])(entry);
          if (pair.sender && pair.recipient || !parentState.timeline.hasOlder) break;
          const before = parentState.timeline.entries[0]?.seqStart;
          await lease.client.loadOlder();
          if (before === lease.replica.getState().timeline.entries[0]?.seqStart) break;
        }
      }
      if (!pair.sender || !pair.recipient || sessionKey(pair.sender) === sessionKey(pair.recipient)) {
        throw new Error('This history does not identify both sessions unambiguously. Load their agent activity and retry.');
      }
      if (originView && originWindowId) {
        const sourceKey = sessionKey(source);
        const endpoint = sourceKey === sessionKey(pair.sender) ? 'recipient' : sourceKey === sessionKey(pair.recipient) ? 'sender' : undefined;
        if (!endpoint) throw new Error('This conversation is not an endpoint of the letter.');
        const destination = await attachParticipant(endpoint === 'sender' ? pair.sender : pair.recipient);
        const recipient = endpoint === 'sender' ? source : destination;
        const revealSession = compactLayoutRef.current ? destination : recipient;
        const observation = await observe(revealSession);
        const target = await loadSessionCommunication(observation, entry, controller.signal, compactLayoutRef.current ? endpoint : 'recipient');
        check();
        const current = windowWorkspace.readWindow();
        const origin = current?.views.find(view => view.id === originView.id);
        if (current?.id !== originWindowId || !origin?.binding || sessionKey(origin.binding) !== sourceKey) throw new Error('The source view changed. Open the letter again.');
        const family = communicationFamily(source);
        const existing = family.find(view => view.binding && sessionKey(view.binding) === sessionKey(destination));
        const operations: WindowEdit[] = [];
        let destinationId = existing?.id;
        if (!destinationId) {
          const previous = current.views.find(view => view.attachedTo === origin.id);
          if (previous) operations.push({ type: 'view.close', viewId: previous.id });
          const child = { ...createWindowView(crypto.randomUUID(), windowSessionBinding(destination), 'attached'), attachedTo: origin.id };
          destinationId = child.id;
          operations.push({ type: 'view.create', view: child });
        }
        operations.push({ type: 'view.select', viewId: compactLayoutRef.current || endpoint === 'recipient' ? destinationId : origin.id });
        editWindow({ type: 'batch', operations });
        setLetterReveals(values => ({ ...values, [revealSession.agentId]: { ...target, align: 'start', requestId: ++traceRequestCounter.current } }));
        return;
      }
      if (compactLayoutRef.current) {
        const sourceKey = sessionKey(source);
        const endpoint = sourceKey === sessionKey(pair.sender) ? 'recipient' : sourceKey === sessionKey(pair.recipient) ? 'sender' : undefined;
        if (!endpoint) throw new Error('This conversation is not an endpoint of the letter.');
        const destination = await attachParticipant(endpoint === 'sender' ? pair.sender : pair.recipient);
        const observation = await observe(destination);
        const target = await loadSessionCommunication(observation, entry, controller.signal, endpoint);
        check();
        if (!await openSession(destination, undefined, undefined, true)) throw new Error('The linked session could not be opened.');
        // Opening the other endpoint intentionally advances the navigation generation.
        controller.signal.throwIfAborted();
        setLetterReveals(values => ({ ...values, [destination.agentId]: { ...target, align: 'start', requestId: ++traceRequestCounter.current } }));
        await new Promise(resolve => setTimeout(resolve, 0));
        return;
      }
      const recipient = await attachParticipant(pair.recipient);
      const receiver = await observe(recipient);
      const sender = await attachParticipant(pair.sender);
      const target = await loadSessionCommunication(receiver, entry, controller.signal);
      check();
      const present = [sender, recipient].every(session => stackPath.slice(stackRange.start, stackRange.end + 1).some(visible => sessionKey(visible) === sessionKey(session)));
      if (!present) {
        const root = stackRoot && [sender, recipient].find(session => sessionKey(session) === sessionKey(stackRoot));
        if (root) selectSide(root, sessionKey(root) === sessionKey(sender) ? recipient : sender);
        else if ([sender, recipient].every(session => stackPath.some(visible => sessionKey(visible) === sessionKey(session)))) {
          const last = Math.max(...[sender, recipient].map(session => stackPath.findIndex(visible => sessionKey(visible) === sessionKey(session))));
          setSideAnchor(viewKey(stackPath[last]!));
        } else {
          const origin = sessionKey(source) === sessionKey(recipient) ? recipient : sender;
          if (!await openSession(origin, undefined, undefined, true)) throw new Error('The sending session could not be opened.');
          selectSide(origin, sessionKey(origin) === sessionKey(sender) ? recipient : sender);
        }
      }
      setSideFocus(viewKey(viewSession(recipient))); setActiveView('workbench');
      setLetterReveals(values => ({ ...values, [recipient.agentId]: { ...target, align: 'start', requestId: ++traceRequestCounter.current } }));
      // Mounted panes acquire their own leases before this temporary navigation lease is released.
      await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      clearTimeout(deadline); for (const lease of leases.values()) lease.release();
      if (letterRequest.current === controller) letterRequest.current = undefined;
    }
  }

  async function openFork(record: SessionFork): Promise<void> {
    letterRequest.current?.abort();
    if (!record.target || !directory || !sideLinkVisible(forkStore.get(record.id))) return;
    const saved = sideNavigationTarget(record)!;
    const source = sideNavigationSource(record);
    const request = nextSideRequest(source);
    const target = (saved.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, saved.hostId);
    try {
      const result = await target.attach(saved.providerId, saved.nativeSessionId);
      const session = { ...saved, agentId: result.agentId };
      if (sessionKey(saved) === sessionKey(record.target)) {
        forkStore.bind(record.id, session);
        await configureFork(transport, forkStore, forkStore.get(record.id));
      } else forkStore.followEditedSide(record.id, saved, session);
      rememberSession(session);
      if (sideRequests.current.get(sideRequestKey(source)) === request && sideLinkVisible(forkStore.get(record.id)) && sessionKey(session) !== sessionKey(source)) selectSide(source, session);
    } catch (error) {
      if (sideRequests.current.get(sideRequestKey(source)) === request) setFailure(message(error, 'Forked session could not be opened.'));
    }
  }

  async function createFork(sourceState: AgentReplicaState, saved: OpenedSession | undefined, id: string, args: string): Promise<AgentCommandResult> {
    letterRequest.current?.abort();
    const agent = sourceState.agent;
    if (!directory || !agent?.runtimeInfo.sessionId) throw new Error('This session cannot be forked.');
    const source = viewSession(saved ?? { agentId: agent.id, nativeSessionId: agent.runtimeInfo.sessionId, providerId: agent.providerId, title: 'Conversation', hostId: 'local' });
    assertSourceCurrent(source);
    const associationOwner = succession.ownerFor(viewKey(source));
    if (id === 'console:ask' && ['', 'on', 'off', 'enable', 'disable'].includes(args.trim().toLowerCase())) return askView.execute(args);
    if (id === 'console:ask') {
      askView.setVisible(true);
      return ask.open(sourceState, source, args, false, { associationOwner, synchronize: async () => { assertSourceCurrent(source); await refreshRelations(); assertSourceCurrent(source); } });
    }
    if (forkBusy.current) throw new Error('A session fork is already being created.');
    forkBusy.current = true;
    try {
      const target = (source.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
      const key = JSON.stringify([sessionKey(source), id, args]);
      let record = forkReservation.current?.key === key ? forkStore.get(forkReservation.current.record.id) : forkStore.all().find((fork) => fork.creationKey === key);
      if (!record) {
        const quota = remoteHosts.find((host) => host.id === source.hostId)?.sessionQuota;
        if (quota && quota.used >= quota.limit) throw new Error('Session creation limit reached. Existing sessions remain available. Ask the owner to raise your limit.');
        const context = id === 'console:side' ? referenceForkContext(source) : await captureForkContext(transport, source);
        const settings = (agent.runtimeInfo.settings ?? []).filter((setting) => setting.mutable && setting.scope === 'session' && setting.value !== null).map(({ id, value }) => ({ id, value }));
        let options: CreateSessionOptions;
        if ((source.hostId ?? 'local') !== 'local' && source.providerId === 'dsh') {
          const workspaces = (await target.workspaces(source.providerId)).workspaces;
          const workspace = workspaces.find(({ path }) => path === agent.cwd);
          if (agent.cwd && !workspace) throw new Error('The source workspace is no longer registered on this Host.');
          options = workspace ? { workspaceId: workspace.id } : {};
        } else options = { ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model && source.providerId !== 'dsh' ? { model: agent.model } : {}),
          ...(agent.capabilities.planning && source.providerId !== 'dsh' ? { planning: agent.runtimeInfo.planning?.active === true } : {}) };
        if (context.mode === 'reference') { options.sourceNativeSessionId = source.nativeSessionId; options.conversationKind = 'side'; }
        else options.creationSource = { providerId: source.providerId, nativeSessionId: source.nativeSessionId };
        record = forkStore.prepare(context, options, settings, key);
        forkReservation.current = { key, record };
      }
      assertSourceCurrent(source);
      let result: { agentId: string; nativeSessionId?: string };
      if (record.target) result = await target.attach(record.target.providerId, record.target.nativeSessionId);
      else {
        try { result = await target.create(source.providerId, record.id, record.options); }
        finally { if (source.hostId && source.hostId !== 'local') retryHosts(); }
      }
      const session = viewSession({ agentId: result.agentId, nativeSessionId: result.nativeSessionId ?? result.agentId, providerId: source.providerId,
        hostId: source.hostId ?? 'local', title: `Fork of ${source.title}`, createdAt: record.capturedAt });
      forkStore.bind(record.id, session);
      assertSourceCurrent(source);
      await configureFork(transport, forkStore, forkStore.get(record.id));
      assertSourceCurrent(source);
      rememberSession(source); rememberSession(session);
      setDirectoryRevision((value) => value + 1);
      const draft = draftBindingFor(session);
      if (args.trim()) draft.store.set(draft.key, args.trim());
      if (id === 'console:side' && sideLinkVisible(forkStore.get(record.id))) selectSide(source, session);
      assertSourceCurrent(source);
      if (args.trim() && forkStore.get(record.id).delivery !== 'sent') {
        setForkInputStatus({ agentId: session.agentId, pending: true });
        try { await sendForkInput(transport, forkStore, forkStore.get(record.id), args.trim()); }
        catch (error) { setForkInputStatus({ agentId: session.agentId, pending: false, error: message(error, 'The first fork input failed.') }); throw error; }
        setForkInputStatus(undefined);
        if (draft.store.get(draft.key) === args.trim()) draft.store.set(draft.key, '');
      }
      forkStore.finishCreation(record.id);
      forkReservation.current = undefined;
      return {};
    } finally { forkBusy.current = false; }
  }

  const submittedClient = clientRef.current;
  function commandClient(): RemoteSessionClient {
    if (!accessReadyRef.current) throw new Error('Workspace access is restoring.');
    if (succession.active && !succession.isCurrent()) throw new Error('The current native session has not been confirmed.');
    if (!submittedClient || clientRef.current !== submittedClient) throw new RemoteOperationError('session_changed', 'The conversation changed before this action could be sent. Return to its original session to retry.', true);
    return submittedClient;
  }

  const [successionDialog, setSuccessionDialog] = useState<{ scope: string; source: OpenedSession; directory: SessionSuccessionDirectory; resume?: SessionSuccessionIntent['operation']; cancelRequested?: boolean; visible?: boolean; initialProvider?: string } | undefined>(() => {
    const saved = loadSuccessionIntent(baseUrl);
    return saved ? { scope: baseUrl, source: saved.source, resume: saved.operation, cancelRequested: saved.cancelRequested, visible: true, directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, saved.source.hostId)) } : undefined;
  });
  const primaryInputKey = JSON.stringify([baseUrl, stackRoot && sessionKey(stackRoot)]);
  const [pendingPrimaryInput, setPendingPrimaryInput] = useState<{ key: string; count: number }>();
  const [pendingGroupInputs, setPendingGroupInputs] = useState<Record<string, number>>({});
  const reportPendingPrimaryInput = useCallback((count: number) => setPendingPrimaryInput(current =>
    current?.key === primaryInputKey && current.count === count ? current : { key: primaryInputKey, count }), [primaryInputKey]);
  const pendingPrimaryCount = pendingPrimaryInput?.key === primaryInputKey ? pendingPrimaryInput.count : 0;
  const successionInputReason = successionDialog && (sharedWindow ? (pendingGroupInputs[viewKey(successionDialog.source)] ?? 0) > 0
    : stackRoot && sessionKey(successionDialog.source) === sessionKey(stackRoot) && pendingPrimaryCount > 0)
    ? 'Send or remove pending messages before handing off this conversation.' : undefined;
  const [successionGated, setSuccessionGated] = useState(() => !!loadSuccessionIntent(baseUrl));
  const canHandoffPrimary = !successionDialog && !!directory && userScoped && accessReady && !hostOffline && status === 'ready'
    && primaryIsBound && !transitioning && !detachedSideRoot && !boundFork && !sessionState.readOnly && !!stackRoot && !stackRoot.parentNativeSessionId
    && navigationIntent.sessionIntent !== 'history' && remoteHosts.some(host => host.id === stackRoot.hostId && host.access !== 'shared' && host.online);
  const openingControlNotice = nativeTakeover ? <SessionControlNotice
    control={{ access: 'read_only', available: false, nativeOwner: nativeTakeover.owner }}
    handoff={openingHandoff?.getState(nativeTakeover.owner.generation)} connected={accessReady && !hostOffline && !transitioning}
    onTakeControl={async options => {
      await openingHandoff!.run(nativeTakeover.owner.generation, async progress => {
        if (!directory || transitionRef.current || !accessReadyRef.current) throw new SessionHandoffRejectedError('Workspace access is restoring or another session is opening.');
        const opened = await openSession(nativeTakeover.item, progress.checkOnly ? undefined : nativeTakeover.owner.generation, progress.onRestoring);
        if (!opened) throw new Error('Session navigation changed before native restoration was confirmed.');
      }, options);
      setNativeTakeover(current => current === nativeTakeover ? undefined : current);
    }} /> : undefined;
  function assertSuccessionAccess() {
    if (!accessReadyRef.current || successionDialog?.scope !== baseUrl
      || !userScoped || !remoteHosts.some(host => host.id === successionDialog?.source.hostId && host.access !== 'shared' && host.online)) throw new Error('Authorized Host access is required to recover this Handoff.');
  }
  async function executePrimaryCommand(id: string, args: string): Promise<AgentCommandResult> {
    if (id === handoffCommand.id) {
      const initialProvider = handoffProvider(args);
      if (!canHandoffPrimary || !stackRoot) throw new Error('Handoff is available on the current main conversation with authorized Host access.');
      assertSourceCurrent(stackRoot);
      setSuccessionDialog({ scope: baseUrl, source: stackRoot, visible: true, initialProvider, directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, stackRoot.hostId)) });
      return {};
    }
    if (!state || status !== 'ready' || hostOffline) throw new Error('Wait for this session to finish synchronizing.');
    return createFork(state, activeOpened, id, args);
  }
  const primarySuccessionGated = successionGated && successionDialog?.scope === baseUrl && !!stackRoot &&
    (sessionKey(stackRoot) === sessionKey(successionDialog.source) || succession.desired?.operationId === successionDialog.resume?.operationId && !!successionDialog.resume);
  const contextTarget = succession.desired?.target.native;
  const successionContext = useSuccessionContext({ directory, operationId: succession.desired?.operationId,
    target: contextTarget?.controllerId ? { ...contextTarget, controllerId: contextTarget.controllerId } : undefined, enabled: userScoped && accessReady && !hostOffline && navigationIntent.sessionIntent !== 'history',
    refreshKey: `${state?.timeline.epoch}:${state?.timeline.entries.at(-1)?.seqEnd}:${pendingPrimaryCount}`,
  });
  const successionProgress = successionDialog ? <SessionSuccessionDialog
    source={successionDialog.source} directory={successionDialog.directory}
    blockedReason={successionInputReason}
    initialProvider={successionDialog.initialProvider} visible={successionDialog.visible}
    resume={successionDialog.resume} resumeCancellation={successionDialog.cancelRequested}
    onGatedChange={setSuccessionGated}
    onOpen={() => setSuccessionDialog(current => current ? { ...current, visible: true } : current)}
    onIntent={(operation, cancelRequested) => {
      saveSuccessionIntent(successionDialog.scope, { source: successionDialog.source, operation, cancelRequested });
      setSuccessionGated(true);
      setSuccessionDialog(current => current ? { ...current, resume: operation, cancelRequested } : current);
    }}
    assertAccess={assertSuccessionAccess} assertSource={() => { assertSuccessionAccess(); assertSourceCurrent(successionDialog.source); }}
    onSettled={async result => { assertSuccessionAccess(); await succession.refreshSettled(result, successionDialog.source); }}
    onClose={retain => {
      if (retain) setSuccessionDialog(current => current ? { ...current, visible: false } : current);
      else { clearSuccessionIntent(successionDialog.scope); setSuccessionGated(false); setSuccessionDialog(undefined); }
    }} /> : undefined;

  const clientActions: AppActions = actions ?? {
    takeControl: options => commandClient().takeControl(options),
    searchTimeline: submittedClient ? (query, options) => commandClient().searchTimeline(query, options) : undefined,
    loadSearchMatch: submittedClient ? (match, options) => commandClient().loadSearchMatch(match, options) : undefined,
    loadOlder: submittedClient ? () => commandClient().loadOlder() : undefined,
    sendMessage: async (text, options) => { await commandClient().sendMessage(text, options); },
    sendMessageContent: async (content, options) => { await commandClient().sendMessageContent(content, options); },
    uploadResource: (file, name, uploadId, options) => commandClient().uploadResource(file, name, uploadId, options),
    downloadResource: resourceId => commandClient().downloadResource(resourceId),
    uploadImage: (file, uploadId, options) => commandClient().uploadImage(file, uploadId, options),
    retryMessage: async (id) => { await commandClient().retryMessage(id); },
    deleteMessage: (id) => commandClient().deleteMessage(id),
    steer: async (text) => { await runMutation(() => commandClient().steer(text)); },
    cancel: async () => { await runMutation(() => commandClient().cancel()); },
    listCommands: () => commandClient().listCommands(),
    executeCommand: (id, args) => runMutation(() => commandClient().executeCommand(id, args)),
    setSessionSetting: async (id, value) => { await runMutation(() => commandClient().setSessionSetting(id, value)); },
    setPlanning: async (active) => { await runMutation(() => commandClient().setPlanning(active)); },
    respondToInteraction: async (requestId, response) => { await runMutation(() => commandClient().respondToInteraction(requestId, response)); },
    requestResource: async (binding) => (await commandClient().requestResource(binding.resourceId)).payload.state,
    resolveResource: (locator, sourceLocator) => commandClient().resolveResource(locator, sourceLocator),
    ...(fixtureAction && activeAgentId && state?.agent?.providerId === 'recorded' && !activeRemoteSession ? {
      advanceFixture: () => fixtureAction(activeAgentId, 'advance'),
      rehydrateFixture: () => fixtureAction(activeAgentId, 'rehydrate'),
      stopReader: () => fixtureAction(activeAgentId, 'stop-reader'),
    } : {}),
  };

  async function openScannedSession(target: ScannedSession) {
    const known = sessionEntries.find(entry => sessionKey(entry) === sessionKey(target));
    return openSession({ ...target, title: known?.title || target.nativeSessionId }, undefined, undefined, false, undefined, target.sessionIntent, target.keepOriginal);
  }

  const conversationActions = forkActions(clientActions, forkStore, boundFork, transport);
  // Retain message handlers so the composer can wait for readiness before sending.
  const availableConversationActions = accessReady && !hostOffline && status === 'ready' ? conversationActions : {
    sendMessage: conversationActions.sendMessage,
    sendMessageContent: conversationActions.sendMessageContent,
    deleteMessage: conversationActions.deleteMessage,
  };

  const { communication: primaryCommunication, ...primaryNavigation }: Partial<SessionViewNavigation> = stackRoot ? viewNavigation(stackRoot, state) : {};
  function renderAsk(source: OpenedSession, sourceState?: AgentReplicaState) {
    if (!directory) return null;
    const available = accessReady && sourceCurrent(source) && !transitioning && remoteHosts.find(host => host.id === source.hostId)?.online !== false;
    const associationOwner = succession.ownerFor(viewKey(source)), target = ask.entryFor(source, associationOwner).record?.target;
    const native = connections.find(source)?.client.getSessionState(), agent = sourceState?.agent;
    const independentRestore = succession.active && !succession.discovering && succession.result?.status === 'applied' && !!target
      && viewKey(source) !== succession.desired?.slot.id
      && sideSessions.some(side => sessionKey(side) === sessionKey(source)) && agent?.id === source.agentId
      && agent.providerId === source.providerId && agent.runtimeInfo.providerId === source.providerId && agent.runtimeInfo.sessionId === source.nativeSessionId
      && !!sourceState?.timeline.initialized && !!sourceState.timeline.epoch && !!native?.synchronized && native.runtime?.state === 'connected' && !native.controlChecking && !native.recovering;
    return <SessionAsk compact={compactLayout} key={associationOwner} associationOwner={associationOwner} imageRecipient={target ? succession.recipientFor(target, associationOwner) : undefined} source={source} ask={ask} storageScope={baseUrl}
      visible={askSurfaceVisible} triggerRef={askTriggerRef} onToggleEnabled={() => askView.setVisible(!askView.visible)}
      canRestore={accessReady && (!!target && !compositionProtected || available && (!compositionProtected || independentRestore))} synchronize={refreshRelations}
      onOpen={clean => openAsk(source, sourceState, clean)} replicaFor={replicaFor} transport={transport}
      navigation={viewNavigation} />;
  }
  function sessionViewPresentation(context: FamilySessionPresentationContext) {
    const source = { ...withConfirmedTitle(context.session), hostId: context.session.hostId ?? 'local', viewId: context.viewId! };
    const view = sharedWindow?.views.find(view => view.id === context.windowViewId);
    const isPrimary = view?.placement === 'primary';
    const fork = forkStore.find(source);
    const commands = forkActions(actions ?? context.actions, forkStore, fork, transport);
    const gated = successionGated && successionDialog?.scope === baseUrl && viewKey(successionDialog.source) === source.viewId;
    const host = remoteHosts.find(host => host.id === source.hostId);
    const available = accessReady && !context.offline && context.status === 'ready' && !context.pending && sourceCurrent(source);
    const handoffAvailable = available && isPrimary && !successionDialog && userScoped && !!directory && !source.parentNativeSessionId
      && !context.sessionState.readOnly && !context.operationBinding.historical && host?.access !== 'shared' && host?.online === true;
    const mayRename = userScoped && host?.online && host.access !== 'shared' && host.providers?.some(provider => provider.providerId === source.providerId && provider.sessionRename);
    const sourceForks = forkStore.linked().filter(item => item.target && sessionKey(sideNavigationSource(item)) === sessionKey(source));
    return {
      headingMode: compactLayout ? 'toolbar' as const : 'inline' as const,
      headingStart: !compactLayout && view?.id === primaryGroups[0]?.id ? <div ref={setSessionViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : undefined,
      state: forkDisplayState(context.state, fork),
      draftOnly: context.pending,
      questionDrafts: questionDrafts[source.agentId] ?? {},
      onQuestionDraftChange: (requestId: string, draft: QuestionDraft) => setQuestionDrafts(current => ({
        ...current, [source.agentId]: { ...current[source.agentId], [requestId]: draft },
      })),
      mutationBlocked: gated,
      onInspectEntry: (key: string) => {
        if (view) windowWorkspace.authority?.operate({ type: 'view.select', viewId: view.id });
        setTraceNavigation({ scope: JSON.stringify([context.state?.agent?.id, context.state?.timeline.epoch]), key, view: 'trace', requestId: ++traceRequestCounter.current });
        setActiveView('trace');
      },
      revealEntry: letterReveals[source.agentId] ?? (traceRequest?.view === 'workbench' && context.state?.agent?.id === state?.agent?.id ? traceRequest : undefined),
      onPendingInputChange: isPrimary ? (count: number) => setPendingGroupInputs(values => values[source.viewId] === count ? values : { ...values, [source.viewId]: count }) : undefined,
      actions: forkInputStatus?.pending && forkInputStatus.agentId === source.agentId ? { deleteMessage: commands.deleteMessage } : commands,
      consoleCommands: [...(available && directory && context.state?.agent?.capabilities.sendMessage && context.state.agent.capabilities.history ? forkCommands : []), ...(handoffAvailable ? [handoffCommand] : [])],
      onExecuteConsoleCommand: async (id: string, args: string): Promise<AgentCommandResult> => {
        assertSourceCurrent(source);
        if (id === handoffCommand.id) {
          if (!handoffAvailable) throw new Error('Handoff is available on a current main conversation with authorized Host access.');
          setSuccessionDialog({ scope: baseUrl, source, visible: true, initialProvider: handoffProvider(args), directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, source.hostId)) });
          return {};
        }
        if (!context.state || !available) throw new Error('Wait for this session to finish synchronizing.');
        return createFork(context.state, source, id, args);
      },
      composerStatus: gated || successionDialog && viewKey(successionDialog.source) === source.viewId ? successionProgress : undefined,
      headingContext: <SessionSuccessionHistory navigation={succession.historyNavigationFor(source)}
        onOpen={(session, intent) => view && sharedWindow
          ? bindDirectorySession({ ...session, sessionIntent: intent }, { windowId: sharedWindow.id, viewId: view.id, binding: JSON.stringify(view.binding ?? null) })
          : Promise.resolve(false)} />,
      composerContext: fork ? <ForkReference fork={fork} onOpen={revealSession} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} /> : undefined,
      composerNotice: <ForkEntries forks={sourceForks} selectedChild={selectedChildKey(source.viewId)} onOpen={record => void openFork({ ...record, navigationSource: source })} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} />,
      sessionManager: <>{context.controls}{isPrimary ? <button type="button" data-pane-selection-ignore aria-label={`Close primary group: ${source.title}`}
        title="Close this session view. Agent sessions keep running."
        onClick={() => windowWorkspace.authority?.operate({ type: 'view.close', viewId: view.id })}>×</button> : null}
        {!compactLayout ? <StarButton session={source} favorites={favorites} /> : null}
        <SessionHeadingActions sessionKey={sessionKey(source)} alwaysCollapsed={!!context.menuActions}>
          {context.menuActions}
          {isPrimary && (!compactLayout || succession.localViews().length > 0) && directory ? <ChatSessionManager current={source} entries={sessionEntries} busy={false}
            localViews={succession.localViews()} activeSlot={context.viewId} onOpenView={view => void openLocalView(view.slotId)}
            onOpen={item => void openSession(item, undefined, undefined, false, undefined, undefined, undefined, undefined, 'primary', view.id)} /> : null}
          {isPrimary && view.id === sharedWindow?.selectedPrimaryViewId ? <nav className="lab-conversation-history" aria-label="Conversation history">
            <button type="button" aria-label="Back to previous conversation" title="Back" disabled={!conversationHistory.canBack} onClick={conversationHistory.back}>←</button>
            <button type="button" aria-label="Forward to next conversation" title="Forward" disabled={!conversationHistory.canForward} onClick={conversationHistory.forward}>→</button>
          </nav> : null}
          <SessionLink session={available ? source : windowSessionBinding(source)} sessionIntent={context.operationBinding.historical ? 'history' : undefined} />
        </SessionHeadingActions></>,
      conversationPath: <SessionTitle className={isPrimary ? 'lab-primary-title' : undefined} title={source.title} status={context.state?.agent?.status}
        onRename={mayRename ? () => setRenamingSession({ scope: baseUrl, session: { ...source, hostId: source.hostId ?? 'local' } }) : undefined} />,
    };
  }
  if (windowWorkspace.unavailable) return <main className="lab-shell lab-window-unavailable">
    <div className="lab-window-recovery" data-deleted={windowWorkspace.deleted || undefined}>
      <p role="status">{windowWorkspace.deleted ? <><strong>Window deleted</strong>This page no longer has a valid Window. Choose another one or create a new one.</> : windowWorkspace.error ?? 'Opening Window…'}</p>
      <WindowWorkspaces workspace={windowWorkspace} />
    </div>
  </main>;
  return <SessionDescriptionsContext.Provider value={{ describe: session => describeSession({ session,
    sessions: [...favorites.stars, ...sessionEntries, ...tpmMainSessions.values()], forks: forkStore.all(), asks: ask.store.all(),
    tpmWorks: tpm.works, teams: teamRoster?.baseUrl === baseUrl ? teamRoster.teams : [],
    hostNames: new Map([['local', 'Lab server'], ...remoteHosts.map(host => [host.id, host.name] as const)]),
  }), navigate: navigateAttribution }}><SessionViewOperationsContext.Provider value={{ storageScope: baseUrl, transport, enabled: accessReady && activated, resolveTarget: (source, requested) => {
    const roster = teamRosterRef.current;
    const member = teamViewTarget(succession.document, roster?.baseUrl === baseUrl ? roster.teams : undefined, source, requested?.viewId);
    const result = succession.resolveTarget(source, { ...requested, ...(member ? { nativePrefixOnly: true } : {}) });
    if (member && sessionKey(member) !== sessionKey(result.target)) throw new Error('The Team execution locator is still synchronizing.');
    return { ...result, target: { ...result.target, ...(member ? { teamId: member.teamId, teamMemberId: member.teamMemberId } : {}) } };
  }, directory: source => labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, source.hostId)), refreshSettled: succession.refreshSettled }}><AskViewScope.Provider value={askView.execute}><WindowSessionBridgeContext.Provider value={windowWorkspace.sessionBridge}><WindowLayoutContext.Provider value={windowWorkspace.authority}><SessionDockProvider key={baseUrl} storageScope={baseUrl} enabled={!compactLayout && activeView === 'workbench'}
    leadingControls={sharedWindow && !primaryGroups.length && !compactLayout ? <div ref={setDockViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : undefined}><TeamViewScope.Provider value={teamView.execute}><TpmViewScope.Provider value={tpmView.execute}><TrackViewScope.Provider value={userScoped ? attention.executeTrack : undefined}><ConversationConnectionScope.Provider value={connections}><VscodeTunnelScope service={vscodeTunnelClient} host={previewHost} polling={compactLayout ? contextOpen : desktopContextVisible}><PreviewScope client={previewClient} host={previewHost} polling={compactLayout ? contextOpen : desktopContextVisible}><RecoveryScope.Provider value={readingPositions}><main ref={shellRef} onPointerDownCapture={focusManagedWindow} onFocusCapture={focusManagedWindow} style={sidebar.style} className={`lab-shell${headerHidden ? ' lab-header-hidden' : ''}${!compactLayout && !desktopContextVisible ? ' lab-context-hidden' : ''}${state?.agent ? ' lab-has-agent' : ''}${supportingRailOpen ? ' lab-supporting-open' : ''}${inspectorOpen ? ' lab-inspector-open' : ''}`}>
    {scanOpen ? <SessionTransferDialog onOpen={openScannedSession} onClose={() => setScanOpen(false)} /> : null}
    {activated ? tracking.observers : null}
    <WindowMenu workspace={windowWorkspace} current={sharedWindow ? directoryView?.binding : currentSession ? windowSessionBinding(currentSession) : undefined}
      visible={windowView.visible} inert={supportingRailOpen} />
    {userScoped && attention.trackVisible ? <SessionTrackingMenu catchUp={catchUp} tracking={tracking} teams={teamRoster?.baseUrl === baseUrl ? teamRoster.teams : []} knownSessions={[...favorites.stars, ...sessionEntries]} busy={transitioning} inert={supportingRailOpen} onOpen={item => void openTrackedSession(item)} /> : null}
    <TeamMenu visible={teamView.visible} baseUrl={baseUrl} enabled={accessReady && !!directory} hosts={remoteHosts} source={featureSource} sourceViewId={sharedWindow && presentedViewId ? `${sharedWindow.id}/${presentedViewId}` : undefined}
      compact={compactLayout} currentSession={focusedMenuSession} onTeamsChange={updateTeamRoster} reveal={teamReveal?.baseUrl === baseUrl ? teamReveal : undefined}
      onOpen={openTeamLayout} onOpenSession={target => openSession(target, undefined, undefined, false, undefined, undefined, undefined, undefined, compactLayout ? 'primary' : undefined)} />
    <TpmMenu tpm={tpm} open={tpmListOpen} onOpenChange={setTpmListOpen} mainSessions={tpmMainSessions} main={featureSource} visible={tpmView.visible} triggerRef={tpmTriggerRef} inert={supportingRailOpen} />
    <div className="lab-ask-workspaces" {...backgroundInert}>
      {askSurfaceVisible ? <AskButton triggerRef={askTriggerRef}
        disabled={!canOpenFocusedAsk} sourceTitle={focusedAskSession?.title}
        observation={focusedAskEntry?.record?.target ? tracking.observations[sessionKey(focusedAskEntry.record.target)] : undefined}
        onOpen={() => { if (canOpenFocusedAsk && focusedAskSession) openAsk(focusedAskSession, focusedAskState); }} /> : null}
      {askSources.flatMap(({ source, owner }) => {
        return ask.isOpen(source, owner)
          ? [renderAsk(source, source.agentId === state?.agent?.id ? state : replicaFor(source.agentId).getState())] : [];
      })}
    </div>
    <WindowPresentationContext.Provider value={presentedViewId}>
    <div className="lab-tpm-workspaces">{tpm.opened.map((key, index) => {
      const item = tpm.works.find(item => item.key === key);
      if (!item) return null;
      return <TpmWorkspace key={key} item={item} mainTitle={tpmMainSessions.get(sessionKey(tpmMainTarget(item)))?.title} session={tpm.sessions[key]} replica={tpm.sessions[key] ? replicaFor(tpm.sessions[key]!.agentId) : undefined}
        visible={tpmView.visible && tpm.windows.includes(key) && (!compactLayout || (sharedWindow ? presentedFeature?.kind === 'tpm' && presentedFeature.id === key : tpm.selected === key)) && !supportingRailOpen}
        layer={tpm.windows.indexOf(key) + 1} initialOffset={(index % 6) * 28} onFocus={() => { if (!sharedWindow) sessionWindows.focus(); tpm.focus(key); }} storageScope={baseUrl} triggerRef={tpmTriggerRef}
        transport={transport} draftBinding={{ store: messageDrafts, key: `tpm:${key}` }} navigation={viewNavigation}
        busy={!!tpm.busy} attaching={tpm.attaching[key] || tpm.detailsLoading[key]} error={tpm.detailErrors[key] ?? tpm.attachmentErrors[key]}
        onClose={() => tpm.close(key)} onShowList={() => setTpmListOpen(true)}
        onOpenMain={() => void openTpmMain(item)}
        onRename={title => tpm.rename(key, title)} onAction={action => tpm.action(key, action)} onConfirmTodo={decision => tpm.confirmTodo(key, decision)} onResolve={(id, resolution, nativeSessionId) => tpm.resolve(key, id, resolution, nativeSessionId)} onRetry={() => void tpm.open(key)} />;
    })}</div>
    {compactLayout ? <nav className="lab-mobile-navigation" aria-label="Session navigation" {...backgroundInert}>
      <button ref={sessionsTriggerRef} type="button" aria-label="Open sessions" aria-haspopup="dialog" aria-expanded={contextOpen} aria-controls="lab-context" onClick={() => { openContext(true); }}>Sessions</button>
      <div ref={setMobileViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />
      {userScoped ? <FavoritesMenu onScan={directory ? () => setScanOpen(true) : undefined} status={focusedMenuStatus} currentSession={focusedMenuSession} title={focusedMenuSession?.title || (sharedWindow ? 'Select session' : 'Agent Remote')} favorites={favorites} tracking={tracking} activeKey={focusedSessionKey} busy={transitioning && !sidebarWindow} onOpen={item => void openDirectorySession(item)} /> : stackPath.length > 1 ? <select className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === focusedWindow?.agentId)?.status} aria-label="Side path" value={focusedWindow ? sessionKey(focusedWindow) : ''} onChange={(event) => { const session = stackPath.find((entry) => sessionKey(entry) === event.target.value); if (session) revealSession(session); }}>
        {stackPath.map((session, index) => <option className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === session.agentId)?.status} key={sessionKey(session)} value={sessionKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
      </select> : <span className="lab-mobile-session-title agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === addressSession?.agentId)?.status}>{addressSession?.title || 'Agent Remote'}</span>}
      {userScoped && stackPath.length > 1 ? <div className="lab-mobile-side-path">
        <span aria-hidden="true">{focusedPathIndex === 0 ? 'Root' : `Side ${focusedPathIndex}`}</span><span className="lab-mobile-side-chevron" aria-hidden="true">▾</span>
        <select aria-label="Side path" value={focusedWindow ? sessionKey(focusedWindow) : ''} onChange={event => { const session = stackPath.find(entry => sessionKey(entry) === event.target.value); if (session) revealSession(session); }}>
          {stackPath.map((session, index) => <option key={sessionKey(session)} value={sessionKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
        </select>
      </div> : null}
    </nav> : null}
    <ViewOptions onCreateSessionView={createSessionView} attentionControls={<>
      {askView.controls}
      {windowView.controls}{userScoped ? attention.controls : null}{tpmView.controls}{teamView.controls}
    </>} target={!headerHidden ? headerViewTarget : compactLayout ? mobileViewTarget : desktopContextVisible ? sidebarViewTarget : activeView === 'trace' ? traceViewTarget : sharedWindow && !primaryGroups.length ? dockViewTarget ?? windowViewTarget : minimizedViewTarget ?? sessionViewTarget}
      triggerRef={viewTriggerRef} headerVisible={!headerHidden} sidebarVisible={contextVisible}
      inspectorVisible={inspectorOpen} compact={compactLayout} inert={supportingRailOpen}
      onSetAllVisible={setAllPanelsVisible} onToggleHeader={() => setHeaderHidden((value) => !value)} onToggleSidebar={toggleContext}
      onToggleInspector={() => inspectorOpen ? setInspectorOpen(false) : openInspector()} />
    <header className="lab-app-bar" hidden={headerHidden}>
      <div className="lab-brand">
        <div ref={setHeaderViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />
        <div>
          <p>Agent Remote Control</p>
          <h1>Agent conversations</h1>
        </div>
      </div>
      {accountAction ? <div className="gateway-account-actions">{accountAction}</div> : null}
      <details
        ref={connectionSummaryRef}
        className="lab-session-summary"
        data-testid="connection-summary"
        aria-label={`${connectionProviderName}. Agent ${connectionAgentId}. ${connectionStatusLabel}`}
        onBlur={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}
      >
        <summary aria-label="Connection details" title="Connection details"><span className={`lab-status-dot lab-status-${state?.agent?.status ?? 'disconnected'}`} aria-hidden="true" />
        <span>{connectionProviderName}</span>
        <span className="lab-connection-status" aria-live="polite">{connectionStatusLabel}</span><span aria-hidden="true">▾</span></summary>
        <div className="lab-connection-details"><strong>{connectionProviderName}</strong><code>{connectionAgentId}</code>
        {directory && activeAgentId ? <button type="button" className="lab-session-reconnect" disabled={transitioning} onClick={() => {
          const saved = openedSessions.find((item) => item.agentId === activeAgentId);
          if (saved) void openSession(saved); else attach(activeAgentId);
        }}>Reconnect</button> : null}
        </div>
      </details>
      <nav className="lab-view-switcher" role="tablist" aria-label="Observatory views" {...backgroundInert}>
        <button
          ref={workbenchTabRef}
          id="lab-workbench-tab"
          type="button"
          role="tab"
          aria-selected={activeView === 'workbench'}
          aria-controls="lab-workbench"
          tabIndex={activeView === 'workbench' ? 0 : -1}
          onClick={() => setActiveView('workbench')}
          onKeyDown={handleViewKeyDown}
        >Workbench</button>
        <button
          ref={traceTabRef}
          id="lab-trace-tab"
          type="button"
          role="tab"
          aria-selected={activeView === 'trace'}
          aria-controls="lab-trace"
          tabIndex={activeView === 'trace' ? 0 : -1}
          onClick={() => setActiveView('trace')}
          onKeyDown={handleViewKeyDown}
        >Trace</button>
      </nav>
    </header>
    <SupportingRail
      id="lab-context"
      label="Context"
      className="lab-context-rail"
      compact={compactLayout}
      collapsible
      open={contextVisible}
      triggerRef={compactLayout && contextFromSessions ? sessionsTriggerRef : viewTriggerRef}
      onClose={() => setContextOpen(false)}
    >
      <div className="lab-rail-heading">
        {!compactLayout ? <div ref={setSidebarViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : null}
        <p className="lab-eyebrow" title={baseUrl}>Window</p>
      </div>
      {!compactLayout ? <nav className="lab-sidebar-tabs" aria-label="Sidebar sections">
        <button type="button" aria-pressed={sessionPanel === 'list'} onClick={() => setSessionPanel('list')}>Sessions</button>
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'favorites'} onClick={() => { setSessionPanel('favorites'); void favorites.refresh(); }}>Favorites</button> : null}
        <button type="button" className="lab-sidebar-new" aria-pressed={sessionPanel === 'new'} onClick={() => setSessionPanel('new')}><span aria-hidden="true">＋</span> New session</button>
        <button type="button" aria-label="Sidebar settings" title="Settings" aria-pressed={sessionPanel === 'settings'} onClick={() => setSessionPanel('settings')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none" /></svg>
        </button>
      </nav> : null}
      {compactLayout ? <nav className="lab-session-panel-actions" aria-label="Sidebar sections">
        <button type="button" aria-pressed={sessionPanel === 'list'} onClick={() => setSessionPanel('list')}>Sessions</button>
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'favorites'} onClick={() => { setSessionPanel('favorites'); void favorites.refresh(); }}>Favorites</button> : null}
        <button type="button" aria-pressed={sessionPanel === 'settings'} onClick={() => setSessionPanel('settings')}>Settings</button>
      </nav> : null}
      {!compactLayout && sessionPanel !== 'settings' ? <div className="lab-session-open-target" role="status">Open in: <strong>{directoryView?.binding?.title ?? (directoryView ? 'Empty session view' : sidebarWindow?.target?.title ?? 'Main session')}</strong></div> : null}
      <div className="lab-sidebar-content">
      {sessionPanel === 'settings' ? <section className="lab-mobile-settings" aria-label="Controller settings">
        <MobileDisplaySettings />
        <CachePrivacySettings />
        <LayoutDiagnosticsSettings />
      </section> : null}
      {userScoped && sessionPanel === 'favorites' ? <section className="lab-session-directory lab-favorites-section" aria-label="Favorites"><div className="lab-directory-heading"><h2><FavoritesHeading loading={favorites.loading} /></h2></div><FavoritesList favorites={favorites} tracking={tracking} trackedOnly={trackedOnly} onFilterChange={setTrackedOnly} activeKey={focusedSessionKey} busy={transitioning && !sidebarWindow} onOpen={item => void openDirectorySession(item)} /></section> : null}
      {directory && sessionPanel !== 'favorites' ? <HostPairing compact={compactLayout && sessionPanel === 'list'} managementVisible={sessionPanel === 'settings'} service={hostClient} selectedHostId={selectedHost.id} selectionLocked={creationLocked || transitioning && !sidebarWindow} hosts={providers.length > 0 ? [{ id: 'local', name: 'Lab server', online: true }, ...remoteHosts] : remoteHosts} hostError={hostError ?? requestedHostUnavailable} onRetryHosts={retryHosts} onSelect={selectHost} /> : null}
      {(!compactLayout && sessionPanel === 'list') || sessionPanel === 'settings' ? selectedRemoteHost?.id === previewHost?.id ? <HostVscodeTunnel key={selectedRemoteHost?.id} />
        : <VscodeTunnelScope service={vscodeTunnelClient} host={selectedRemoteHost} polling={compactLayout ? contextOpen : desktopContextVisible}>
          <HostVscodeTunnel key={selectedRemoteHost?.id} />
        </VscodeTunnelScope> : null}
      {directory && userScoped ? <div hidden={sessionPanel !== 'settings'}><ControllerUpdates service={hostClient} hosts={remoteHosts} /></div> : null}
      {!compactLayout ? <>
      {sessionPanel === 'list' ? <HostPreviewGroups client={previewClient} hosts={remoteHosts} activeHostId={previewHost?.access !== 'shared' ? previewHost?.id : undefined} polling={compactLayout ? contextOpen : desktopContextVisible} onOpen={() => { if (compactLayout) { setContextOpen(false); setInspectorOpen(false); } }} onOpenSource={(sessionId, itemId, hostId) => void openPreviewSource(sessionId, itemId, hostId)} /> : null}
      </> : null}
      <div className="lab-directory-panel" hidden={sessionPanel !== 'list'}>
      {directory || providerChoices.length > 1 ? <label className="lab-browse-provider">Browse provider<select aria-label="Browse provider" value={selectedProviderChoice?.selectionId ?? ''} disabled={creationLocked || transitioning && !sidebarWindow || providerChoices.length === 0} onChange={(event) => selectProvider(event.target.value)}>{providerChoices.length === 0 ? <option value="">No providers available</option> : null}{providerChoices.map((provider) => <option key={provider.selectionId} value={provider.selectionId}>{provider.displayName}</option>)}</select></label> : null}
      {directory ? <SessionDirectory quickOpen={<button type="button" className="lab-session-scan-trigger" aria-label="Scan session QR code" onClick={() => setScanOpen(true)}>Scan</button>} favorites={favorites} searchable directory={directory} providerId={providerId} activeAgentId={focusedMenuSession?.agentId} opened={openedSessions} known={sessionEntries} sideStore={forkStore} askStore={ask.store} hostId={selectedHost.id} onOpenRelated={(item) => void openDirectorySession(item)} busy={!sidebarWindow && (transitioning || remoteHosts.find((host) => host.id === selectedHost.id)?.online === false)} revision={directoryRevision} onOpen={(item) => void openDirectorySession(item)} onSelect={(item) => void openDirectorySession(item)} onClose={(agentId) => setOpenedSessions((current) => current.filter((item) => item.agentId !== agentId))} /> : null}
      </div>
      {compactLayout ? <>
      {sessionPanel === 'list' ? <HostPreviewGroups client={previewClient} hosts={remoteHosts} activeHostId={previewHost?.access !== 'shared' ? previewHost?.id : undefined} polling={compactLayout ? contextOpen : desktopContextVisible} onOpen={() => { if (compactLayout) { setContextOpen(false); setInspectorOpen(false); } }} onOpenSource={(sessionId, itemId, hostId) => void openPreviewSource(sessionId, itemId, hostId)} /> : null}
      </> : null}
      <div hidden={sessionPanel !== 'new'}>
      <ProviderSessionControls
        providers={providerChoices}
        selectedProviderId={selectedProviderChoice?.selectionId ?? ''}
        catalogStatus={selectedHost.id !== 'local' || (catalogStatus === 'empty' && providerChoices.length > 0) ? 'ready' : catalogStatus}
        catalogError={catalogError}
        creating={transitioning}
        unavailableReason={creationUnavailableReason}
        planning={createPlanning}
        configurationLocked={creationLocked}
        onPlanningChange={providerId !== 'dsh' && !creationLocked ? setCreatePlanning : undefined}
        onRetryProviders={() => void loadProviders()}
        persistence={activeOpened?.parentAgentId || activeOpened?.parentNativeSessionId ? undefined : state?.agent?.persistence}
        onSelectedProviderChange={selectProvider}
        onCreateSession={() => void createAgent()}
        onResumeSession={activeRemoteSession || activeOpened?.parentAgentId || activeOpened?.parentNativeSessionId ? undefined : () => void resumeAgent()}
      >{directory ? <SessionConfiguration directory={directory} providerId={providerId} canBrowse={remoteHosts.find(host => host.id === selectedHost.id)?.access !== 'shared'} value={sessionOptions} disabled={transitioning || creationLocked || !!creationUnavailableReason} onChange={setSessionOptions} /> : null}</ProviderSessionControls>
      </div>
      <div hidden={sessionPanel !== 'settings'}>
      {clientActions.advanceFixture || clientActions.rehydrateFixture || clientActions.stopReader ? <RecordedPlaybackControls
        onAdvance={clientActions.advanceFixture}
        onRehydrate={clientActions.rehydrateFixture}
        onStopReader={clientActions.stopReader}
      /> : null}
      </div>
      {sessionNotice && !nativeTakeover && compactLayout && contextOpen ? <SessionConnectionNotice notice={sessionNotice} /> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
      </div>
      {compactLayout && sessionPanel !== 'new' ? <footer className="lab-session-panel-footer"><button type="button" onClick={() => setSessionPanel('new')}><span aria-hidden="true">＋</span> New session</button></footer> : null}
    </SupportingRail>
    {!compactLayout && contextVisible ? <SidebarResize width={sidebar.width} maximum={sidebar.maximum} onChange={sidebar.setWidth} /> : null}
    <PreviewWorkspace resourceScope={JSON.stringify([activeOpened?.hostId, activeAgentId, state?.timeline.epoch])} className="lab-main-stage" {...backgroundInert}>
      <section
        ref={workbenchPanelRef}
        className={sharedWindow ? 'lab-window-workbench' : (sessionNotice && !nativeTakeover && !(compactLayout && contextOpen)) || promptMigrations.notice ? 'lab-workbench-with-notice' : undefined}
        id="lab-workbench"
        data-testid="workbench"
        role="tabpanel"
        aria-labelledby="lab-workbench-tab"
        tabIndex={-1}
        hidden={activeView !== 'workbench'}
      >
        {sharedWindow && !primaryGroups.length && !compactLayout ? <div ref={setWindowViewTarget} data-pane-selection-ignore className="lab-global-view-slot lab-window-controls" /> : null}
        <div className="lab-session-windows">{sessionWindows.entries.map(entry => <SessionWindow key={entry.id} entry={entry} baseUrl={baseUrl}
          visible={activeView === 'workbench' && !supportingRailOpen && (!compactLayout || (sharedWindow ? presentedRootView?.id : sessionWindows.selectedId) === entry.id)} compact={compactLayout}
          closeWith={sessionWindows.entries.filter(child => child.closeWith === entry.id).map(child => child.id)}
          selected={sessionWindows.selectedId === entry.id} onFocus={() => sessionWindows.focus(sharedWindow ? entry.id : entry.managed ? undefined : entry.id)}
          onChangeSession={entry.managed ? undefined : () => chooseWindowSession(entry.id)}
          hostLabel={entry.target ? remoteHosts.find(host => host.id === entry.target!.hostId)?.name ?? entry.target.hostId : ''}
          offline={entry.target ? remoteHosts.find(host => host.id === entry.target!.hostId)?.online === false : false}
          actions={entry.groupId ? <TeamGatherButton baseUrl={baseUrl} entry={entry} onGather={targets => sessionWindows.gather(entry, targets)} /> : undefined}
          onSessionBound={entry.managed ? undefined : receiveViewSession}
          sessionPresentation={entry.managed ? undefined : sessionViewPresentation}
          transport={transport} draftStore={messageDrafts} {...windowDraftBinding(entry)} navigation={viewNavigation} onClose={() => sessionWindows.close(entry.id)} />)}</div>
        {sharedWindow && !sharedWindow.views.length ? <div className="lab-window-empty" data-testid="empty-window">
          <p>No session views</p><button type="button" onClick={createSessionView}>New session view</button>
        </div> : null}
        <div className="lab-ordinary-workspace" hidden={!!sharedWindow && (!sharedWindow.views.length || compactLayout && !presentedPrimaryViewId)}>
        {sessionNotice && !nativeTakeover && !(compactLayout && contextOpen) ? <SessionConnectionNotice notice={sessionNotice} /> : null}
        {succession.error && succession.error !== nativeTakeover?.message ? <p role="alert">{succession.error}{!nativeTakeover ? <button type="button" onClick={succession.retry}>{succession.result?.status === 'applied' ? 'Retry session' : 'Retry synchronization'}</button> : null}</p> : null}
        {promptMigrations.notice}
        {uncertainMutation ? <p className="lab-control-note" role="alert">The previous action may have completed before the connection was interrupted. Its result is unknown. It will not be replayed automatically.</p> : null}
        {sharedWindow ? <SessionDockRail compact={compactLayout} onCreateView={createSessionView}
          minimizedHeader={<div ref={setMinimizedViewTarget} data-pane-selection-ignore className="lab-global-view-slot lab-minimized-view-slot" />}
          onSelectPrimaryGroup={selectPrimaryGroup}
          onResizePrimaryGroup={(viewId, width) => windowWorkspace.authority?.operate({ type: 'view.resize', viewId, width })}
          onCollapsePrimaryGroup={(viewId, collapsed) => windowWorkspace.authority?.operate({ type: 'view.collapse', viewId, collapsed })}
          onClosePrimaryGroup={viewId => windowWorkspace.authority?.operate({ type: 'view.close', viewId })}
          primaryGroups={primaryGroups.map(view => {
            const pendingSlot = view.id === sharedWindow.selectedPrimaryViewId ? succession.displaySlot : undefined;
            const slot = sharedSlots?.get(view.id) ?? (pendingSlot && view.binding
              && [compositionSelection(pendingSlot), { hostId: pendingSlot.origin.target.hostId, ...pendingSlot.origin.target.native }]
                .some(source => sessionKey(source) === sessionKey(view.binding!)) ? pendingSlot : undefined);
            const additionalWidth = sharedWindow.views.filter(child => child.id !== view.id && windowPrimaryViewId(sharedWindow, child.id) === view.id && !child.collapsed).reduce((total, child) => total + child.width, 0);
            return { id: view.id, title: view.binding?.title ?? 'Select session', width: view.width, additionalWidth,
              selected: view.id === presentedPrimaryViewId, collapsed: view.collapsed,
              content: view.binding ? <PrimarySessionFamily baseUrl={baseUrl} storageScope={baseUrl} target={view.binding} viewId={view.id}
                sessionIntent={view.binding.sessionIntent}
                successionContext={succession.successionContextFor(slot?.id)}
                directoryFor={hostId => hostId === selectedHost.id ? directory : undefined}
                attachmentManaged={view.id === sharedWindow.selectedPrimaryViewId}
                attachedSession={succession.binding?.session.viewId === slot?.id ? succession.binding?.session : undefined}
                attachmentNotice={view.id === sharedWindow.selectedPrimaryViewId ? openingControlNotice : undefined}
                hostLabel={remoteHosts.find(host => host.id === view.binding!.hostId)?.name ?? view.binding.hostId}
                offline={remoteHosts.find(host => host.id === view.binding!.hostId)?.online === false}
                compact={compactLayout} active={activeView === 'workbench' && !supportingRailOpen && (!compactLayout || view.id === (presentedPrimaryViewId ?? sharedWindow.selectedPrimaryViewId))}
                transport={transport} draftStore={messageDrafts} replicaFor={replicaFor} onSessionBound={receiveViewSession}
                draftBinding={slot ? draftOwnerBinding(slot.owners.text) : undefined} imageDraftBinding={slot?.owners.image}
                displayBinding={{ scope: baseUrl, key: view.id }} navigation={viewNavigation}
                sessionPresentation={sessionViewPresentation} />
                : <div className="lab-empty-session-view" role="status" data-view-id={view.id} aria-current={view.id === presentedViewId || undefined}>
                  <header className="lab-empty-session-heading">
                    {!compactLayout && view.id === primaryGroups[0]?.id ? <div ref={setSessionViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : null}
                    <strong>Select session</strong>
                    <button type="button" data-pane-selection-ignore aria-label="Close primary group: Select session" title="Close session view"
                      onClick={() => windowWorkspace.authority?.operate({ type: 'view.close', viewId: view.id })}>×</button>
                  </header><p>This session view is empty.</p>
                  <button type="button" onClick={() => { selectPrimaryGroup(view.id); setSessionPanel('list'); setContextOpen(true); setDesktopContextVisible(true); }}>Choose session</button>
                  <button type="button" onClick={() => { selectPrimaryGroup(view.id); setSessionPanel('new'); setContextOpen(true); setDesktopContextVisible(true); }}>New session</button></div>,
            };
          })} /> : <SessionDockRail onCreateView={createSessionView} minimizedHeader={<div ref={setMinimizedViewTarget} data-pane-selection-ignore className="lab-global-view-slot lab-minimized-view-slot" />} mainTitle={stackRoot?.title ?? activeOpened?.title} minimumBaseWidth={stackRange.end > stackRange.start ? 640 : 320}><ConversationSplit compact={compactLayout} start={stackRange.start} end={stackRange.end}>
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(0, stackRange.start)} offset={0} onExpand={revealSession} />
        <ConversationPane className="lab-primary-conversation lab-session-composition" data-active={!sessionWindows.activeId || undefined} tabIndex={-1} hidden={!primaryExpanded} onFocusCapture={event => focusPrimaryContent(event.target)} onClickCapture={event => focusPrimaryContent(event.target)}>
        {windowSession.empty ? <div className="lab-empty-session-view" role="status"><p>This session view is empty.</p><button type="button" onClick={() => { setSessionPanel('new'); setContextOpen(true); setDesktopContextVisible(true); }}>New session</button>{successionProgress}</div> : <><CommunicationNavigationContext.Provider value={primaryCommunication}><LabWorkbench {...primaryNavigation}
          sessionIdentity={stackRoot ?? succession.selected ?? activeOpened}
          operationBinding={succession.binding ? { source: succession.binding.session, historical: navigationIntent.sessionIntent === 'history', scope: { agentId: succession.binding.session.agentId, client: succession.binding.client, replica: succession.binding.replica, transport, recipient: succession.imageRecipient, isCurrent: succession.binding.isCurrent } } : undefined}
          headingMode={compactLayout ? 'toolbar' : 'inline'}
          headingStart={primaryExpanded ? <div ref={setSessionViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : undefined}
          sessionState={!accessReady || hostOffline ? remoteSessionState(state, !accessReady ? 'connecting' : 'disconnected') : sessionState}
          handoff={handoff}
          draftSessionKey={succession.selected ? sessionKey(succession.selected) : stackRoot ? sessionKey(stackRoot) : activeAgentId}
          draftOnly={succession.active && !succession.isCurrent()}
          mutationBlocked={primarySuccessionGated}
          onPendingInputChange={reportPendingPrimaryInput}
          pendingFirstInputContext={successionContext && successionContext.state !== 'materialized' ? { state: successionContext.state, onRetry: successionContext.onRetry } : undefined}
          headingContext={succession.historyNavigation ? <SessionSuccessionHistory navigation={succession.historyNavigation} onOpen={(session, intent) => openSession(session, undefined, undefined, false, undefined, intent)} /> : undefined}
          composerStatus={successionProgress}
          imageDraftBinding={primaryDisplaySlot?.owners.image}
          imageRecipient={succession.imageRecipient}
          displayBinding={primaryDisplaySlot?.owners.display}
          onInspectEntry={key => inspectTimelineEntry(key, 'trace')}
          revealEntry={activeAgentId && letterReveals[activeAgentId] || (traceRequest?.view === 'workbench' ? traceRequest : undefined)}
          state={forkDisplayState(state, boundFork)} sessionStatus={!accessReady ? 'connecting' : hostOffline ? 'disconnected' : status} attachingAgentId={attachingAgentId} actions={forkInputStatus?.pending && forkInputStatus.agentId === activeAgentId ? { deleteMessage: conversationActions.deleteMessage } : availableConversationActions} visible={activeView === 'workbench' && primaryExpanded}
          consoleCommands={[...(status === 'ready' && !hostOffline && directory && state?.agent?.capabilities.sendMessage && state.agent.capabilities.history ? forkCommands : []), ...(canHandoffPrimary ? [handoffCommand] : [])]}
          onExecuteConsoleCommand={executePrimaryCommand}
          nativeTakeover={openingControlNotice}
          composerContext={boundFork ? <ForkReference fork={boundFork} onOpen={revealSession} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} /> : undefined}
          composerNotice={<ForkEntries forks={forkStore.linked().filter((fork) => fork.target && (sideNavigationSource(fork).agentId === activeAgentId || (activeOpened && sessionKey(sideNavigationSource(fork)) === sessionKey(activeOpened))))} selectedChild={stackRoot ? selectedChildKey(viewKey(stackRoot)) : undefined} onOpen={(fork) => void openFork(fork)} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} />}
          sessionManager={<><MinimizeMainSession />{!compactLayout && stackRoot ? <StarButton session={stackRoot} favorites={favorites} /> : null}<SessionHeadingActions sessionKey={stackRoot ? sessionKey(stackRoot) : activeAgentId}>{(!compactLayout || succession.localViews().length > 0) && directory && currentSession ? <ChatSessionManager current={currentSession} entries={sessionEntries} busy={transitioning || hostOffline} onOpen={(item) => void openSession(item)}
            localViews={succession.localViews()} activeSlot={succession.desired?.slot.id} onOpenView={view => void openLocalView(view.slotId)} /> : null}<nav className="lab-conversation-history" aria-label="Conversation history">
            <button type="button" aria-label="Back to previous conversation" title="Back" disabled={transitioning || !conversationHistory.canBack} onClick={conversationHistory.back}>←</button>
            <button type="button" aria-label="Forward to next conversation" title="Forward" disabled={transitioning || !conversationHistory.canForward} onClick={conversationHistory.forward}>→</button>
          </nav>{shareSession ? <SessionLink session={shareSession} sessionIntent={navigationIntent.sessionIntent} keepOriginal={navigationIntent.keepOriginal} /> : null}</SessionHeadingActions></>}
          conversationPath={ancestors.length > 0 ? <nav className="lab-conversation-path" aria-label="Conversation path">
            {ancestors.map((ancestor) => <span key={ancestor.agentId}>
              <button type="button" className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === ancestor.agentId)?.status} disabled={transitioning} onClick={() => { void openSession(ancestor); }}>{ancestor.title}</button>
              <span aria-hidden="true"> / </span>
            </span>)}
            <SessionTitle as="span" current title={activeOpened?.title ?? ''} status={state?.agent?.status} onRename={!detachedSideRoot ? renamePrimaryTitle : undefined} />
          </nav> : stackRoot ? <SessionTitle className="lab-primary-title" title={stackRoot.title} status={state?.agent?.status} onRename={!detachedSideRoot ? renamePrimaryTitle : undefined} /> : null}
          draftBinding={primaryDisplaySlot ? draftOwnerBinding(primaryDisplaySlot.owners.text) : undefined}
          questionDrafts={activeAgentId ? questionDrafts[activeAgentId] ?? {} : undefined}
          onQuestionDraftChange={activeAgentId ? (requestId, draft) => setQuestionDrafts((current) => ({
            ...current, [activeAgentId]: { ...current[activeAgentId], [requestId]: draft },
          })) : undefined}
        /></CommunicationNavigationContext.Provider>
        </>}
        </ConversationPane>
        {sideSessions.filter((session) => !stackRoot || viewKey(session) !== viewKey(stackRoot)).map((session) => <SideConversation
          headingMode={compactLayout ? 'toolbar' : 'inline'}
          key={viewKey(session)} session={session} replica={replicaFor(session.agentId)} standalone={viewKey(session) === detachedSideRoot} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)}
          onRenameTitle={viewKey(session) === detachedSideRoot ? renamePrimaryTitle : undefined}
          navigation={viewNavigation} transport={transport} store={forkStore} onActivityChange={observeSideActivity}
          headingStart={!primaryExpanded && session.agentId === stackPath[stackRange.start]?.agentId ? <><div ref={setSessionViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /><MinimizeMainSession /></> : undefined}
          position={stackPath.findIndex((entry) => viewKey(entry) === viewKey(session))}
          expanded={expandedKeys.has(viewKey(session))}
          focused={!compositionProtected && focusedWindow !== undefined && viewKey(focusedWindow) === viewKey(session)}
          selectedChild={selectedChildKey(viewKey(session))}
          initialInput={forkInputStatus?.agentId === session.agentId ? forkInputStatus : undefined}
          visible={activeView === 'workbench'} draftBinding={draftBindingFor(session)}
          imageDraftBinding={succession.document.slots.find(slot => slot.id === viewKey(session))!.owners.image}
          displayBinding={succession.document.slots.find(slot => slot.id === viewKey(session))!.owners.display}
          onFocus={() => focusSession(session)} onClose={() => closeSide(session)} onOpenSource={revealSession} onOpenFork={(fork) => void openFork(fork)} onFork={createFork} />)}
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(stackRange.end + 1)} offset={stackRange.end + 1} onExpand={revealSession} />
        </ConversationSplit></SessionDockRail>}
      </div>
      </section>
      <section
        id="lab-trace"
        data-testid="trace-view"
        role="tabpanel"
        aria-labelledby="lab-trace-tab"
        hidden={activeView !== 'trace'}
      >
        <TraceView key={traceScope} state={state} visible={activeView === 'trace'}
          headingStart={<div ref={setTraceViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />}
          sessionTitle={activeOpened?.title} sessionStatus={!accessReady ? 'connecting' : hostOffline ? 'disconnected' : status}
          revealEntry={traceRequest?.view === 'trace' ? traceRequest : undefined}
          onShowConversation={key => inspectTimelineEntry(key, 'workbench')}
          resolveSessionLink={primaryNavigation.resolveSessionLink} onLoadOlder={!hostOffline ? conversationActions.loadOlder : undefined} />
      </section>
    </PreviewWorkspace>
    {successionDialog && (activeView !== 'workbench' || !primaryExpanded) ? <button type="button" onClick={() => {
      setActiveView('workbench'); if (stackRoot) revealSession(stackRoot);
      setSuccessionDialog(current => current ? { ...current, visible: true } : current);
    }}>Recover Handoff</button> : null}
    {renamingSession?.scope === baseUrl ? <RenameSessionDialog favorites={favorites} session={renamingSession.session}
      onRenamed={session => { applySessionTitle(session); setDirectoryRevision(value => value + 1); }} onClose={() => setRenamingSession(undefined)} /> : null}
    <SupportingRail
      id="lab-inspector"
      label="Replica Inspector"
      className="lab-inspector-rail"
      collapsible
      compact={compactLayout}
      open={inspectorOpen}
      triggerRef={viewTriggerRef}
      onClose={() => setInspectorOpen(false)}
    >
      <div className="lab-rail-heading">
        <p className="lab-eyebrow">Replica Inspector</p>
        <span>Public replica state</span>
      </div>
      <ReplicaInspector state={state} sessionStatus={status} providerName={providerName} />
    </SupportingRail>
    </WindowPresentationContext.Provider>
  </main></RecoveryScope.Provider></PreviewScope></VscodeTunnelScope></ConversationConnectionScope.Provider></TrackViewScope.Provider></TpmViewScope.Provider></TeamViewScope.Provider></SessionDockProvider></WindowLayoutContext.Provider></WindowSessionBridgeContext.Provider></AskViewScope.Provider></SessionViewOperationsContext.Provider></SessionDescriptionsContext.Provider>;
}

function PreviewScope({ client, host, polling, children }: { readonly client: HttpPreviewClient; readonly host?: RemoteHost; readonly polling: boolean; readonly children: ReactNode }) {
  const enabled = !!host && host.access !== 'shared';
  return <PreviewProvider client={client} hostId={host?.id ?? ''} enabled={enabled} canManage={enabled} polling={polling}>{children}</PreviewProvider>;
}

function createAgentId(): string {
  return `lab-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

function isCompactLayout(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1180px)').matches;
}

function rememberedAgent(): string | undefined {
  const value = new URL(window.location.href).searchParams.get('agent');
  return value && value.length > 0 ? value : undefined;
}

function rememberAgent(agentId: string): void {
  if (window.history.state?.agentRemoteVisit) return;
  const url = new URL(window.location.href);
  url.searchParams.set('agent', agentId);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sessionStatusLabel(status: RemoteSessionStatus): string {
  switch (status) {
    case 'connecting': return 'Opening session';
    case 'catching_up': return 'Synchronizing';
    case 'disconnected': return 'Reconnecting';
    case 'ready': return 'Ready';
    case 'idle': return 'Ready';
  }
}

function openedSessionsKey(baseUrl: string): string { return `agent-remote-opened:${baseUrl}`; }
function readOpenedSessions(baseUrl: string): OpenedSession[] {
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(openedSessionsKey(baseUrl)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is OpenedSession => item !== null && typeof item === 'object' && ['agentId', 'providerId', 'nativeSessionId', 'title'].every((key) => typeof item[key] === 'string')).slice(0, 100).map(openedSessionMetadata);
  } catch { return []; }
}

function openedSessionMetadata(item: OpenedSession): OpenedSession {
  return { agentId: item.agentId, providerId: item.providerId, nativeSessionId: item.nativeSessionId, title: item.title,
    ...(typeof item.hostId === 'string' ? { hostId: item.hostId } : {}),
    ...(typeof item.parentAgentId === 'string' ? { parentAgentId: item.parentAgentId } : {}),
    ...(typeof item.parentNativeSessionId === 'string' ? { parentNativeSessionId: item.parentNativeSessionId } : {}),
    ...(typeof item.createdAt === 'string' ? { createdAt: item.createdAt } : {}) };
}

function hostProviders(host: RemoteHost | undefined): readonly AgentProviderDescriptor[] {
  if (!host) return [];
  return host.providers ?? [{ providerId: host.providerId ?? 'dsh', displayName: host.providerId && host.providerId !== 'dsh' ? host.providerId : 'DeepSeek Harness' }];
}

function viewKey(session: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>): string {
  const id = (session as { viewId?: string }).viewId;
  if (!id) throw new Error('Session View identity is missing.');
  return id;
}
