import { useLiveBudget, LiveConnectionsContext } from './hooks/useLiveBudget.js';
import { WindowSessionBridgeContext } from './window-session-bridge-context.js';
import { parseWindowFeature } from './window-feature-views.js';
import { windowTitleEdits } from './window-titles.js';
import { useWindowSessionBridge } from './hooks/useWindowSessionBridge.js';
import { createWindowView, hasBotAppearance, isBotView, nativeSessionRefKey, primaryWindowViews, windowPrimaryViewId, type WindowEdit, type WindowView } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from './window-workspace.js';
import { useWorkbenchMode } from './hooks/useWorkbenchMode.js';
import { useBotWorkspace } from './hooks/useBotWorkspace.js';
import { useOtherSessions, type OtherSessionSource } from './hooks/useOtherSessions.js';
import { botActivityLabel, botRole, projectBotRoster, type BotSessionRef } from './bot-roster.js';
import { sharedReminders } from './bot-attention.js';
import { useSessionReads } from './hooks/useSessionReads.js';
import { parseWorkbenchRoute, type BotPlace, type WorkbenchMode } from './workbench-mode.js';
import { windowBindingKey } from './window-composition.js';
import { BotWorkspace } from './components/BotWorkspace.js';
import type { BotInfo } from './components/BotActions.js';
import { NewBotSheet } from './components/NewBotSheet.js';
import { BotPicture, botDisplayName } from './components/BotRoster.js';
import { WorkbenchModeSwitch } from './components/WorkbenchModeSwitch.js';
import { SessionConversationSurfaces, SessionConversationMount, type SessionSurfaceDescriptor } from './components/SessionConversationSurfaces.js';
import { useWindowWorkspace } from './hooks/useWindowWorkspace.js';
import { useWindowSessionRetention } from './hooks/useWindowSessionRetention.js';
import { WindowLayoutContext, WindowPresentationContext } from './window-workspace-context.js';
import { WindowWorkspaces } from './components/WindowWorkspaces.js';
import { AgentControl } from './components/AgentControl.js';
import { useWindowActions, windowCatalog } from './hooks/useWindowActions.js';
import { WindowToolbar } from './shell/WindowToolbar.js';
import { Sheet } from './ui/Sheet.js';
import { Button } from './ui/Button.js';
import { WindowMenu } from './components/WindowMenu.js';
import { WindowOverview } from './components/WindowOverview.js';
import { byRecentUse, touchWindow } from './window-recency.js';
import { useSessionStates } from './hooks/useSessionStates.js';
import { sessionActivity } from './session-activity-status.js';
import { useWindowVisibility } from './hooks/useWindowVisibility.js';
import { teamViewTarget } from './team-view-binding.js';
import { SessionViewOperationsContext } from './session-view-operations.js';
import { SessionDescriptionsContext } from './session-description-context.js';
import { describeSession } from './session-description.js';
import { attributionWindowOperation } from './session-attribution-navigation.js';
import { sideWindowOperation } from './window-side-navigation.js';
import type { SessionAttribution, SessionStateRef } from '@orchardworks/agent-remote-web';
import { labSessionSuccessionDirectory, type SessionSuccessionDirectory } from './session-succession-directory.js';
import { TeamViewScope, useTeamVisibility } from './hooks/useTeamVisibility.js';
import { teamLayoutTargets } from './team-layout.js';
import { TeamMenu } from './components/TeamMenu.js';
import { TeamGatherButton } from './components/TeamGatherButton.js';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { useSessionWindows } from './hooks/useSessionWindows.js';
import { SessionWindow } from './components/SessionWindow.js';
import { SessionFamily, type FamilySessionPresentationContext } from './components/SessionFamily.js';
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
import { CallForSupportSettings } from './components/call-for-support/CallForSupportSettings.js';
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
import { EarlierConversation } from './components/EarlierConversation.js';
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
import { useSessionSuccession, type SourceStaleness } from './hooks/useSessionSuccession.js';
import { useSessionTracking } from './hooks/useSessionTracking.js';
import { FavoritesHeading, FavoritesList, FavoritesMenu, StarButton } from './components/SessionFavorites.js';
import { SessionTrackingMenu } from './components/SessionTrackingMenu.js';
import { TrackedSessionViews, unlinkSideView, type TrackedSessionView } from './tracked-session-views.js';
import { ToastActivity, ToastProvider, useFeedbackToast, useToast } from './components/Toast.js';
import { MissingSessionNote, SessionConnectionNotice, sessionConnectionFailure, type SessionConnectionMessage } from './components/SessionConnectionNotice.js';
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
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
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
  timelineEntryKey,
  type AgentReplicaState,
  type RemoteAgentTransport,
  type RemoteSessionStatus,
} from '@orchardworks/agent-remote-web';
import { ReadingPositions, RecoveryScope, readLastSession, saveLastSession } from './conversation-recovery.js';
import { compositionRoleKey, compositionSession, compositionSelection, type StoreOwner } from './session-composition.js';
import { useRemoteHosts } from './hooks/useRemoteHosts.js';
import { useVisualViewport } from './hooks/useVisualViewport.js';
import { arrangeFloatingEntries } from './hooks/useTrackingPosition.js';
import { HostPairing, type HostPairingService, type RemoteHost } from './components/HostPairing.js';
import { HostOverview } from './components/HostOverview.js';
import { DirectoryError, nativeSessionMissing, RemoteHostClient, SessionDirectoryClient, type CreateSessionOptions, type OpenedSession, type SessionSummary } from './directory-client.js';
import { SessionConfiguration, SessionDirectory } from './components/SessionDirectory.js';
import { useSessionEntries } from './hooks/useSessionEntries.js';
import { useNativeTitles } from './hooks/useNativeTitles.js';
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
import { refCommand, SessionReferences } from './components/SessionReferences.js';
import { loadSessionRefs, sessionRefsEntry, withSessionReferences, type LabSessionRef } from './session-references.js';
import { sideNavigationSource, sideNavigationTarget, sideLinkVisible, referenceForkContext, captureForkContext, forkDisplayState, ForkStore, type SessionFork } from './session-forks.js';
import { CollapsedConversations } from './components/CollapsedConversations.js';
import { MinimizeMainSession, SessionDockProvider, SessionDockRail, type FoldedBot } from './components/SessionDock.js';
import { RemoveBotSheet } from './components/RemoveBotSheet.js';
import { foldOperation } from './window-fold.js';
import { ConversationPane, ConversationSplit } from './components/ConversationSplit.js';
import { expandedSideRange, sidePath, type SideSelections } from './side-tree.js';
import { configureFork, forkActions, forkCommands, sendForkInput } from './fork-actions.js';
import { createSessionExcerpt, type SessionExcerpt } from '@orchardworks/agent-remote-protocol';
import { SessionExcerptNavigation, type TimelineEntrySelection } from '@orchardworks/agent-remote-web/react';
import { addQuote, restoreQuotes, withViewQuotes } from './session-quotes.js';
import { NEW_SESSION_TARGET, QuoteAttachments, QuoteMessagesButton, QuoteNotice, QuoteSelectionBar, type QuoteTargetWindow } from './components/SessionQuotes.js';
import type { QuestionDraft } from '@orchardworks/agent-remote-web/react';
import { ReplicaInspector } from './components/ReplicaInspector.js';
import { ProviderSessionControls, type ProviderCatalogStatus } from './components/ProviderSessionControls.js';
import { RecordedPlaybackControls } from './components/RecordedPlaybackControls.js';
import { focusableElements, SupportingRail } from './components/SupportingRail.js';
import { SidebarHeader } from './shell/SidebarHeader.js';
import { SidebarFooter } from './shell/SidebarFooter.js';
import { ShortcutPlacement } from './shell/shortcut-placement.js';
import { MovableHostSlot, useMovableHost } from './shell/movable-host.js';
import { Toolbar } from './ui/Toolbar.js';
import { IconButton } from './ui/IconButton.js';
import { Menu } from './ui/Menu.js';
import { SidebarResize, useSidebarWidth } from './components/SidebarResize.js';
import { TraceView } from './components/TraceView.js';
import { HostPreviewGroups } from './components/HostPreviewGroups.js';
import { HostVscodeTunnel } from './components/HostVscodeTunnel.js';
import { HttpVscodeTunnelClient, VscodeTunnelScope } from './vscode-tunnel.js';
import { useDeploymentUpdate } from './hooks/useDeploymentUpdate.js';
import { useShellShortcuts } from './hooks/useShellShortcuts.js';
import { CommandPalette } from './shell/CommandPalette.js';
import type { CommandItem } from './shell/command-search.js';
import { commandSessions, sessionSubtitle, sessionViewLocation, type CommandSession } from './shell/command-items.js';
import { revealView, viewSelection } from './window-view-selection.js';
import { applePlatform } from './platform.js';

/** A step that search runs once `mode` is in front; `confirmed` steps also wait for a confirmed Window. */
type ModeStep = { mode: WorkbenchMode; run(): void; confirmed: boolean };

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

/** Explains a disabled Ask launcher, after the session it names. */
const askStaleness: Record<SourceStaleness | '', string | undefined> = {
  '': undefined,
  inactive: 'waiting for this page to restore its sessions',
  view: 'this view now shows another session',
  connecting: 'waiting for the session to connect',
  agent: 'waiting for the session to reattach',
  native: 'waiting for the session to continue its current conversation',
};

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
  const navigation = useWorkbenchMode(baseUrl);
  const windowMode = navigation.mode === 'window';
  const windowModeRef = useRef(windowMode); windowModeRef.current = windowMode;
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  const accessReady = useContext(WorkspaceReady);
  const [activated, setActivated] = useState(accessReady);
  useEffect(() => { if (accessReady) setActivated(true); }, [accessReady]);
  const accessReadyRef = useRef(accessReady); accessReadyRef.current = accessReady;
  const shellRef = useVisualViewport(arrangeFloatingEntries);
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
      if (parseWorkbenchRoute(new URL(location.href))?.mode === 'bot') return {};
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
  const toast = useToast(windowMode);
  // One Window create at a time from the sidebar's New menu; the item is disabled until it settles.
  const creatingWindowRef = useRef(false);
  const [creatingWindow, setCreatingWindow] = useState(false);
  function navigateSide(key: string | undefined): void {
    setSideAnchor(key);
    setSideFocus(key);
  }
  const sideRequests = useRef(new Map<string, number>());
  const forkReservation = useRef<{ key: string; record: SessionFork }>();
  const forkBusy = useRef(false);
  const [forkInputStatus, setForkInputStatus] = useState<{ agentId: string; pending: boolean; error?: string }>();
  // Messages being selected in one session view to quote into another; creationId keeps a retried new session single.
  const [quoteSelection, setQuoteSelection] = useState<{ viewId: string; epoch: string | null; keys: ReadonlySet<string>; creationId?: string; busy?: boolean; error?: string }>();
  const [quoteNotice, setQuoteNotice] = useState<{ viewId: string; message: string; open?(): Promise<void> }>();
  const [referencePicker, setReferencePicker] = useState<string>();
  const [sessionOptions, setSessionOptions] = useState<CreateSessionOptions>({});
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const creationReservation = useRef<{ operationId: string; options: CreateSessionOptions; providerId: string; destination?: { windowId: string; viewId: string; binding: string }; bot?: true }>();
  const [creationLocked, setCreationLocked] = useState(false);
  /** Bot mode's New bot sheet, and the failure of its last start. */
  const [newBot, setNewBot] = useState<{ open: boolean; failure?: string }>({ open: false });
  /** A bot of the shown Window waiting for confirmation before it is removed from the group. */
  const [removingBot, setRemovingBot] = useState<{ windowId: string; viewId: string }>();
  const { value: catchUp, begin: beginCatchUp, focus: focusCatchUp } = useSessionCatchUp();
  useEffect(() => beginCatchUp(), [baseUrl, transport, beginCatchUp]);
  const replicas = useMemo(() => new ReplicaCache(), [baseUrl, transport]);
  /** Earlier-session elements by chain, so a bot's conversation keeps the same element across renders. */
  const earlierConversations = useRef(new Map<string, ReactElement>());
  const earlierDirectory = useRef<(hostId: string) => SessionDirectoryClient>(undefined!);
  earlierDirectory.current = hostId => hostId === selectedHost.id && directory ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
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
  const [sessionPanel, setSessionPanel] = useState<'list' | 'favorites' | 'new' | 'settings' | 'hosts'>('list');
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
  const [headerViewTarget, setHeaderViewTarget] = useState<HTMLDivElement | null>(null);
  const [sidebarViewTarget, setSidebarViewTarget] = useState<HTMLDivElement | null>(null);
  const [minimizedViewTarget, setMinimizedViewTarget] = useState<HTMLDivElement | null>(null);
  const [sessionViewTarget, setSessionViewTarget] = useState<HTMLDivElement | null>(null);
  const [windowToolbarViewTarget, setWindowToolbarViewTarget] = useState<HTMLDivElement | null>(null);
  const [mobileViewTarget, setMobileViewTarget] = useState<HTMLDivElement | null>(null);
  const [traceViewTarget, setTraceViewTarget] = useState<HTMLDivElement | null>(null);
  const [pageViewTarget, setPageViewTarget] = useState<HTMLDivElement | null>(null);
  /** The desktop page toolbar's trailing slot, where a page such as Hosts places its actions. */
  const [pageActionsTarget, setPageActionsTarget] = useState<HTMLDivElement | null>(null);
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
  const [initialSession] = useState(() => initialState || !windowMode || new URLSearchParams(window.location.search).has('window') ? undefined : requested.target);
  // Sessions the Host confirmed missing during this page's lifetime. Their views show as empty instead of reopening them;
  // the Window keeps the reference until the view holds another session or closes, so a later page load checks again.
  const [missingSessions, setMissingSessions] = useState<ReadonlySet<string>>(() => new Set());
  const markSessionMissing = useCallback((session: Pick<OpenedSession, 'hostId' | 'providerId' | 'nativeSessionId'>) => {
    const key = sessionKey(session);
    setMissingSessions(current => current.has(key) ? current : new Set([...current, key]));
  }, []);
  const liveConnections = useLiveBudget(baseUrl);
  const succession = useSessionSuccession({
    attachmentAllowed: slotId => liveConnections.live(slotId),
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
      if (!retrying && nativeSessionMissing(error)) markSessionMissing(selection);
      setSessionNotice({ ...sessionConnectionFailure(error, retrying), successionError: error instanceof Error ? error.message : 'The session could not be opened.' });
      if (error instanceof DirectoryError && error.nativeOwner) setNativeTakeover({ item: selection, owner: error.nativeOwner, message: error.message });
    },
  });
  const [nativeBootstrap] = useState(() => !initialSession?.nativeSessionId && !!initialSession?.agentId);
  const [bootstrapComplete, setBootstrapComplete] = useState(!nativeBootstrap);
  useEffect(() => { if (nativeBootstrap && succession.binding) setBootstrapComplete(true); }, [nativeBootstrap, succession.binding]);
  // A supplied snapshot is a standalone rendering input; it does not require a Window controller.
  const workspaceController = useWindowWorkspace(baseUrl, userScoped, accessReady, succession.document, !initialState && bootstrapComplete, { mode: navigation.mode, onSectionRoute: navigation.acceptSectionRoute });
  const sharedWindow = initialState ? undefined : workspaceController.window;
  // Window retention keeps a view's connection only while the live budget keeps the view's conversation live.
  const retainedView = useCallback((windowId: string, viewId: string) => {
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === windowId && entry.viewId === viewId)?.slotId;
    return !slotId || liveConnections.live(slotId);
  }, [liveConnections.version, succession.document]);
  const windowRetention = useWindowSessionRetention(connections, sharedWindow, undefined, retainedView);
  useEffect(() => {
    for (const id of workspaceController.deletedWindowIds) windowRetention.forgetWindow(id);
  }, [workspaceController.deletedWindowIds, windowRetention]);
  const windowWorkspace = { ...workspaceController,
    ...(initialState ? { window: undefined, authority: undefined, sessionBridge: undefined, unavailable: false, provisional: false } : {}),
  };
  // One set of Window actions for the sidebar's Windows list and the Window toolbar: one busy state, one notice, shown as a toast.
  const windowActions = useWindowActions(windowWorkspace, baseUrl);
  // A notice is cleared once a toast shows it; while toasts are inactive (Bot mode) it waits.
  useEffect(() => {
    if (!windowActions.notice || !toast) return;
    toast.show('window-action', 'Window', windowActions.notice, windowActions.noticeTone ?? 'error');
    windowActions.setNotice(undefined);
  }, [windowActions.notice, windowActions.noticeTone, toast]);
  const [docksHidden, setDocksHidden] = useState(() => { try { return localStorage.getItem(DOCKS_HIDDEN_KEY) === '1'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem(DOCKS_HIDDEN_KEY, docksHidden ? '1' : '0'); } catch { /* Keep the choice for this page without storage. */ } }, [docksHidden]);
  const [agentControlOpen, setAgentControlOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  // Docking a view in the open Window shows the docks again, and so does closing its last dock; switching Windows keeps the choice.
  const dockViews = useRef<{ windowId?: string; ids: Set<string> }>({ ids: new Set() });
  const dockIds = (sharedWindow?.views ?? []).filter(view => view.placement === 'dock').map(view => view.id);
  const dockKey = dockIds.join('\n');
  useEffect(() => {
    const previous = dockViews.current, ids = new Set(dockIds);
    dockViews.current = { windowId: sharedWindow?.id, ids };
    if (!sharedWindow || previous.windowId !== sharedWindow.id) return;
    if (dockIds.some(id => !previous.ids.has(id)) || previous.ids.size > 0 && ids.size === 0) setDocksHidden(false);
  }, [sharedWindow?.id, dockKey]);
  // A docked view that is chosen (sidebar row, search) would stay invisible behind hidden docks, so they show again.
  const showDockOf = useCallback((view: Pick<WindowView, 'placement'>) => { if (view.placement === 'dock') setDocksHidden(false); }, []);
  const selectedBot = useBotWorkspace(windowWorkspace, succession, navigation.place, activated && accessReady && !windowMode);
  const botPresentation = useMemo(() => ({ recovering: false, confirmed: undefined as { groupId: string; viewId: string; slotId: string; bindingKey: string } | undefined }), [baseUrl, transport]);
  if (!accessReady) botPresentation.recovering = true;
  if (selectedBot.group && selectedBot.view && selectedBot.slot) {
    botPresentation.recovering = false;
    botPresentation.confirmed = { groupId: selectedBot.group.window.id, viewId: selectedBot.view.id, slotId: selectedBot.slot.id, bindingKey: windowBindingKey(selectedBot.view.binding) };
  }
  const confirmedBot = botPresentation.confirmed;
  if (confirmedBot) {
    const place = navigation.place, group = windowWorkspace.readGroup(confirmedBot.groupId), view = group?.window.views.find(view => view.id === confirmedBot.viewId);
    if (place?.kind !== 'bot' || place.groupId !== confirmedBot.groupId || place.viewId !== confirmedBot.viewId
      || windowWorkspace.deletedWindowIds.includes(confirmedBot.groupId)
      || group && (!hasBotAppearance(group) || !view || !isBotView(view) || group.bots?.members[confirmedBot.viewId]?.hidden || windowBindingKey(view.binding) !== confirmedBot.bindingKey)) botPresentation.confirmed = undefined;
  }
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
  const windowSession = useWindowSessionBridge({ window: sharedWindow, unavailable: windowWorkspace.unavailable, readOnly: windowWorkspace.provisional, readWindow: windowWorkspace.readWindow, operate: windowWorkspace.operate, succession, enabled: accessReady && activated && !windowWorkspace.unavailable && !windowWorkspace.provisional,
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
  const [storedSessionNotice, setSessionNotice] = useState<SessionConnectionMessage>();
  const selectedPrimaryBinding = sharedWindow?.views.find(view => view.id === sharedWindow.selectedPrimaryViewId)?.binding;
  const selectedPrimaryMissing = !!selectedPrimaryBinding && missingSessions.has(sessionKey(selectedPrimaryBinding));
  // The selected view already shows its missing session as an empty view.
  const sessionNotice = selectedPrimaryMissing && storedSessionNotice?.code === 'native_session_unavailable' ? undefined : storedSessionNotice;
  const [failure, setFailure] = useState<string | undefined>(requested.error);
  useFeedbackToast('Session operation', windowMode ? failure : undefined);
  useFeedbackToast('Session connection', !windowMode || nativeTakeover ? undefined : sessionNotice?.message, sessionNotice?.tone === 'alert' ? 'error' : 'info');
  useFeedbackToast('Provider catalog', windowMode ? catalogError : undefined);
  useDeploymentUpdate(userScoped);
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
  // Desktop: the sidebar's All sessions, Favorites, New session and Settings entries open their panel as a page in place of the Window.
  const [sessionsPage, setSessionsPage] = useState(false);
  // The Team, TPM, Track and Ask entries render once and move between the sidebar's Shortcuts and their floating places,
  // so hiding or showing the sidebar never remounts them (Team would lose an open panel or a pending creation).
  const shortcutHost = useMovableHost(), askHost = useMovableHost();
  const shortcutSidebarSlot = useRef<HTMLDivElement>(null), shortcutFloatingSlot = useRef<HTMLDivElement>(null);
  const askSidebarSlot = useRef<HTMLDivElement>(null), askFloatingSlot = useRef<HTMLDivElement>(null);
  const pageOpen = windowMode && !compactLayout && sessionsPage;
  // Leaving the page hides it under the focus; focus then returns to the Window (see the layout effect below).
  const pageFocusReturn = useRef(false);
  const sessionsPageTitleRef = useRef<HTMLHeadingElement>(null);
  const closePage = useCallback(() => {
    if (document.activeElement?.closest('#lab-sessions-page')) pageFocusReturn.current = true;
    setSessionsPage(false);
  }, []);
  // Every path that returns to the Window (opening, creating or resuming a session) closes the compact drawer and the desktop page; the desktop sidebar stays.
  const closeContext = useCallback(() => { setContextOpen(false); closePage(); }, [closePage]);
  // Compact layouts have no page; the page does not reappear when the window widens again.
  useEffect(() => { if (compactLayout) setSessionsPage(false); }, [compactLayout]);
  const [botRosterCollapsed, setBotRosterCollapsed] = useState(false);
  const sidebarShown = useRef(desktopContextVisible);
  // ⌘\ toggles the desktop sidebar of the current mode; compact layouts have no sidebar to collapse.
  const toggleSidebar = compactLayout ? undefined : windowMode
    ? () => setDesktopContextVisible(value => !value)
    : () => setBotRosterCollapsed(value => !value);
  // ⌘K opens the command palette, which serves both modes.
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useShellShortcuts({ setMode: navigation.setMode, toggleSidebar, openSearch });
  // Steps that search runs once a mode has taken over (see inMode); they run after the Window workspace's own effects.
  const modeSteps = useRef<ModeStep[]>([]);
  const [queuedModeSteps, setQueuedModeSteps] = useState(0);
  // Palette items and deferred steps call the functions of the latest render, not of the render that built them.
  const searchRuns = useRef({ inMode, switchMode, openWindowFromSearch, openSessionFromSearch, createWindowFromMenu, addSessionView, focusShownMode });
  searchRuns.current = { inMode, switchMode, openWindowFromSearch, openSessionFromSearch, createWindowFromMenu, addSessionView, focusShownMode };
  // Focus inside a sidebar that hides would fall to the page; it goes to the View trigger, else into the main stage. The
  // check runs when the sidebar hides, not when it is toggled: the palette's Hide sidebar returns focus to the sidebar's
  // Search button only as it closes, in the same commit.
  useLayoutEffect(() => {
    const hidden = sidebarShown.current && !desktopContextVisible;
    sidebarShown.current = desktopContextVisible;
    if (!hidden || !(document.activeElement === document.body || focusWithinContext())) return;
    const trigger = viewTriggerRef.current;
    if (trigger?.isConnected && !trigger.closest('[hidden], [inert]')) trigger.focus({ preventScroll: true });
    if (document.activeElement !== trigger) focusableElements(document.querySelector<HTMLElement>('.lab-main-stage'))[0]?.focus({ preventScroll: true });
  }, [desktopContextVisible]);

  const { hosts: remoteHosts, loaded: hostsLoaded, error: hostError, retry: retryHosts } = useRemoteHosts(hostClient, accessReady && directory !== undefined, (compactLayout ? contextOpen : desktopContextVisible || pageOpen) || status !== 'ready' || creationLocked, selectedHost.id);
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
  const sideSessions = windowSession.empty ? [] : sharedWindow ? sharedFamilySides() : availableSides;
  const sideSelections = useMemo<SideSelections>(() => Object.fromEntries(succession.document.edges.filter(edge => edge.selected).map(edge => [edge.source, edge.target])), [succession.document, succession.document.editRevision]);
  const sideFocus = succession.document.focus, sideAnchor = succession.document.anchor;
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
  // Focus inside the page would fall to the document once the page hides; it returns to the Window instead.
  useLayoutEffect(() => {
    if (pageOpen || !pageFocusReturn.current) return;
    pageFocusReturn.current = false;
    if (document.activeElement === document.body || document.activeElement?.closest('#lab-sessions-page')) workbenchPanelRef.current?.focus({ preventScroll: true });
  }, [pageOpen]);

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
  const requestedHostUnavailable = hostsLoaded && requestedHostId && requestedHostId !== 'local' && !restoredHostSelection.current && !remoteHosts.some((host) => host.id === requestedHostId)
    ? 'Requested Host is unavailable or is not shared with you. Retry Hosts or select another Host.' : undefined;
  const creationUnavailableReason = requestedHostUnavailable ?? (selectedHost.id !== 'local' && !hostsLoaded && !hostError ? 'Loading Hosts…'
    : selectedHostOffline ? 'This Host is offline. Reconnect it or select another Host.'
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
      if (windowMode) rememberAgent(agentId);
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
    if (!windowMode || initialState || !activated || requested.target?.nativeSessionId || requested.error || sharedWindow || new URL(location.href).searchParams.has('window')) return;
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
    if (!windowMode || !compactLayout || contextOpen || inspectorOpen || !focusTimelineAfterAttachRef.current) return;
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
      // The session lands in the destination, or beside it when the destination is a bot (rule 6): the selected primary group shows it.
      const selectedDestination = () => {
        const current = windowWorkspace.readWindow(), viewId = current?.selectedPrimaryViewId, binding = current?.views.find(view => view.id === viewId)?.binding;
        return current?.id === destination.windowId && !!viewId && windowPrimaryViewId(current, current.selectedViewId) === viewId
          && binding && sessionKey(binding) === sessionKey(primary) && binding.parentNativeSessionId === primary.parentNativeSessionId && !binding.sessionIntent;
      };
      letterRequest.current?.abort(); trackedViews.select();
      setDetachedSideRoot(undefined); setNativeTakeover(undefined);
      setActiveView('workbench'); setFailure(undefined); setSessionNotice(undefined); closeContext();
      if (compactLayoutRef.current) setInspectorOpen(false);
      const opened = await bindDirectorySession(primary, destination, { primarySlot: view?.primarySlot ?? slot.id,
        read: view ? () => selectedDestination() && windowWorkspace.readWindow()?.selectedViewId === windowWorkspace.readWindow()?.selectedPrimaryViewId ? trackedViews.get(entryId) : undefined : undefined });
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
      const visible = familyPath.find(entry => sessionKey(entry) === sessionKey(selection));
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

  /**
   * Opens New bot where a new bot most likely belongs: the Host and provider of the selected bot, else the selected Host,
   * else the first online Host with a provider.
   */
  function openNewBot() {
    const usable = (host: RemoteHost) => host.online !== false && (host.id === 'local' ? providers.length > 0 : hostProviders(host).length > 0);
    const like = !windowMode ? selectedBot.view?.binding : undefined;
    const likeHost = like && selectableHosts.find(host => host.id === (like.hostId ?? 'local') && usable(host as RemoteHost));
    const current = selectableHosts.find(host => host.id === selectedHost.id);
    if (likeHost) selectHost(likeHost as RemoteHost, like.providerId);
    else if (!current || !usable(current as RemoteHost)) {
      const first = selectableHosts.find(host => usable(host as RemoteHost));
      if (first) selectHost(first as RemoteHost);
    }
    setNewBot({ open: true });
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
    if (next === 'trace') setSessionsPage(false);
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
  // The Window's views are on screen: not covered by the Trace view, the desktop sessions page or a compact drawer.
  const windowStageVisible = windowMode && activeView === 'workbench' && !pageOpen && !supportingRailOpen;
  // Compact layouts keep only the floating Windows list.
  const [windowOverviewOpen, setWindowOverviewOpen] = useState(false);
  // Whether All Windows can show, whatever the mode; the palette offers it from Bot mode too.
  const windowOverviewSupported = !compactLayout && !initialState && !windowWorkspace.unavailable && (windowWorkspace.windows.length > 0 || !!windowWorkspace.window);
  const windowOverviewAvailable = windowMode && windowOverviewSupported;
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
  const askSurfaceVisible = windowMode && askView.visible && activeView === 'workbench' && !supportingRailOpen;
  // Expanded Ask windows give way to the desktop sessions page, staying mounted underneath; the Ask entry itself stays in the sidebar.
  const askWindowsVisible = askSurfaceVisible && !pageOpen;
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
    if (!windowMode) return;
    if (event.target instanceof Element && event.target.closest('[data-pane-selection-ignore]')) return;
    if (!sharedWindow && event.target instanceof Element && event.target.closest('.lab-ask-window') && !event.target.closest('[data-view-id]')) sessionWindows.focus();
  }
  function chooseWindowSession(id: string) {
    sessionWindows.focus(id); showWindowSessionChooser();
  }
  function showWindowSessionChooser() {
    setActiveView('workbench'); setSessionPanel('list');
    if (compactLayout) setContextOpen(true); else setSessionsPage(true);
  }
  /** Desktop: shows a sidebar panel as a page in place of the Window. */
  function openPage(panel: typeof sessionPanel) {
    setSessionPanel(panel); setActiveView('workbench'); setSessionsPage(true);
    if (panel === 'favorites') void favorites.refresh();
  }
  const sessionsPageTitle = sessionPanel === 'list' ? 'All sessions' : sessionPanel === 'favorites' ? 'Favorites' : sessionPanel === 'new' ? 'New session' : sessionPanel === 'hosts' ? 'Hosts' : 'Settings';
  /** Shows a sidebar panel: a page on desktop, the drawer (instead of the inspector) on compact layouts. */
  function showPanel(panel: typeof sessionPanel) {
    if (!compactLayout) { openPage(panel); return; }
    setActiveView('workbench'); setSessionPanel(panel);
    setInspectorOpen(false); setContextOpen(true);
    if (panel === 'favorites') void favorites.refresh();
  }
  /** Shows the new-session form. */
  function openNewSessionPanel() { showPanel('new'); }
  function createWindowFromMenu() {
    if (creatingWindowRef.current) return;
    creatingWindowRef.current = true; setCreatingWindow(true);
    void windowWorkspace.create().then(() => toast?.dismiss('new-window'),
      (error: unknown) => toast?.show('new-window', 'Window not created', error instanceof Error ? error.message : String(error), 'error'))
      .finally(() => { creatingWindowRef.current = false; setCreatingWindow(false); });
  }
  function editWindow(operation: Parameters<typeof windowWorkspace.operate>[0]) {
    void windowWorkspace.operate(operation).catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
  }
  function selectPrimaryGroup(id: string) {
    if (!windowMode) return;
    const current = windowWorkspace.readWindow();
    if (current?.selectedPrimaryViewId === id && current.selectedViewId && windowPrimaryViewId(current, current.selectedViewId) === id) return;
    windowWorkspace.authority?.operate({ type: 'view.select', viewId: id });
  }
  function createSessionView() {
    try { sessionWindows.create(); showWindowSessionChooser(); }
    catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }
  /** Adds an empty session view and selects it, without opening the sessions page. */
  function addSessionView() {
    try { sessionWindows.create(); }
    catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }
  /** The desktop Window toolbar, above the session views of an available shared Window. */
  const windowToolbarShown = !!sharedWindow && !compactLayout && !windowWorkspace.unavailable;
  // The toolbar's sheets belong to its Window: switching Windows, or the toolbar going away (a compact layout, Bot mode, an unavailable Window), closes them.
  useEffect(() => { setAgentControlOpen(false); setDeleteConfirmOpen(false); }, [windowWorkspace.client, sharedWindow?.id, windowToolbarShown, windowMode]);
  /**
   * How a dock or float of the shown Window folds: a bot's × folds it where it stands, and folded or asleep it is a slim
   * card on desktop (compact layouts show one view at a time and do not fold).
   */
  function windowPaneFolding(viewId: string): { fold?: FoldedBot; onFold?(): void; onRestore?(): void; onRemove?(): void; onCloseView?(viewId: string): void } {
    if (!sharedWindow) return {};
    const view = sharedWindow.views.find(item => item.id === viewId);
    const folded = !compactLayout && !!view && isBotView(view) && !missingSessions.has(sessionKey(view.binding)) && (view.collapsed || asleepBot(view));
    return { onCloseView: closeView, ...(foldsOnClose(view) ? { onFold: () => closeView(viewId) } : {}),
      ...(folded ? { fold: foldedBot(view), onRestore: () => restoreView(viewId), onRemove: () => setRemovingBot({ windowId: sharedWindow.id, viewId }) } : {}) };
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
      if (!destination) {
        // Without a shared Window, a selected local session view on desktop binds in place, as it did before Windows.
        const local = !sharedWindow && !compactLayoutRef.current ? sessionWindows.activeId : undefined;
        if (!local) return openSession(item);
        sessionWindows.bind(local, { ...item, hostId: item.hostId ?? selectedHost.id });
        void succession.refresh();
        setActiveView('workbench'); closeContext(); return true;
      }
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
    if (JSON.stringify(view.binding ?? null) !== destination.binding) throw new Error('The target session view changed. Choose a session again.');
    // Rule 6: a pane of a group shown in Bot mode is a bot and keeps its conversation, so another session opens beside it:
    // a new view in its place, bound as an empty view is, so Track restore, drafts and succession work as usual. A session that
    // is already a bot here is selected instead. Navigation within the bot's own chain (its handoff history) stays in place.
    let target = view, expected = expectedBinding;
    const shownGroup = windowWorkspace.readGroup(current.id);
    if (shownGroup && hasBotAppearance(shownGroup) && isBotView(view) && session.sessionIntent !== 'history'
      && windowBindingKey(view.binding) !== windowBindingKey(windowSessionBinding(session))) {
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
  // Windows and their floating entry show the states of their sessions whenever there is a Window to show.
  const sharedStatesWanted = !windowMode && activated && accessReady || windowOverviewAvailable && windowOverviewOpen
    || windowMode && windowView.visible && !initialState && !windowWorkspace.unavailable && (windowWorkspace.windows.length > 0 || !!windowWorkspace.window);
  const sessionStates = useSessionStates(transport, sharedStatesWanted);
  // Read positions travel with the states: rows show what is unread, and a conversation on screen is read.
  const sessionReads = useSessionReads(transport, sharedStatesWanted);
  const updateTeamRoster = useCallback((baseUrl: string, teams: Team[]) => setTeamRoster({ baseUrl, teams }), []);
  const [tpmListOpen, setTpmListOpen] = useState(false);
  // Most recent use orders the Window overview; a page in front counts as using its Window.
  useEffect(() => {
    const id = sharedWindow?.id;
    if (!windowMode || !id) return;
    const use = () => { if (document.visibilityState === 'visible') touchWindow(baseUrl, id); };
    use();
    window.addEventListener('focus', use); document.addEventListener('visibilitychange', use);
    return () => { window.removeEventListener('focus', use); document.removeEventListener('visibilitychange', use); };
  }, [baseUrl, sharedWindow?.id, windowMode]);
  const tpmTriggerRef = useRef<HTMLButtonElement>(null);
  const candidateTpmService = hostClient as Partial<TpmService>;
  const tpmService = candidateTpmService.tpmList && candidateTpmService.tpmWork && candidateTpmService.tpmCreate && candidateTpmService.tpmAction ? candidateTpmService as TpmService : undefined;
  // The Hosts a session can run on: the Lab server itself when it has local providers, then the paired Hosts.
  const selectableHosts = useMemo(() => providers.length > 0 ? [{ id: 'local', name: 'Lab server', online: true }, ...remoteHosts] : remoteHosts, [providers.length, remoteHosts]);
  const attachTpm = useCallback(async (item: SessionEntry): Promise<OpenedSession> => {
    if (!accessReadyRef.current) throw new Error('Workspace access is restoring.');
    const target = new SessionDirectoryClient(baseUrl, undefined, item.hostId ?? 'local');
    const attached = await target.attach(item.providerId, item.nativeSessionId);
    return { hostId: item.hostId, providerId: item.providerId, nativeSessionId: attached.nativeSessionId ?? item.nativeSessionId, title: item.title, agentId: attached.agentId };
  }, [baseUrl]);
  // TPM runs on Controllers, so only paired Hosts are asked for TPM works; the Lab server has none.
  const tpm = useTpmWork(tpmService, remoteHosts, accessReady && !!directory, attachTpm, tpmView.visible, baseUrl, windowWorkspace.authority,
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
    if (!windowMode) return;
    document.title = pageTitle?.trim() ? `${pageTitle.trim()} · Agent Remote Control` : 'Agent Remote Control';
    return () => { document.title = 'Agent Remote Control'; };
  }, [pageTitle, windowMode]);
  const sideTitle = (session: OpenedSession) => ({ ...session, title: forkStore.find(session)?.firstInput?.trim().slice(0, 72) || session.title });
  const stackPath = sidePath(visibleStackRoot, sideSessions, sideSelections, viewKey).map(sideTitle);
  // A shared source can show several Sides, so its family is wider than the selected path.
  const familyPath = sharedWindow ? (visibleStackRoot ? [visibleStackRoot, ...sideSessions] : []).map(sideTitle) : stackPath;
  const selectedPathIndex = stackPath.findIndex(session => viewKey(session) === sideFocus);
  const sharedDesktopAnchor = sharedWindow && !compactLayout && selectedPathIndex >= 0
    ? stackPath[Math.min(stackPath.length - 1, selectedPathIndex + 1)] : undefined;
  const stackRange = expandedSideRange(stackPath, compactLayout ? sideFocus : sharedDesktopAnchor ? viewKey(sharedDesktopAnchor) : sideAnchor, compactLayout ? 1 : 2, viewKey);
  const expandedKeys = new Set(stackPath.slice(stackRange.start, stackRange.end + 1).filter(session => !sharedViewForSlot(viewKey(session))?.collapsed).map(viewKey));
  const focusedWindow = stackPath.find(session => viewKey(session) === sideFocus) ?? stackPath[stackRange.end];
  const focusedFamilyWindow = familyPath.find(session => viewKey(session) === sideFocus) ?? focusedWindow;
  const focusedFamilyIndex = focusedFamilyWindow ? Math.max(0, familyPath.findIndex(session => viewKey(session) === viewKey(focusedFamilyWindow))) : 0;
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
  const focusedAskState = focusedAskSession ? sourceStateFor(focusedAskSession) : undefined;
  const focusedAskUnavailable = !focusedAskSession ? undefined
    : !directory || !accessReady ? 'waiting for access'
    : transitioning ? 'waiting for the session switch to finish'
    : remoteHosts.find(host => host.id === focusedAskSession.hostId)?.online === false ? 'its Controller is offline'
    : focusedAskEntry?.record?.target ? undefined
    : askStaleness[sourceStale(focusedAskSession) ?? (focusedAskState?.agent ? '' : 'connecting')];
  const canOpenFocusedAsk = !!focusedAskSession && !focusedAskUnavailable;
  const refreshRelations = useSessionRelations(baseUrl, userScoped && accessReady, forkStore, ask.store, addressSession ? sessionKey(addressSession) : undefined, userScoped);
  const pendingSideSources = useRef(new Map<string, OpenedSession>());
  useLayoutEffect(() => {
    for (const record of forkStore.all()) {
      if (record.navigationSource) pendingSideSources.current.set(record.id,record.navigationSource);
      if (sideLinkVisible(record) || !record.target || appliedUnlinks.get(record.id) === (record.revision ?? 0)) continue;
      const navigationSource = pendingSideSources.current.get(record.id) ?? sideNavigationSource(record);
      pendingSideSources.current.delete(record.id);
      const navigationTarget = sideNavigationTarget(record)!;
      const sourceView = familyPath.find(session => sessionKey(session) === sessionKey(navigationSource)), targetView = sideSessions.find(session => sessionKey(session) === sessionKey(navigationTarget));
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
  /** A removed source also leaves its source's Sides, so the conversation stands on its own. */
  async function removedReference(ref: LabSessionRef, restore: () => Promise<void>, fork: SessionFork | undefined): Promise<void> {
    if (ref.origin === 'source' && fork && sideLinkVisible(fork)) await refreshRelations.setLinked(fork, false).catch(() => undefined);
    toast?.show(`reference:${ref.providerId}/${ref.nativeSessionId}`, 'Reference removed', 'The agent hears about it with your next message.', 'info', {
      label: 'Undo', onClick: async () => { await restore(); },
    });
  }
  async function restoredReference(fork: SessionFork | undefined): Promise<void> {
    const current = fork && forkStore.get(fork.id);
    if (current && !sideLinkVisible(current)) await refreshRelations.setLinked(current, true).catch(() => undefined);
  }
  function currentGroupBinding(slotId: string | undefined) {
    if (!slotId) return;
    const mappings = succession.document.windowBindings?.filter(entry => entry.slotId === slotId) ?? [];
    if (!mappings.length) return;
    const owner = mappings[0]!;
    if (mappings.some(entry => entry.windowId !== owner.windowId || entry.viewId !== owner.viewId)) throw new Error('The session view has conflicting group owners.');
    const group = windowWorkspace.readGroup(owner.windowId);
    if (!group) throw new Error(windowWorkspace.deletedWindowIds.includes(owner.windowId) ? 'This session view was deleted.' : 'The session group is unavailable.');
    const view = group.window.views.find(view => view.id === owner.viewId);
    const binding = view?.binding;
    const mapped = binding && succession.document.windowBindings?.find(entry => entry.windowId === owner.windowId && entry.viewId === owner.viewId && entry.bindingKey === windowBindingKey(binding));
    if (!binding || mapped?.slotId !== slotId || !succession.document.slots.some(slot => slot.id === slotId)) throw new Error('This session view was removed or rebound.');
    return { groupId: owner.windowId, viewId: owner.viewId, binding };
  }
  function sourceCurrent(source: OpenedSession): boolean {
    return !sourceStale(source);
  }
  /** A source's state as its view shows it: the view's connection may hold its own replica, not the cached one. */
  function sourceStateFor(source: OpenedSession): AgentReplicaState | undefined {
    if (source.agentId === state?.agent?.id) return state;
    const connection = connections.find(source);
    return (connection?.agentId === source.agentId ? connection.replica : replicas.get(source.agentId))?.getState();
  }
  function sourceStale(source: OpenedSession): SourceStaleness | undefined {
    try {
      const mapped = currentGroupBinding((source as { viewId?: string }).viewId);
      const captured = (source as { bot?: { groupId: string; viewId: string } }).bot;
      if (captured && (!mapped || mapped.groupId !== captured.groupId || mapped.viewId !== captured.viewId)) return 'view';
      if (mapped && sessionKey(mapped.binding) !== sessionKey(source)) return 'view';
    } catch { return 'view'; }
    if (initialState && !succession.active) {
      const id = (source as { viewId?: string }).viewId;
      const agent = initialState.agent, slot = succession.document.slots.find(slot => slot.id === id);
      if (!slot || sessionKey(compositionSelection(slot)) !== sessionKey(source)) return 'view';
      if (!agent) return 'connecting';
      if (agent.id !== source.agentId) return 'agent';
      return agent.providerId === source.providerId && agent.runtimeInfo.sessionId === source.nativeSessionId ? undefined : 'native';
    }
    return succession.sourceStale(source);
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
    if (!windowMode || succession.active && !succession.binding) return;
    focusCatchUp(addressSession ? replicas.get(addressSession.agentId) : undefined);
  }, [addressSession?.agentId, succession.active, succession.binding, replicas, focusCatchUp, windowMode]);
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
      visible: resolveAskPresentation({ window: sharedWindow, view: ask.sharedView(owner), visible: askWindowsVisible, expanded, compact: compactLayout }).shown,
      liveAgentId: entry.attached ? entry.record.target.agentId : undefined }];
  }), [askSources, ask.revision, askWindowsVisible, sharedWindow, compactLayout]);
  useEffect(() => {
    replicas.retain([
      ...connections.agentIds,
      ...(primaryBinding.current?.agentId ? [primaryBinding.current.agentId] : []),
      ...sideSessions.map(session => session.agentId),
      ...askActivitySessions.filter(item => item.visible).map(item => item.session.agentId),
      ...(addressSession ? [addressSession.agentId] : []),
    ]);
  });
  // A session under the desktop sessions page is not seen, so it is not acknowledged as read.
  const visibleWindows = openWindows.filter(session => windowStageVisible && isViewVisible(viewKey(session)));
  /**
   * The session that drives a bot now: after a handoff, the successor its view's slot follows (the view keeps naming the
   * session it was opened with); otherwise the view's own session. Status, replies and reminders follow this one.
   */
  function currentBotSession(groupId: string, viewId: string, binding: WindowSessionBinding): BotSessionRef {
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === groupId && entry.viewId === viewId && entry.bindingKey === windowBindingKey(binding))?.slotId;
    const slot = slotId ? succession.document.slots.find(item => item.id === slotId) : undefined;
    const selected = slot ? compositionSelection(slot) : undefined;
    return selected ? { hostId: selected.hostId ?? binding.hostId, providerId: selected.providerId, nativeSessionId: selected.nativeSessionId }
      : { hostId: binding.hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId };
  }
  /** A bot's sessions before its handoffs, most recent first, where this page knows its chain. */
  function earlierBotSessions(groupId: string, viewId: string, binding: WindowSessionBinding): BotSessionRef[] {
    const hostId = binding.hostId ?? 'local';
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === groupId && entry.viewId === viewId && entry.bindingKey === windowBindingKey(binding))?.slotId;
    const current = currentBotSession(groupId, viewId, binding);
    const chain = slotId ? succession.historyNavigationFor({ ...current, title: binding.title, viewId: slotId }) : undefined;
    const earlier = chain?.predecessor && !chain.history ? [chain.predecessor, ...chain.ancestors] : [];
    return earlier.map(session => ({ hostId: session.hostId ?? hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId }));
  }
  const botTargets = !windowMode && activated && accessReady
    ? projectBotRoster(windowWorkspace.groups, [], { status: () => 'unknown', current: currentBotSession }).sections.flatMap(section => section.rows.map(({ binding, session }) => {
      const { role: _role, ...entry } = binding;
      return { ...entry, ...session };
    })) : [];
  const botBinding = selectedBot.view?.binding;
  const botConnection = botBinding && connections.find(botBinding);
  const selectedBotSession = botBinding && selectedBot.group && selectedBot.view ? currentBotSession(selectedBot.group.window.id, selectedBot.view.id, botBinding) : undefined;
  const displayedBot = selectedBotSession && botTargets.find(session => sessionKey(session) === sessionKey(selectedBotSession));
  const visibleBots = !windowMode && accessReady && selectedBot.slot && botBinding && displayedBot && botConnection
    && (!compactLayout || !navigation.rosterVisible) && connections.shown(botBinding, botConnection.agentId) ? [displayedBot] : [];
  const latestEligible = useRef(new Set<string>());
  const attention = useSessionAttention(baseUrl, userScoped && accessReady, item => {
    if (!windowMode) {
      if (!latestEligible.current.has(sessionKey(item))) return;
      const row = projectBotRoster(windowWorkspace.groups, [], { status: () => 'unknown', current: currentBotSession }).sections
        .flatMap(section => section.rows).find(row => sessionKey(row.session) === sessionKey(item));
      if (row) navigation.select({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
      return;
    }
    setActiveView('workbench'); closeContext(); setInspectorOpen(false);
    const target = openWindows.find(session => sessionKey(session) === sessionKey(item));
    if (target) { revealSession(target); return; }
    const source = openWindows.find(session => {
      const entry = ask.entryFor(session, succession.ownerFor(viewKey(session)));
      return entry.record?.target && sessionKey(entry.record.target) === sessionKey(item);
    });
    if (source) { revealSession(source); openAsk(source, sourceStateFor(source)); }
    else void openSession(item, undefined, undefined, false, undefined, 'history');
  }, navigation.mode);
  // Bot mode reminds from the shared channel (below), so only Window mode's observations notify.
  const observeAttention = useCallback((session: SessionEntry, value: import('./tracking-state.js').SessionObservation) => {
    if (windowModeRef.current && latestEligible.current.has(sessionKey(session))) attention.observe(session, value);
  }, [attention.observe]);
  // Bot mode follows its bots through the states the Relay shares, not a stream each (decision 11).
  const tracking = useSessionTracking(baseUrl, transport, windowMode && addressSession ? sessionKey(addressSession) : undefined,
    windowMode ? openWindows : [], windowMode ? askActivitySessions : [], connections, accessReady && succession.observerReady,
    windowMode ? visibleWindows : visibleBots, observeAttention, !windowMode ? { includeTracked: false, additionalSessions: [] } : undefined);
  const eligible = attention.enabled ? windowMode ? [...tracking.sessions, ...openWindows, ...askActivitySessions.map(entry => entry.session)] : botTargets : [];
  latestEligible.current = new Set(eligible.map(sessionKey));
  const displayed = attention.enabled ? windowMode ? [...openWindows, ...askActivitySessions.map(entry => entry.session)] : botTargets : [];
  const eligibleKeys = JSON.stringify([...latestEligible.current].sort());
  const displayedKeys = JSON.stringify([...new Set(displayed.map(sessionKey))].sort());
  useLayoutEffect(() => {
    attention.notifier.setEligible(eligible);
    attention.notifier.setDisplayed(displayed);
  }, [attention.notifier, eligibleKeys, displayedKeys, attention.enabled, navigation.mode]);
  const windowSessionStatus = useCallback((session: SessionStateRef) => sessionActivity(session, tracking.liveObservations, sessionStates), [tracking.liveObservations, sessionStates]);
  // Bot mode's reminders: a bot that starts waiting or finishes, unless its conversation is on screen.
  const sharedAttention = useRef(new Map<string, 'running' | 'waiting' | 'idle' | 'failed'>());
  const botTargetKeys = JSON.stringify(botTargets.map(sessionKey).sort());
  const onScreenBots = visibleBots.map(sessionKey).join('\n');
  useEffect(() => {
    if (windowMode || !attention.enabled) { sharedAttention.current = new Map(); return; }
    const { next, reminders } = sharedReminders(sharedAttention.current, botTargets, sessionStates);
    sharedAttention.current = next;
    const onScreen = new Set(document.visibilityState === 'hidden' ? [] : onScreenBots.split('\n'));
    for (const { session, reminder, identity } of reminders) if (!onScreen.has(sessionKey(session))) void attention.notifier.remind(session, reminder, identity);
  }, [sessionStates, windowMode, attention.enabled, attention.notifier, botTargetKeys, onScreenBots]);
  const botDirectorySources = useMemo<OtherSessionSource[]>(() => {
    const sources: OtherSessionSource[] = [];
    if (providers.length && directory && selectedHost.id === 'local') for (const provider of providers) sources.push({ id: `local/${provider.providerId}`, hostId: 'local', providerId: provider.providerId, directory, online: true });
    for (const host of remoteHosts) {
      const client = host.id === selectedHost.id && directory ? directory : new SessionDirectoryClient(baseUrl, undefined, host.id);
      for (const provider of host.providers ?? []) sources.push({ id: `${host.id}/${provider.providerId}`, hostId: host.id, providerId: provider.providerId, directory: client, online: host.online });
    }
    return [...new Map(sources.map(source => [source.id, source])).values()];
  }, [baseUrl, providers, remoteHosts, directory, selectedHost.id]);
  const otherSessions = useOtherSessions(botDirectorySources, !windowMode && activated && accessReady);
  const supportTeams = new Set(teamRoster?.baseUrl === baseUrl ? teamRoster.teams.filter(team => team.callForSupport).map(team => team.id) : []);
  const botRoster = projectBotRoster(windowWorkspace.groups, otherSessions.sessions, { status: windowSessionStatus, supportTeam: teamId => supportTeams.has(teamId),
    current: currentBotSession, earlier: earlierBotSessions, reply: session => sessionStates?.reply(session), unread: (session, replyAt) => !!sessionReads?.unread(session, replyAt) });
  // A conversation on screen, with the page visible, is read up to its latest reply on every device. In Bot mode it
  // continues into the session before a handoff, whose last reply may still be the latest.
  const readableSessions: Array<Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>> = windowMode ? visibleWindows
    : visibleBots.length && botBinding && selectedBot.group && selectedBot.view
      ? [...visibleBots, botBinding, ...earlierBotSessions(selectedBot.group.window.id, selectedBot.view.id, botBinding)] : [];
  const readableKeys = readableSessions.map(sessionKey).join('\n');
  useEffect(() => {
    if (!pageVisible || !sessionReads || !transport.markSessionRead) return;
    for (const session of readableSessions) {
      const ref = { hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId };
      const reply = sessionStates?.reply(ref);
      if (reply && sessionReads.unread(ref, reply.replyAt)) transport.markSessionRead(ref, reply.replyAt);
    }
  }, [pageVisible, readableKeys, sessionStates, sessionReads, transport]);
  const botPlace = navigation.place?.kind === 'bot' ? navigation.place : undefined;
  /** The selected bot's activity: a finished turn may have named its session. */
  const selectedBotStatus = botPlace ? botRoster.sections.find(section => section.groupId === botPlace.groupId)?.rows.find(row => row.viewId === botPlace.viewId)?.status : undefined;
  /** Selects a view of the open Window as its sidebar row does: expanded, selected and scrolled into view, in place of a page. */
  function selectWindowView(view: WindowView) {
    showDockOf(view);
    const failed = (error: unknown) => windowActions.setNotice(message(error, 'The session view was not selected.'));
    try { void windowWorkspace.operate(viewSelection(view)).catch(failed); } catch (error) { failed(error); return; }
    revealView(view.id); closePage();
  }
  /**
   * Queues a step for when `mode` is in front; a step for another mode than the one shown is dropped. Entering Window
   * mode restores the page's Window, which would supersede a Window opened or created in the same turn, so steps never
   * run in the turn that switches. A step that edits the open Window (`confirmed`) also waits until the Window is
   * confirmed, since a cached Window shown while it loads is read-only.
   */
  function inMode(mode: WorkbenchMode, run: () => void, confirmed = false) {
    modeSteps.current.push({ mode, run, confirmed }); setQueuedModeSteps(value => value + 1);
  }
  /** Shows a mode; when the mode changes, focus moves into it once it shows (the palette's opener is in the hidden mode). */
  function switchMode(mode: WorkbenchMode) {
    if (navigation.mode === mode) return;
    navigation.setMode(mode); inMode(mode, () => searchRuns.current.focusShownMode(mode));
  }
  /** Focuses the shown mode's Search button, else its main heading, unless focus is already inside it. */
  function focusShownMode(mode: WorkbenchMode) {
    const root = document.querySelector<HTMLElement>(`[data-workbench-mode="${mode}"]`);
    if (!root || root.hidden || root.contains(document.activeElement)) return;
    const shown = (element: HTMLElement) => !element.closest('[hidden], [inert]');
    const target = [...root.querySelectorAll<HTMLElement>('button[aria-label="Search"]')].find(shown)
      ?? [...root.querySelectorAll<HTMLElement>('.ui-toolbar-title[tabindex="-1"], #lab-workbench')].find(shown);
    target?.focus({ preventScroll: true });
  }
  const windowConfirmed = !!initialState || windowWorkspace.unavailable || windowWorkspace.hasActiveWindow && !windowWorkspace.provisional;
  useEffect(() => {
    if (!modeSteps.current.length) return;
    modeSteps.current = modeSteps.current.filter(step => {
      if (step.mode !== navigation.mode) return false;
      if (step.confirmed && step.mode === 'window' && !windowConfirmed) return true;
      step.run(); return false;
    });
  }, [navigation.mode, queuedModeSteps, windowConfirmed]);
  async function openWindowFromSearch(id: string) {
    try { await windowWorkspace.open(id); closePage(); }
    catch (error) { windowActions.setNotice(message(error, 'The Window was not opened.')); }
  }
  /**
   * Opens a session from search: in the view that shows it (in the open Window first, else opening the Window that
   * has it), or else in the presented view, as All sessions does.
   */
  async function openSessionFromSearch(session: CommandSession) {
    const key = sessionKey(session), current = windowWorkspace.readWindow();
    const location = sessionViewLocation(windowCatalog(windowWorkspace), current?.id, key);
    if (!location) { void openDirectorySession(session); return; }
    if (location.windowId !== current?.id) {
      try { await windowWorkspace.open(location.windowId); }
      catch (error) { windowActions.setNotice(message(error, 'The Window was not opened.')); return; }
    }
    // Only select once that Window is open: a newer navigation may have replaced it while it loaded.
    const open = windowWorkspace.readWindow();
    const view = open?.id === location.windowId ? open.views.find(candidate => candidate.binding && sessionKey(candidate.binding) === key) : undefined;
    if (view) selectWindowView(view);
  }
  // The palette's Windows and sessions are built only while it is open, and again only when their sources change.
  const searchCatalog = useMemo(() => searchOpen ? windowCatalog(windowWorkspace) : [],
    [searchOpen, windowWorkspace.windows, windowWorkspace.window, windowWorkspace.readGroup]);
  const windowItems = useMemo(() => byRecentUse(baseUrl, searchCatalog).map((window): CommandItem => ({ id: `window:${window.id}`, kind: 'window', title: window.title,
    subtitle: `${window.views.length} ${window.views.length === 1 ? 'session view' : 'session views'}`,
    run: () => { const runs = searchRuns.current; runs.switchMode('window'); runs.inMode('window', () => void searchRuns.current.openWindowFromSearch(window.id)); } })),
  [baseUrl, searchCatalog]);
  const sessionItems = useMemo(() => !searchOpen ? [] : commandSessions(sessionEntries, favorites.stars, searchCatalog.flatMap(window => window.views.flatMap(view => view.binding ? [view.binding] : [])))
    .map((session): CommandItem => { const subtitle = sessionSubtitle(session, remoteHosts, providers);
      return { id: `session:${sessionKey(session)}`, kind: 'session', title: session.title, ...(subtitle ? { subtitle } : {}),
        run: () => { const runs = searchRuns.current; runs.switchMode('window'); runs.inMode('window', () => void searchRuns.current.openSessionFromSearch(session), true); } }; }),
  [searchOpen, sessionEntries, favorites.stars, searchCatalog, remoteHosts, providers]);
  /** The palette's items, built from what the page already knows, and only while it is open. */
  function commandItems(): CommandItem[] {
    const apple = applePlatform(), toWindow = () => switchMode('window');
    /** Runs a step in Window mode, switching to it first; see inMode. */
    const inWindow = (step: () => void, confirmed = false) => () => { toWindow(); inMode('window', step, confirmed); };
    const sidebarShown = windowMode ? desktopContextVisible : !botRosterCollapsed;
    const action = (id: string, title: string, run: () => void, keys?: { shown: string; aria: string }): CommandItem =>
      ({ id: `action:${id}`, kind: 'action', title, run, ...(keys ? { shortcut: keys.shown, keyShortcuts: keys.aria } : {}) });
    const actions: CommandItem[] = [
      ...(!windowMode && directory ? [action('new-bot', 'New bot', openNewBot)] : []),
      action('new-session', 'New session', () => { toWindow(); openNewSessionPanel(); }),
      action('new-window', 'New Window', inWindow(() => searchRuns.current.createWindowFromMenu())),
      ...(sharedWindow && !windowWorkspace.unavailable ? [action('new-session-view', 'New session view', inWindow(() => { closePage(); searchRuns.current.addSessionView(); }, true))] : []),
      action('all-sessions', 'All sessions', () => { toWindow(); showPanel('list'); }),
      ...(userScoped ? [action('favorites', 'Favorites', () => { toWindow(); showPanel('favorites'); })] : []),
      action('settings', 'Settings', () => { toWindow(); showPanel('settings'); }),
      ...(toggleSidebar ? [action('toggle-sidebar', sidebarShown ? 'Hide sidebar' : 'Show sidebar', toggleSidebar,
        apple ? { shown: '⌘\\', aria: 'Meta+\\' } : { shown: 'Ctrl+\\', aria: 'Control+\\' })] : []),
      windowMode ? action('bot-mode', 'Switch to Bot mode', () => switchMode('bot'), apple ? { shown: '⌥⌘2', aria: 'Alt+Meta+2' } : { shown: 'Ctrl+Alt+2', aria: 'Control+Alt+2' })
        : action('window-mode', 'Switch to Window mode', toWindow, apple ? { shown: '⌥⌘1', aria: 'Alt+Meta+1' } : { shown: 'Ctrl+Alt+1', aria: 'Control+Alt+1' }),
      ...(windowOverviewSupported ? [action('all-windows', 'All Windows', () => { toWindow(); setWindowOverviewOpen(true); })] : []),
    ];
    // Each session is one item: a bot in Bot mode, a session (opened in Window mode) otherwise.
    const bots = windowMode ? [] : botRoster.sections.flatMap(section => section.rows.map((row): CommandItem => ({ id: `bot:${row.groupId}/${row.viewId}`, kind: 'bot',
      title: botDisplayName(row.binding), subtitle: section.title, ...(row.details.label ? { keywords: [row.details.label] } : {}),
      run: () => {
        const switching = windowMode;
        navigation.select({ kind: 'bot', groupId: row.groupId, viewId: row.viewId });
        if (switching) inMode('bot', () => searchRuns.current.focusShownMode('bot'));
      } })));
    const botSessions = new Set(windowMode ? [] : botRoster.sections.flatMap(section => section.rows.map(row => `session:${sessionKey(row.binding)}`)));
    return [...actions, ...windowItems, ...bots, ...sessionItems.filter(item => !botSessions.has(item.id))];
  }
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
  // In Bot mode the selected bot's group is named like the open Window: its sessions, and the group itself while it is named after its first session.
  const titledBotGroup = !windowMode ? selectedBot.group : undefined;
  // Window views name sessions that need not be open on this page; Ask, Team and TPM views name their own.
  const titledSessions = useMemo(() => [...sessionEntries, ...[...sharedWindow?.views ?? [], ...titledBotGroup?.window.views ?? []].flatMap(({ binding, bindingPolicy }) => binding && bindingPolicy !== 'managed'
    ? [{ hostId: binding.hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId, title: binding.title }] : [])],
    [sessionEntries, sharedWindow?.views, titledBotGroup?.window.views]);
  useNativeTitles({ entries: titledSessions, confirmed: confirmedTitles, apply: applySessionTitle,
    // A session's native title can appear once a turn ends, so a change in the sessions' activity asks again.
    trigger: `${state?.agent?.status ?? ''}|${Object.values(sideActivity).join(',')}|${selectedBotStatus ?? ''}`,
    describe: (hostId, providerId, nativeSessionId, signal) => new SessionDirectoryClient(baseUrl, undefined, hostId).nativeTitle(providerId, nativeSessionId, signal) });
  const titleProjection = useRef<ReadonlyMap<string, string>>();
  useEffect(() => {
    // A cached Window is renamed only once the service confirms it.
    if (!sharedWindow || windowWorkspace.provisional || !confirmedTitles?.size || titleProjection.current === confirmedTitles) return;
    titleProjection.current = confirmedTitles;
    try {
      for (const edit of windowTitleEdits(sharedWindow, confirmedTitles)) {
        // A view given another session meanwhile keeps it; that is not a failure to report.
        if (edit.type === 'view.bind') void windowWorkspace.operate(edit).catch(() => {});
        else editWindow(edit);
      }
    } catch (error) { setSessionNotice(sessionConnectionFailure(error, false)); }
  }, [sharedWindow?.id, sharedWindow?.revision, windowWorkspace.provisional, confirmedTitles]);
  const botTitleProjection = useRef<{ titles?: ReadonlyMap<string, string>; revision?: string }>({});
  useEffect(() => {
    if (!titledBotGroup || !confirmedTitles?.size) return;
    const revision = JSON.stringify([titledBotGroup.window.id, titledBotGroup.window.revision]);
    if (botTitleProjection.current.titles === confirmedTitles && botTitleProjection.current.revision === revision) return;
    botTitleProjection.current = { titles: confirmedTitles, revision };
    const edits = windowTitleEdits(titledBotGroup.window, confirmedTitles);
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

  const navigateAttributionRef = useRef(navigateAttribution); navigateAttributionRef.current = navigateAttribution;
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
    if (windowMode && !sharedWindow && !compositionProtected && primaryExpanded && stackRoot && sideFocus === viewKey(stackRoot) && activeView === 'workbench') {
      const primary = workbenchPanelRef.current?.querySelector('.lab-primary-conversation');
      if (primary?.contains(document.activeElement)) return;
      primary?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    }
  }, [compositionProtected, sideFocus, primaryExpanded, stackRoot?.agentId, activeView]);
  function focusPrimaryContent(target: EventTarget): void {
    if (!windowMode) return;
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
    // Attached views follow their source in Window order, including several per source.
    const family = [root], ids = new Set([root.id]);
    for (const view of sharedWindow.views) if (view.attachedTo && ids.has(view.attachedTo)) { ids.add(view.id); family.push(view); }
    return family;
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
  const successionInputReason = successionDialog && (succession.document.windowBindings?.some(entry => entry.slotId === viewKey(successionDialog.source)) ? (pendingGroupInputs[viewKey(successionDialog.source)] ?? 0) > 0
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
    progressPortal={!!(successionDialog.source as OpenedSession & { bot?: unknown; fallback?: boolean }).bot || !!(successionDialog.source as OpenedSession & { fallback?: boolean }).fallback}
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
    onSettled={async result => {
      const source = successionDialog.source, slotId = viewKey(source);
      const assertCompletionView = (requireVerified = false) => {
        assertSuccessionAccess();
        const mapped = currentGroupBinding(slotId);
        if (!mapped || sessionKey(mapped.binding) === sessionKey(source)) return;
        const slot = succession.document.slots.find(slot => slot.id === slotId);
        const verified = succession.successionContextFor(slotId), receipt = result.record, pending = successionDialog.resume;
        const roleKey = slot?.intent.kind === 'role' ? slot.intent.roleKey : undefined;
        const checkpoint = succession.document.roles.find(role => compositionRoleKey(role) === roleKey);
        if (receipt.phase !== 'committed' || !receipt.to || !checkpoint || !pending
          || pending.operationId !== receipt.operationId || pending.expectedRevision !== receipt.expectedRevision
          || checkpoint.desired.operationId !== receipt.operationId || checkpoint.roleId !== receipt.roleId || result.role.id !== receipt.roleId
          || checkpoint.desired.expectedRevision !== receipt.expectedRevision || checkpoint.desired.committedRevision !== receipt.committedRevision
          || result.role.revision !== receipt.committedRevision
          || nativeSessionRefKey(checkpoint.desired.from) !== nativeSessionRefKey(receipt.from)
          || sessionKey({ hostId: source.hostId, ...receipt.from }) !== sessionKey(source)
          || nativeSessionRefKey(checkpoint.desired.to) !== nativeSessionRefKey(receipt.to)
          || nativeSessionRefKey(result.role.current) !== nativeSessionRefKey(receipt.to)
          || sessionKey({ hostId: source.hostId, ...receipt.to }) !== sessionKey(mapped.binding)
          || requireVerified && (!verified || verified.operationId !== receipt.operationId || checkpoint.appliedRevision !== receipt.committedRevision
            || nativeSessionRefKey(verified.target) !== nativeSessionRefKey(receipt.to))) {
          throw new Error('The Handoff source view changed before completion.');
        }
      };
      assertCompletionView();
      await succession.refreshSettled(result, source);
      assertCompletionView(true);
    }}
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
      visible={askSurfaceVisible} covered={pageOpen} triggerRef={askTriggerRef} onToggleEnabled={() => askView.setVisible(!askView.visible)}
      canRestore={accessReady && (!!target && !compositionProtected || available && (!compositionProtected || independentRestore))} synchronizing={compositionProtected} synchronize={refreshRelations}
      onOpen={clean => openAsk(source, sourceState, clean)} replicaFor={replicaFor} transport={transport}
      navigation={viewNavigation} />;
  }
  /** Session views of every Window that can receive a quote from `sourceViewId`, located by Window and session. */
  function quoteTargets(sourceViewId: string, source: OpenedSession): QuoteTargetWindow[] {
    const current = windowWorkspace.readWindow() ?? sharedWindow;
    const catalog = [...new Map([...(windowWorkspace.windows ?? []), ...(current ? [current] : [])].map(window => [window.id, window])).values()];
    const placement = { primary: 'Main', dock: 'Docked', float: 'Floating', attached: 'Side' } as const;
    return catalog.map(window => ({ id: window.id, title: window.title || 'Untitled Window', current: window.id === current?.id,
      views: window.views.filter(view => {
        const feature = parseWindowFeature(view.feature);
        return view.id !== sourceViewId && !!view.binding && view.binding.sessionIntent !== 'history' && !view.binding.parentNativeSessionId
          && (!feature || feature.kind === 'team') && sessionKey(view.binding) !== sessionKey(source);
      }).map(view => ({ viewId: view.id, title: view.binding!.title || 'Untitled session', detail: placement[view.placement] })) }))
      .filter(window => window.current || window.views.length).sort((a, b) => Number(b.current) - Number(a.current));
  }
  /** A new session in the source's workspace, with its provider and model, opened as a dock of the current Window. */
  async function createQuoteSession(source: OpenedSession, sourceState: AgentReplicaState, operationId: string): Promise<string> {
    const agent = sourceState.agent;
    if (!directory || !agent) throw new Error('A new session cannot be created here.');
    const target = (source.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
    const quota = remoteHosts.find(host => host.id === source.hostId)?.sessionQuota;
    if (quota && quota.used >= quota.limit) throw new Error('Session creation limit reached. Existing sessions remain available. Ask the owner to raise your limit.');
    const options: CreateSessionOptions = { ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model && source.providerId !== 'dsh' ? { model: agent.model } : {}) };
    let created: { agentId: string; nativeSessionId?: string };
    try { created = await target.create(source.providerId, operationId, options); }
    finally { if (source.hostId && source.hostId !== 'local') retryHosts(); }
    const session = { agentId: created.agentId, nativeSessionId: created.nativeSessionId ?? created.agentId, providerId: source.providerId, hostId: source.hostId ?? 'local', title: 'New session' };
    rememberSession(session); setDirectoryRevision(value => value + 1);
    const view = createWindowView(crypto.randomUUID(), windowSessionBinding(session), 'dock');
    editWindow({ type: 'batch', operations: [{ type: 'view.create', view }] });
    return view.id;
  }
  function revealQuoteTarget(viewId: string): void {
    void windowWorkspace.operate({ type: 'view.select', viewId }).catch(() => {});
    const id = viewId.replace(/["\\]/g, '\\$&');
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-view-id="${id}"] [data-testid="prompt-input"], [data-primary-group-id="${id}"] [data-testid="prompt-input"]`)?.focus({ preventScroll: true }));
  }
  async function quoteSelected(viewId: string, source: OpenedSession, sourceState: AgentReplicaState, target: { windowId: string; viewId: string }): Promise<void> {
    const selection = quoteSelection;
    if (selection?.viewId !== viewId || selection.busy) return;
    const epoch = sourceState.timeline.epoch;
    try {
      if (epoch !== selection.epoch) throw new Error('This conversation was reloaded. Select the messages again.');
      const excerpt = createSessionExcerpt({ id: crypto.randomUUID(), capturedAt: new Date().toISOString(), entries: sourceState.timeline.entries,
        source: { hostId: source.hostId ?? 'local', providerId: source.providerId, nativeSessionId: source.nativeSessionId, title: source.title },
        selected: entry => selection.keys.has(timelineEntryKey(epoch, entry)) });
      let destination = target.viewId;
      if (destination === NEW_SESSION_TARGET) {
        const creationId = selection.creationId ?? crypto.randomUUID();
        setQuoteSelection(current => current?.viewId === viewId ? { ...current, creationId, busy: true, error: undefined } : current);
        destination = await createQuoteSession(source, sourceState, creationId);
      }
      addQuote(baseUrl, destination, excerpt);
      setQuoteSelection(current => current?.viewId === viewId ? undefined : current);
      const window = quoteTargets(viewId, source).find(item => item.id === target.windowId);
      if (!window || window.current) { revealQuoteTarget(destination); return; }
      const title = window.views.find(item => item.viewId === destination)?.title ?? 'the session';
      setQuoteNotice({ viewId, message: `Quoted into “${title}” in Window “${window.title}”.`, async open() {
        await windowWorkspace.open(target.windowId); revealQuoteTarget(destination);
      } });
    } catch (error) {
      setQuoteSelection(current => current?.viewId === viewId ? { ...current, busy: false, error: message(error, 'The messages could not be quoted.') } : current);
    }
  }
  const openExcerptSource = useCallback((source: { hostId?: string; providerId: string; nativeSessionId: string; title: string }) =>
    navigateAttributionRef.current({ id: 'excerpt-source', kind: 'quote', label: 'Quoted from', value: source.title,
      target: { kind: 'session', hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId } }).catch(() => undefined), []);
  // Stable wrappers keep memoized timelines from rendering again on unrelated changes.
  const quotedActionCache = useRef(new WeakMap<LabWorkbenchActions, Map<string, LabWorkbenchActions>>());
  function quotedActions(base: LabWorkbenchActions, viewId: string): LabWorkbenchActions {
    let byView = quotedActionCache.current.get(base);
    if (!byView) quotedActionCache.current.set(base, byView = new Map());
    const key = JSON.stringify([baseUrl, viewId]);
    let wrapped = byView.get(key);
    if (!wrapped) byView.set(key, wrapped = withViewQuotes(base, baseUrl, viewId));
    return wrapped;
  }
  const referencedActionCache = useRef(new WeakMap<LabWorkbenchActions, Map<string, LabWorkbenchActions>>());
  const referencedStates = useRef(new Map<string, AgentReplicaState | undefined>());
  /** The next message of a view carries the session's changed references; the wrapper stays stable while its session does. */
  function referencedActions(base: LabWorkbenchActions, session: OpenedSession, state: AgentReplicaState | undefined): LabWorkbenchActions {
    const holder = { hostId: session.hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId };
    const key = JSON.stringify([baseUrl, holder.hostId ?? 'local', holder.providerId, holder.nativeSessionId]);
    referencedStates.current.set(key, state);
    let byHolder = referencedActionCache.current.get(base);
    if (!byHolder) referencedActionCache.current.set(base, byHolder = new Map());
    let wrapped = byHolder.get(key);
    if (!wrapped) byHolder.set(key, wrapped = withSessionReferences(base, baseUrl, holder, () => referencedStates.current.get(key)));
    return wrapped;
  }
  /** Starting a selection in another view replaces the one in progress. */
  function quoteEntrySelection(viewId: string, epoch: string | null): TimelineEntrySelection {
    const selected = quoteSelection?.viewId === viewId && quoteSelection.epoch === epoch ? quoteSelection.keys : undefined;
    return { label: 'Quote', selected, select(keys, value) {
      setQuoteNotice(undefined);
      setQuoteSelection(current => {
        const same = current?.viewId === viewId && current.epoch === epoch;
        const next = new Set(same ? current.keys : []);
        for (const key of keys) if (value) next.add(key); else next.delete(key);
        return { ...(same ? current : {}), viewId, epoch, keys: next, error: undefined };
      });
    } };
  }
  const sessionPresentationRef = useRef(sessionViewPresentation);
  sessionPresentationRef.current = sessionViewPresentation;
  const presentSessionView = useCallback((context: FamilySessionPresentationContext, options?: Parameters<typeof sessionViewPresentation>[1]) => sessionPresentationRef.current(context, options), []);
  /** team: a Team Leader or Member view, which shows the member's name and offers Handoff like a primary view. */
  /**
   * A bot's earlier sessions, read above its current conversation in Bot mode after handoffs. The element is kept per chain so
   * the memoized timeline does not re-render, and the chain comes from the validated succession history.
   */
  function earlierConversationFor(navigation: ReturnType<typeof succession.historyNavigationFor>) {
    if (!navigation?.predecessor || navigation.history) return undefined;
    const sessions = [navigation.predecessor, ...navigation.ancestors];
    const key = JSON.stringify([baseUrl, sessions.map(sessionKey)]);
    let element = earlierConversations.current.get(key);
    if (!element) {
      element = <EarlierConversation baseUrl={baseUrl} transport={transport} directory={hostId => earlierDirectory.current(hostId)} sessions={sessions} />;
      earlierConversations.current.set(key, element);
      if (earlierConversations.current.size > 32) earlierConversations.current.delete(earlierConversations.current.keys().next().value!);
    }
    return element;
  }
  function sessionViewPresentation(context: FamilySessionPresentationContext, options: { team?: boolean; bot?: { groupId: string; viewId: string }; fallback?: boolean } = {}) {
    const team = options.team === true, botPresentation = !!options.bot || options.fallback === true;
    const source = { ...(team ? context.session : withConfirmedTitle(context.session)), hostId: context.session.hostId ?? 'local', viewId: context.viewId!, ...(options.bot ? { bot: options.bot } : options.fallback ? { fallback: true } : {}) };
    const botGroup = options.bot ? windowWorkspace.readGroup(options.bot.groupId) : undefined;
    const view = options.bot ? botGroup?.window.views.find(view => view.id === options.bot!.viewId) : sharedWindow?.views.find(view => view.id === context.windowViewId);
    const isPrimary = view?.placement === 'primary';
    const fork = forkStore.find(source);
    // In a Window, a fork view's input belongs to the fork only while that view still shows it.
    const forkTarget = fork?.target;
    const targetsFork = forkTarget && context.windowViewId ? () => {
      const binding = windowWorkspace.readWindow()?.views.find(item => item.id === context.windowViewId)?.binding;
      return !!binding && sessionKey({ ...binding, hostId: binding.hostId ?? 'local' }) === sessionKey({ ...forkTarget, hostId: forkTarget.hostId ?? 'local' });
    } : undefined;
    const commands = botPresentation ? context.actions : forkActions(actions ?? context.actions, forkStore, fork, transport, targetsFork);
    const gated = successionGated && successionDialog?.scope === baseUrl && viewKey(successionDialog.source) === source.viewId;
    const host = remoteHosts.find(host => host.id === source.hostId);
    const available = accessReady && !context.offline && context.status === 'ready' && !context.pending && sourceCurrent(source);
    const handoffAvailable = available && (!botPresentation || context.state?.agent?.status === 'idle') && !successionDialog && userScoped && !!directory && !source.parentNativeSessionId
      && !context.sessionState.readOnly && !context.operationBinding.historical && host?.access !== 'shared' && host?.online === true;
    const mayRename = !team && userScoped && host?.online && host.access !== 'shared' && host.providers?.some(provider => provider.providerId === source.providerId && provider.sessionRename);
    const sourceForks = forkStore.linked().filter(item => item.target && sessionKey(sideNavigationSource(item)) === sessionKey(source));
    // References live on the Host; a shared Host's sessions keep showing only their source.
    const referencing = userScoped && !!directory && host?.access !== 'shared' && !!host?.providers?.some(provider => provider.providerId === source.providerId && provider.sessionReferences);
    const refHolder = { hostId: source.hostId, providerId: source.providerId, nativeSessionId: source.nativeSessionId };
    // A Controller that tells the agent itself needs no note from this page.
    const pageNotes = referencing && !host?.providers?.some(provider => provider.providerId === source.providerId && provider.referenceNotes);
    const forkReference = fork ? <ForkReference fork={fork} onOpen={revealSession} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} /> : null;
    // Quoting happens between the session views of shared Windows.
    const quoteView = !botPresentation && sharedWindow && context.windowViewId && !source.parentNativeSessionId ? context.windowViewId : undefined;
    return {
      headingMode: compactLayout ? 'toolbar' as const : 'inline' as const,
      state: botPresentation ? context.state : forkDisplayState(context.state, fork),
      questionDrafts: questionDrafts[source.agentId] ?? {},
      onQuestionDraftChange: (requestId: string, draft: QuestionDraft) => setQuestionDrafts(current => ({
        ...current, [source.agentId]: { ...current[source.agentId], [requestId]: draft },
      })),
      // A cached Window not yet confirmed by the service shows its sessions without sending to them.
      mutationBlocked: gated || windowWorkspace.provisional,
      onInspectEntry: botPresentation ? undefined : (key: string) => {
        if (view) windowWorkspace.authority?.operate({ type: 'view.select', viewId: view.id });
        setTraceNavigation({ scope: JSON.stringify([context.state?.agent?.id, context.state?.timeline.epoch]), key, view: 'trace', requestId: ++traceRequestCounter.current });
        setActiveView('trace');
      },
      revealEntry: botPresentation ? undefined : letterReveals[source.agentId] ?? (traceRequest?.view === 'workbench' && context.state?.agent?.id === state?.agent?.id ? traceRequest : undefined),
      onNavigateAttribution: botPresentation ? async (attribution: SessionAttribution) => {
        if (!attribution.target) return;
        if (attribution.target.kind === 'group') throw new Error('Open this group in Window mode.');
        navigation.select({ kind: 'session', session: { ...attribution.target, title: attribution.value } });
      } : undefined,
      onPendingInputChange: (count: number) => setPendingGroupInputs(values => values[source.viewId] === count ? values : { ...values, [source.viewId]: count }),
      actions: botPresentation ? commands : forkInputStatus?.pending && forkInputStatus.agentId === source.agentId ? { deleteMessage: commands.deleteMessage }
        : pageNotes ? referencedActions(quoteView ? quotedActions(commands, quoteView) : commands, source, context.state) : quoteView ? quotedActions(commands, quoteView) : commands,
      ...(quoteView && context.state ? { entrySelection: quoteEntrySelection(quoteView, context.state.timeline.epoch) } : {}),
      ...(quoteView ? { receiveQuotes: (excerpts: readonly SessionExcerpt[]) => restoreQuotes(baseUrl, quoteView, excerpts) } : {}),
      consoleCommands: [...(!botPresentation && available && directory && context.state?.agent?.capabilities.sendMessage && context.state.agent.capabilities.history ? forkCommands : []), ...(handoffAvailable ? [handoffCommand] : []),
        ...(!botPresentation && referencing && available ? [refCommand] : [])],
      onExecuteConsoleCommand: async (id: string, args: string): Promise<AgentCommandResult> => {
        if (id === refCommand.id) {
          await loadSessionRefs(baseUrl, refHolder);
          if (sessionRefsEntry(baseUrl, refHolder).unsupported) throw new Error('Referencing sessions needs a newer Controller. Update the Controller in Settings.');
          setReferencePicker(source.viewId);
          return {};
        }
        assertSourceCurrent(source);
        if (id === handoffCommand.id) {
          if (botPresentation && sourceStateFor(source)?.agent?.status !== 'idle') throw new Error('Wait for this conversation to become idle before handing it off.');
          if (!handoffAvailable) throw new Error('Handoff requires a current writable conversation with authorized Host access.');
          setSuccessionDialog({ scope: baseUrl, source, visible: true, initialProvider: handoffProvider(args), directory: labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, source.hostId)) });
          return {};
        }
        if (botPresentation) throw new Error('This command is unavailable in Bot mode.');
        if (!context.state || !available) throw new Error('Wait for this session to finish synchronizing.');
        return createFork(context.state, source, id, args);
      },
      composerStatus: <>{gated || successionDialog && viewKey(successionDialog.source) === source.viewId ? successionProgress : null}
        {quoteView && quoteSelection?.viewId === quoteView && context.state ? <QuoteSelectionBar count={quoteSelection.keys.size} windows={quoteTargets(quoteView, source)}
          busy={!!quoteSelection.busy} error={quoteSelection.error} onCancel={() => setQuoteSelection(undefined)}
          onQuote={target => void quoteSelected(quoteView, source, context.state!, target)} /> : null}
        {quoteView && quoteNotice?.viewId === quoteView ? <QuoteNotice message={quoteNotice.message} onDismiss={() => setQuoteNotice(undefined)}
          onOpen={quoteNotice.open ? () => { const open = quoteNotice.open!; setQuoteNotice(undefined); void open().catch(() => {}); } : undefined} /> : null}</>,
      // Bot mode does not announce a handoff: the conversation continues into the earlier sessions instead of linking to them.
      timelineStart: botPresentation ? earlierConversationFor(succession.historyNavigationFor(source)) : undefined,
      headingContext: botPresentation ? undefined : <SessionSuccessionHistory navigation={succession.historyNavigationFor(source)}
        onOpen={(session, intent) => view && sharedWindow
          ? bindDirectorySession({ ...session, sessionIntent: intent }, { windowId: sharedWindow.id, viewId: view.id, binding: JSON.stringify(view.binding ?? null) })
          : Promise.resolve(false)} />,
      composerContext: botPresentation ? undefined : <>{referencing ? <SessionReferences scope={baseUrl} holder={refHolder} providers={host?.providers?.map(provider => provider.providerId) ?? [source.providerId]}
          fallback={forkReference} snapshot={fork?.mode === 'reference' ? null : forkReference} picking={referencePicker === source.viewId}
          shown={new Set(sourceForks.flatMap(item => item.target ? [`${item.target.providerId}/${item.target.nativeSessionId}`] : []))} onPickingChange={picking => setReferencePicker(picking ? source.viewId : undefined)}
          onOpen={ref => void openExcerptSource({ hostId: source.hostId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, title: ref.title ?? '' })}
          onRemoved={(ref, restore) => removedReference(ref, restore, fork)} onRestore={() => restoredReference(fork)} /> : forkReference}
        {quoteView ? <QuoteAttachments scope={baseUrl} viewId={quoteView} /> : null}</>,
      composerNotice: botPresentation ? undefined : <ForkEntries forks={sourceForks} openSides={openSideKeys(source.viewId)} onOpen={record => void openFork({ ...record, navigationSource: source })} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} />,
      sessionManager: botPresentation ? undefined : <>{context.controls}{isPrimary ? <button type="button" data-pane-selection-ignore aria-label={`Close primary group: ${source.title}`}
        title={foldsOnClose(view) ? 'Fold. It stays in this group.' : 'Close this session view. Agent sessions keep running.'}
        onClick={() => closeView(view.id)}>×</button> : null}
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
          {quoteView && context.state && quoteSelection?.viewId !== quoteView
            ? <QuoteMessagesButton onClick={() => quoteEntrySelection(quoteView, context.state!.timeline.epoch).select([], true)} /> : null}
        </SessionHeadingActions></>,
      conversationPath: botPresentation ? <span className="lab-bot-session-heading">{options.bot ? <BotPicture picture={botGroup?.bots?.members[options.bot.viewId]?.picture} name={view?.binding ? botDisplayName(view.binding) : source.title} /> : null}<span><strong>{source.title}</strong>{options.bot && botGroup?.bots?.members[options.bot.viewId]?.label ? <small>{botGroup.bots.members[options.bot.viewId]!.label}</small> : null}<small>{context.offline ? 'Host offline' : context.state?.agent?.status === 'waiting' || context.state?.agent?.status === 'starting' ? 'Needs you' : context.state?.agent?.status === 'running' ? 'Working' : context.state?.agent?.status === 'failed' ? 'Failed' : context.status === 'ready' ? 'Idle' : 'Status unavailable'}</small></span></span> : <SessionTitle className={isPrimary ? 'lab-primary-title' : undefined} title={source.title} status={context.state?.agent?.status}
        onRename={mayRename ? () => setRenamingSession({ scope: baseUrl, session: { ...source, hostId: source.hostId ?? 'local' } }) : undefined} />,
    };
  }
  /** Whether the shown Window's view is a bot put to sleep (stored with its group). */
  function asleepBot(view: { id: string }) {
    return !!sharedWindow && !!windowWorkspace.readGroup(sharedWindow.id)?.bots?.members[view.id]?.asleep;
  }
  /** Wakes a sleeping bot for every device, keeping its other details. */
  function wakeBot(groupId: string, viewId: string) {
    const { asleep: _asleep, ...details } = windowWorkspace.readGroup(groupId)?.bots?.members[viewId] ?? {};
    void windowWorkspace.operateGroup(groupId, { type: 'bot.update', viewId, details }).catch(error => setSessionNotice(sessionConnectionFailure(error, false)));
  }
  /** A bot of a group shown in Bot mode folds when its pane closes; removing it from the group is a separate, confirmed step. */
  function foldsOnClose(view: WindowView | undefined): view is WindowView & { binding: WindowSessionBinding } {
    const group = sharedWindow ? windowWorkspace.readGroup(sharedWindow.id) : undefined;
    return !!view && !!group && hasBotAppearance(group) && isBotView(view) && !missingSessions.has(sessionKey(view.binding));
  }
  /** The × of a pane in the shown Window: a bot folds where it stands, any other view closes. */
  function closeView(viewId: string) {
    const authority = windowWorkspace.authority, current = authority?.readWindow?.() ?? authority?.window;
    if (!authority || !current) return;
    authority.operate(foldsOnClose(current.views.find(view => view.id === viewId)) ? foldOperation(current, viewId) : { type: 'view.close', viewId });
  }
  /** Removing a view from the shown Window's list: a bot of a group in Bot mode asks first. */
  function confirmBotRemoval(view: WindowView): boolean {
    if (!sharedWindow || !foldsOnClose(view)) return false;
    setRemovingBot({ windowId: sharedWindow.id, viewId: view.id });
    return true;
  }
  /** Restores a folded or sleeping bot's pane and selects it; a sleeping bot wakes for every device. */
  function restoreView(viewId: string) {
    const authority = windowWorkspace.authority, current = authority?.readWindow?.() ?? authority?.window;
    const view = current?.views.find(item => item.id === viewId);
    if (!authority || !current || !view) return;
    if (asleepBot(view)) wakeBot(current.id, viewId);
    if (view.collapsed || current.selectedViewId !== viewId) authority.operate(viewSelection(view));
  }
  /** What a folded bot's slim card shows: who it is and how it is doing, from the shared channel, while its conversation is released. */
  function foldedBot(view: WindowView & { binding: WindowSessionBinding }): FoldedBot {
    return { name: botDisplayName(view.binding), picture: sharedWindow ? windowWorkspace.readGroup(sharedWindow.id)?.bots?.members[view.id]?.picture : undefined,
      role: botRole(view, teamId => supportTeams.has(teamId)), status: botActivityLabel(windowSessionStatus(sharedWindow ? currentBotSession(sharedWindow.id, view.id, view.binding) : view.binding)), asleep: asleepBot(view) };
  }
  function providerDisplayName(hostId: string, id: string): string {
    return remoteHosts.find(host => host.id === hostId)?.providers?.find(provider => provider.providerId === id)?.displayName
      ?? (hostId === 'local' ? providers.find(provider => provider.providerId === id)?.displayName : undefined) ?? id;
  }
  /** Where a bot runs, and the providers of its earlier sessions (oldest first) when its handoff chain is known, for its Info sheet. */
  function describeBot(place: { groupId: string; viewId: string }): BotInfo | undefined {
    const binding = windowWorkspace.readGroup(place.groupId)?.window.views.find(view => view.id === place.viewId)?.binding;
    if (!binding) return;
    const hostId = binding.hostId ?? 'local', host = remoteHosts.find(candidate => candidate.id === hostId);
    const slotId = succession.document.windowBindings?.find(entry => entry.windowId === place.groupId && entry.viewId === place.viewId && entry.bindingKey === windowBindingKey(binding))?.slotId;
    const chain = slotId ? succession.historyNavigationFor({ hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId, title: binding.title, viewId: slotId }) : undefined;
    const earlier = chain?.predecessor && !chain.history ? [...chain.ancestors].reverse().concat(chain.predecessor) : [];
    return { host: host?.name ?? hostId, ...(host ? { online: host.online } : {}), provider: providerDisplayName(hostId, binding.providerId),
      earlier: earlier.map(session => providerDisplayName(session.hostId ?? hostId, session.providerId)) };
  }
  function describeBotConversation(place: BotPlace, capturedSource?: OpenedSession): SessionSurfaceDescriptor | undefined {
    if (place.kind === 'section') return;
    const group = place.kind === 'bot' ? windowWorkspace.readGroup(place.groupId) : undefined;
    const view = place.kind === 'bot' ? group?.window.views.find(view => view.id === place.viewId) : undefined;
    const target = capturedSource ? { ...capturedSource, hostId: capturedSource.hostId ?? 'local' } : place.kind === 'session' ? { ...place.session, hostId: place.session.hostId ?? 'local' } : view?.binding;
    const confirmed = place.kind !== 'bot' || selectedBot.group?.window.id === place.groupId && selectedBot.view?.id === place.viewId && !!selectedBot.slot;
    const retained = botPresentation.recovering && place.kind === 'bot' && botPresentation.confirmed?.groupId === place.groupId && botPresentation.confirmed.viewId === place.viewId
      ? botPresentation.confirmed : undefined;
    if (!target || !capturedSource && place.kind === 'bot' && (!group || !hasBotAppearance(group) || group.bots?.members[place.viewId]?.hidden || !confirmed && !retained)) return;
    const mappedSlot = capturedSource ? viewKey(capturedSource) : place.kind === 'bot' && view?.binding ? succession.document.windowBindings?.find(entry => entry.windowId === place.groupId && entry.viewId === place.viewId && entry.bindingKey === windowBindingKey(view.binding!))?.slotId : undefined;
    const slot = place.kind === 'bot' ? succession.document.slots.find(slot => slot.id === mappedSlot) : succession.ensureView(target);
    if (!slot || retained && !confirmed && retained.slotId !== slot.id) return;
    const host = remoteHosts.find(host => host.id === target.hostId);
    return { slotId: slot.id, titleInteraction: undefined, props: {
      storageScope: baseUrl, baseUrl, target, viewId: slot.id, windowViewId: view?.id,
      hostLabel: host?.name ?? target.hostId, compact: compactLayout, active: !windowMode, visible: !windowMode,
      attachmentEnabled: accessReady && confirmed, mutationBlocked: !accessReady || !confirmed,
      offline: host?.online === false, familyRoot: false, entries: [target], transport, replicaFor,
      directoryFor: hostId => hostId === selectedHost.id ? directory : undefined,
      draftStore: messageDrafts, draftBinding: draftOwnerBinding(slot.owners.text), imageDraftBinding: slot.owners.image,
      displayBinding: view ? { scope: baseUrl, key: view.id } : undefined,
      fixedDisplayMode: 'content', successionContext: succession.successionContextFor(slot.id),
      sessionPresentation: context => presentSessionView(context, place.kind === 'bot' ? { bot: { groupId: place.groupId, viewId: place.viewId } } : { fallback: true }),
      onNavigate: async (destination, _children, source) => { navigation.select({ kind: 'session', session: { ...destination, hostId: 'hostId' in destination ? destination.hostId ?? source.hostId : source.hostId, providerId: 'providerId' in destination ? destination.providerId : source.providerId } }); },
    } };
  }
  const handoffSource = successionDialog?.source as (OpenedSession & { bot?: { groupId: string; viewId: string }; fallback?: boolean }) | undefined;
  const handoffPlace: BotPlace | undefined = handoffSource?.bot ? { kind: 'bot', ...handoffSource.bot } : handoffSource?.fallback ? { kind: 'session', session: handoffSource } : undefined;
  const retainedHandoff = handoffPlace && handoffSource ? describeBotConversation(handoffPlace, handoffSource) : undefined;
  const successionFailure = succession.error && succession.error !== nativeTakeover?.message && !selectedPrimaryMissing ? succession.error : undefined;
  const successionRetry = successionFailure && !nativeTakeover ? <button type="button" onClick={succession.retry}>{succession.result?.status === 'applied' ? 'Retry session' : 'Retry synchronization'}</button> : undefined;
  // One failure gets one notice; the connection notice already explains this succession failure.
  const successionNotice = !!successionFailure && !nativeTakeover && sessionNotice?.successionError === successionFailure;
  // While the desktop sidebar is visible, the Window, Team, TPM, Track and Ask capsules give way to its Windows section and Shortcuts rows.
  const sidebarShortcuts = windowMode && !compactLayout && desktopContextVisible;
  const menuCurrentBinding = sharedWindow ? directoryView?.binding : currentSession ? windowSessionBinding(currentSession) : undefined;
  // Track, Team and TPM; Ask has its own host because its capsule floats inside .lab-ask-workspaces.
  const trackTeamTpmEntries = <>
    {windowMode && userScoped && attention.trackVisible ? <SessionTrackingMenu catchUp={catchUp} tracking={tracking} teams={teamRoster?.baseUrl === baseUrl ? teamRoster.teams : []} knownSessions={[...favorites.stars, ...sessionEntries]} busy={transitioning} inert={supportingRailOpen} onOpen={item => void openTrackedSession(item)} /> : null}
    <TeamMenu visible={windowMode && teamView.visible} baseUrl={baseUrl} enabled={accessReady && !!directory} hosts={remoteHosts} source={featureSource} sourceViewId={sharedWindow && presentedViewId ? `${sharedWindow.id}/${presentedViewId}` : undefined}
      compact={compactLayout} currentSession={focusedMenuSession} onTeamsChange={updateTeamRoster} reveal={teamReveal?.baseUrl === baseUrl ? teamReveal : undefined}
      onOpen={openTeamLayout} onOpenSession={target => openSession(target, undefined, undefined, false, undefined, undefined, undefined, undefined, compactLayout ? 'primary' : undefined)} />
    <TpmMenu tpm={tpm} open={tpmListOpen} onOpenChange={setTpmListOpen} mainSessions={tpmMainSessions} main={featureSource} visible={windowMode && tpmView.visible} triggerRef={tpmTriggerRef} inert={supportingRailOpen} />
  </>;
  const askEntry = askSurfaceVisible ? <AskButton triggerRef={askTriggerRef}
        disabled={!canOpenFocusedAsk} sourceTitle={focusedAskSession?.title} unavailable={focusedAskUnavailable}
        observation={focusedAskEntry?.record?.target ? tracking.observations[sessionKey(focusedAskEntry.record.target)] : undefined}
        onOpen={() => { if (canOpenFocusedAsk && focusedAskSession) openAsk(focusedAskSession, focusedAskState); }} /> : null;
  const shortcutPlacement = sidebarShortcuts ? 'sidebar' : 'floating';
  // The Host, provider, directory and new-session panels: written once, placed in the compact drawer or on the desktop page.
  // On desktop the page itself is the Favorites region, and its toolbar the Favorites heading: the section inside it carries no second name or heading.
  const sessionPanelContent = <div className="lab-sidebar-content">
      {sessionPanel === 'settings' ? <section className="lab-mobile-settings" aria-label="Controller settings">
        <MobileDisplaySettings />
        <CachePrivacySettings />
        <CallForSupportSettings baseUrl={baseUrl} enabled={accessReady && !!directory} hosts={remoteHosts} />
        <LayoutDiagnosticsSettings />
      </section> : null}
      {userScoped && sessionPanel === 'favorites' ? <section className="lab-session-directory lab-favorites-section" aria-label={compactLayout ? 'Favorites' : undefined}>{compactLayout ? <div className="lab-directory-heading"><h2><FavoritesHeading loading={favorites.loading} /></h2></div> : null}<FavoritesList favorites={favorites} tracking={tracking} trackedOnly={trackedOnly} onFilterChange={setTrackedOnly} activeKey={focusedSessionKey} busy={transitioning && !sidebarWindow} onOpen={item => void openDirectorySession(item)} /></section> : null}
      {directory && userScoped && sessionPanel === 'hosts' ? <HostOverview hosts={remoteHosts} service={hostClient} visible={windowMode && (compactLayout ? contextOpen : pageOpen)}
        compact={compactLayout} actionsTarget={compactLayout ? undefined : pageActionsTarget}
        onOpenHost={id => { const host = remoteHosts.find(item => item.id === id); if (host) selectHost(host); if (compactLayout) setSessionPanel('settings'); else openPage('settings'); }} /> : null}
      {directory && sessionPanel !== 'favorites' && sessionPanel !== 'hosts' ? <HostPairing compact={sessionPanel === 'list'} managementVisible={sessionPanel === 'settings'} service={hostClient} selectedHostId={selectedHost.id} selectionLocked={creationLocked || transitioning && !sidebarWindow} hosts={selectableHosts} hostError={hostError ?? requestedHostUnavailable} onRetryHosts={retryHosts} onSelect={selectHost} /> : null}
      {sessionPanel === 'settings' ? selectedRemoteHost?.id === previewHost?.id ? <HostVscodeTunnel key={selectedRemoteHost?.id} />
        : <VscodeTunnelScope service={vscodeTunnelClient} host={selectedRemoteHost} polling={windowMode && (compactLayout ? contextOpen : pageOpen)}>
          <HostVscodeTunnel key={selectedRemoteHost?.id} />
        </VscodeTunnelScope> : null}
      {directory && userScoped ? <div hidden={sessionPanel !== 'settings'}><ControllerUpdates service={hostClient} hosts={remoteHosts} /></div> : null}
      <div className="lab-directory-panel" hidden={sessionPanel !== 'list'}>
      {directory || providerChoices.length > 1 ? <label className="lab-browse-provider">Browse provider<select aria-label="Browse provider" value={selectedProviderChoice?.selectionId ?? ''} disabled={creationLocked || transitioning && !sidebarWindow || providerChoices.length === 0} onChange={(event) => selectProvider(event.target.value)}>{providerChoices.length === 0 ? <option value="">No providers available</option> : null}{providerChoices.map((provider) => <option key={provider.selectionId} value={provider.selectionId}>{provider.displayName}</option>)}</select></label> : null}
      {directory ? <SessionDirectory quickOpen={<button type="button" className="lab-session-scan-trigger" aria-label="Scan session QR code" onClick={() => setScanOpen(true)}>Scan</button>} favorites={favorites} searchable directory={directory} providerId={providerId} activeAgentId={focusedMenuSession?.agentId} opened={openedSessions} known={sessionEntries} sideStore={forkStore} askStore={ask.store} hostId={selectedHost.id} onOpenRelated={(item) => void openDirectorySession(item)} busy={!sidebarWindow && (transitioning || remoteHosts.find((host) => host.id === selectedHost.id)?.online === false)} revision={directoryRevision} onOpen={(item) => void openDirectorySession(item)} onSelect={(item) => void openDirectorySession(item)} onClose={(agentId) => setOpenedSessions((current) => current.filter((item) => item.agentId !== agentId))} /> : null}
      </div>
      {sessionPanel === 'list' ? <HostPreviewGroups client={previewClient} hosts={remoteHosts} activeHostId={previewHost?.access !== 'shared' ? previewHost?.id : undefined} polling={windowMode && (compactLayout ? contextOpen : pageOpen)} onOpen={() => { if (compactLayout) { setContextOpen(false); setInspectorOpen(false); } }} onOpenSource={(sessionId, itemId, hostId) => void openPreviewSource(sessionId, itemId, hostId)} /> : null}
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
      {sessionNotice && !nativeTakeover && compactLayout && contextOpen ? <SessionConnectionNotice notice={sessionNotice} action={successionNotice ? successionRetry : undefined} /> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
      </div>;
  return <LiveConnectionsContext.Provider value={liveConnections}><SessionDescriptionsContext.Provider value={{ describe: session => describeSession({ session,
    sessions: [...favorites.stars, ...sessionEntries, ...tpmMainSessions.values()], forks: forkStore.all(), asks: ask.store.all(),
    tpmWorks: tpm.works, teams: teamRoster?.baseUrl === baseUrl ? teamRoster.teams : [],
    hostNames: new Map([['local', 'Lab server'], ...remoteHosts.map(host => [host.id, host.name] as const)]),
  }), hostName: id => remoteHosts.find(host => host.id === id)?.name, navigate: navigateAttribution }}><SessionExcerptNavigation.Provider value={openExcerptSource}><SessionViewOperationsContext.Provider value={{ storageScope: baseUrl, transport, enabled: accessReady && activated, resolveTarget: (source, requested) => {
    const mapped = currentGroupBinding(requested?.viewId);
    if (mapped && sessionKey(mapped.binding) !== sessionKey(source)) throw new Error('The session view binding changed. Reopen its current conversation.');
    const roster = teamRosterRef.current;
    const member = teamViewTarget(succession.document, roster?.baseUrl === baseUrl ? roster.teams : undefined, source, requested?.viewId);
    // A Team member follows prompt edits and handoffs alike: Team routing moves its seat to the successor.
    const result = succession.resolveTarget(source, requested);
    if (mapped && sessionKey(mapped.binding) !== sessionKey(result.target)) throw new Error('The session view binding is still synchronizing.');
    if (member && sessionKey(member) !== sessionKey(result.target)) throw new Error('The Team execution locator is still synchronizing.');
    return { ...result, target: { ...result.target, ...(member ? { teamId: member.teamId, teamMemberId: member.teamMemberId } : {}) } };
  }, directory: source => labSessionSuccessionDirectory(new SessionDirectoryClient(baseUrl, undefined, source.hostId)), refreshSettled: succession.refreshSettled,
    successionContextFor: succession.successionContextFor, synchronize: () => void succession.refresh() }}><AskViewScope.Provider value={askView.execute}><WindowSessionBridgeContext.Provider value={windowWorkspace.sessionBridge}><WindowLayoutContext.Provider value={windowWorkspace.authority}><SessionDockProvider key={baseUrl} storageScope={baseUrl} enabled={windowMode && !compactLayout && activeView === 'workbench'}
    docksHidden={!!sharedWindow && !compactLayout && docksHidden}><TeamViewScope.Provider value={teamView.execute}><TpmViewScope.Provider value={tpmView.execute}><TrackViewScope.Provider value={userScoped ? attention.executeTrack : undefined}><ConversationConnectionScope.Provider value={connections}><VscodeTunnelScope service={vscodeTunnelClient} host={previewHost} polling={windowMode && (compactLayout ? contextOpen : desktopContextVisible || pageOpen)}><PreviewScope client={previewClient} host={previewHost} polling={windowMode && (compactLayout ? contextOpen : desktopContextVisible || pageOpen)}><RecoveryScope.Provider value={readingPositions}><SessionConversationSurfaces scope={baseUrl} transport={transport} mode={navigation.mode}><ToastActivity.Provider value={windowMode}><main hidden={!windowMode} {...(!windowMode ? { inert: '' } : {})} data-workbench-mode="window" ref={shellRef} onPointerDownCapture={focusManagedWindow} onFocusCapture={focusManagedWindow} style={sidebar.style} className={`lab-shell lab-window-mode${headerHidden ? ' lab-header-hidden' : ''}${!compactLayout && !desktopContextVisible ? ' lab-context-hidden' : ''}${state?.agent ? ' lab-has-agent' : ''}${supportingRailOpen ? ' lab-supporting-open' : ''}${inspectorOpen ? ' lab-inspector-open' : ''}`}>
    {windowWorkspace.unavailable ? <div className="lab-window-recovery" data-deleted={windowWorkspace.deleted || undefined}><WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} /><p role="status">{windowWorkspace.deleted ? 'Window deleted. Choose another Window or create a new one.' : windowWorkspace.error ?? 'Opening Window…'}</p><WindowWorkspaces workspace={windowWorkspace} onNavigate={closePage} /></div> : null}
    {activated ? tracking.observers : null}
    {!windowWorkspace.unavailable ? <>
    {windowMode && scanOpen ? <SessionTransferDialog onOpen={openScannedSession} onClose={() => setScanOpen(false)} /> : null}
    <WindowMenu workspace={windowWorkspace} current={menuCurrentBinding}
      visible={windowMode && windowView.visible && !sidebarShortcuts} inert={supportingRailOpen} onOverview={windowOverviewAvailable ? () => setWindowOverviewOpen(true) : undefined} sessionStatus={windowSessionStatus}
      onRemoveView={confirmBotRemoval} />
    <WindowOverview workspace={windowWorkspace} scope={baseUrl} enabled={windowOverviewAvailable} open={windowMode && windowOverviewOpen} sessionStatus={windowSessionStatus} onOpenChange={setWindowOverviewOpen} />
    <div ref={shortcutFloatingSlot} className="lab-movable-slot" />
    <div className="lab-ask-workspaces" {...backgroundInert}>
      <div ref={askFloatingSlot} className="lab-movable-slot" />
      {askSources.flatMap(({ source, owner }) => {
        return ask.isOpen(source, owner)
          ? [renderAsk(source, sourceStateFor(source))] : [];
      })}
    </div>
    <WindowPresentationContext.Provider value={presentedViewId}>
    <div className="lab-tpm-workspaces">{tpm.opened.map((key, index) => {
      const item = tpm.works.find(item => item.key === key);
      if (!item) return null;
      return <TpmWorkspace key={key} item={item} mainTitle={tpmMainSessions.get(sessionKey(tpmMainTarget(item)))?.title} session={tpm.sessions[key]} replica={tpm.sessions[key] ? replicaFor(tpm.sessions[key]!.agentId) : undefined}
        visible={windowMode && tpmView.visible && tpm.windows.includes(key) && (!compactLayout || (sharedWindow ? presentedFeature?.kind === 'tpm' && presentedFeature.id === key : tpm.selected === key)) && !supportingRailOpen}
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
      {userScoped ? <FavoritesMenu onScan={directory ? () => setScanOpen(true) : undefined} status={focusedMenuStatus} currentSession={focusedMenuSession} title={focusedMenuSession?.title || (sharedWindow ? 'Select session' : 'Agent Remote')} favorites={favorites} tracking={tracking} activeKey={focusedSessionKey} busy={transitioning && !sidebarWindow} onOpen={item => void openDirectorySession(item)} /> : familyPath.length > 1 ? <select className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === focusedFamilyWindow?.agentId)?.status} aria-label="Side path" value={focusedFamilyWindow ? viewKey(focusedFamilyWindow) : ''} onChange={(event) => { const session = familyPath.find((entry) => viewKey(entry) === event.target.value); if (session) revealSession(session); }}>
        {familyPath.map((session, index) => <option className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === session.agentId)?.status} key={viewKey(session)} value={viewKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
      </select> : <span className="lab-mobile-session-title agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === addressSession?.agentId)?.status}>{addressSession?.title || 'Agent Remote'}</span>}
      {userScoped && familyPath.length > 1 ? <div className="lab-mobile-side-path">
        <span aria-hidden="true">{focusedFamilyIndex === 0 ? 'Root' : `Side ${focusedFamilyIndex}`}</span><span className="lab-mobile-side-chevron" aria-hidden="true">▾</span>
        <select aria-label="Side path" value={focusedFamilyWindow ? viewKey(focusedFamilyWindow) : ''} onChange={event => { const session = familyPath.find(entry => viewKey(entry) === event.target.value); if (session) revealSession(session); }}>
          {familyPath.map((session, index) => <option key={viewKey(session)} value={viewKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
        </select>
      </div> : null}
    </nav> : null}
    <ViewOptions modeControls={<WorkbenchModeSwitch mode={navigation.mode} onChange={navigation.setMode} />} attentionControls={<>
      {askView.controls}
      {windowView.controls}{userScoped ? attention.controls : null}{tpmView.controls}{teamView.controls}
    </>} target={!headerHidden ? headerViewTarget : compactLayout ? mobileViewTarget : desktopContextVisible ? sidebarViewTarget : pageOpen ? pageViewTarget : activeView === 'trace' ? traceViewTarget
      // A desktop Window keeps View options in one place, its toolbar, rather than in the first pane heading.
      : windowToolbarShown ? windowToolbarViewTarget : minimizedViewTarget ?? sessionViewTarget}
      triggerRef={viewTriggerRef} headerVisible={!headerHidden} sidebarVisible={contextVisible}
      inspectorVisible={inspectorOpen} compact={compactLayout} inert={!windowMode || supportingRailOpen}
      onSetAllVisible={setAllPanelsVisible} onToggleHeader={() => setHeaderHidden((value) => !value)} onToggleSidebar={toggleContext}
      onToggleInspector={() => inspectorOpen ? setInspectorOpen(false) : openInspector()} />
    <header className="lab-app-bar" hidden={headerHidden || windowWorkspace.unavailable}>
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
          onClick={() => { setActiveView('trace'); closePage(); }}
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
      {!compactLayout ? <SidebarHeader mode={navigation.mode} onModeChange={navigation.setMode} onSearch={openSearch} actions={<Menu label="New" icon="plus" items={[
        { label: 'New session', onSelect: openNewSessionPanel },
        { label: 'New Window', disabled: creatingWindow, onSelect: createWindowFromMenu },
      ]} />} /> : null}
      <div className="lab-rail-heading">
        {!compactLayout ? <div ref={setSidebarViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /> : null}
        <p className="lab-eyebrow" title={baseUrl}>Window</p>
      </div>
      {compactLayout ? <nav className="lab-session-panel-actions" aria-label="Sidebar sections">
        <button type="button" aria-pressed={sessionPanel === 'list'} onClick={() => setSessionPanel('list')}>Sessions</button>
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'favorites'} onClick={() => { setSessionPanel('favorites'); void favorites.refresh(); }}>Favorites</button> : null}
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'hosts'} onClick={() => setSessionPanel('hosts')}>Hosts</button> : null}
        <button type="button" aria-pressed={sessionPanel === 'settings'} onClick={() => setSessionPanel('settings')}>Settings</button>
      </nav> : null}
      {compactLayout ? sessionPanelContent : <>
        <div className="lab-sidebar-scroll">
          <section className="lab-sidebar-section">
            <WindowWorkspaces workspace={windowWorkspace} actions={windowActions} current={menuCurrentBinding} active={desktopContextVisible} sessionStatus={windowSessionStatus} onChooseView={showDockOf} onRemoveView={confirmBotRemoval}
              onOverview={windowOverviewAvailable ? () => setWindowOverviewOpen(true) : undefined} onNavigate={closePage} placement="sidebar" />
          </section>
          <nav className="lab-sidebar-section lab-sidebar-shortcuts" aria-label="Shortcuts">
            <h2 className="lab-sidebar-section-title">Shortcuts</h2>
            <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'list' ? 'page' : undefined} onClick={() => openPage('list')}>All sessions</button>
            {userScoped ? <button type="button" className="lab-sidebar-link" aria-current={pageOpen && sessionPanel === 'favorites' ? 'page' : undefined} onClick={() => openPage('favorites')}>Favorites</button> : null}
            <div ref={shortcutSidebarSlot} className="lab-movable-slot" />
            <div ref={askSidebarSlot} className="lab-movable-slot" />
          </nav>
        </div>
        <SidebarFooter hosts={selectableHosts} loaded={hostsLoaded} onHosts={() => openPage(userScoped ? 'hosts' : 'list')} hostsCurrent={pageOpen && sessionPanel === 'hosts'} onSettings={() => openPage('settings')} settingsCurrent={pageOpen && sessionPanel === 'settings'} />
      </>}
      {compactLayout && sessionPanel !== 'new' ? <footer className="lab-session-panel-footer"><button type="button" onClick={() => setSessionPanel('new')}><span aria-hidden="true">＋</span> New session</button></footer> : null}
    </SupportingRail>
    {/* After both slots, so a slot rendered in this commit is attached before the entries' layout effects run. */}
    <MovableHostSlot host={shortcutHost} slot={sidebarShortcuts ? shortcutSidebarSlot : shortcutFloatingSlot} />
    <MovableHostSlot host={askHost} slot={sidebarShortcuts ? askSidebarSlot : askFloatingSlot} />
    <ShortcutPlacement.Provider value={shortcutPlacement}>{createPortal(trackTeamTpmEntries, shortcutHost)}{createPortal(askEntry, askHost)}</ShortcutPlacement.Provider>
    {!compactLayout && contextVisible ? <SidebarResize width={sidebar.width} maximum={sidebar.maximum} onChange={sidebar.setWidth} /> : null}
    <PreviewWorkspace resourceScope={JSON.stringify([activeOpened?.hostId, activeAgentId, state?.timeline.epoch])} className="lab-main-stage" {...backgroundInert}>
      {!compactLayout ? <section id="lab-sessions-page" className="lab-sessions-page" aria-label={sessionsPageTitle} hidden={!pageOpen}
        onKeyDown={event => {
          // Text fields keep Escape for themselves (a search field clears on Escape); checkboxes, radios and buttons leave the page.
          if (event.key !== 'Escape' || event.defaultPrevented || keepsEscape(event.target as Element)) return;
          event.preventDefault(); closePage();
        }}>
        {/* On the Favorites page the toolbar heading is the Favorites heading, with its loading mark; the panel shows none. */}
        <Toolbar className="lab-sessions-page-toolbar" title={userScoped && sessionPanel === 'favorites' ? <FavoritesHeading loading={favorites.loading} /> : sessionsPageTitle} titleRef={sessionsPageTitleRef} titleFocusable
          leading={<><div ref={setPageViewTarget} data-pane-selection-ignore className="lab-global-view-slot" /><IconButton icon="chevron-left" label="Back to Window" onClick={closePage} /></>}
          trailing={<div ref={setPageActionsTarget} className="lab-page-actions" />} />
        {sessionPanel !== 'settings' && sessionPanel !== 'hosts' ? <div className="lab-session-open-target" role="status">Open in: <strong>{directoryView?.binding?.title ?? (directoryView ? 'Empty session view' : sidebarWindow?.target?.title ?? (sidebarWindow ? 'Empty session view' : 'Main session'))}</strong></div> : null}
        <div className="lab-sessions-page-body">{sessionPanelContent}</div>
      </section> : null}
      <section
        ref={workbenchPanelRef}
        className={sharedWindow ? 'lab-window-workbench' : (sessionNotice && !nativeTakeover && !(compactLayout && contextOpen)) || promptMigrations.notice ? 'lab-workbench-with-notice' : undefined}
        id="lab-workbench"
        data-testid="workbench"
        data-window-provisional={windowWorkspace.provisional || undefined}
        aria-busy={windowWorkspace.provisional || undefined}
        role="tabpanel"
        aria-labelledby="lab-workbench-tab"
        tabIndex={-1}
        hidden={activeView !== 'workbench' || pageOpen}
      >
        {windowToolbarShown && sharedWindow ? <WindowToolbar windowId={sharedWindow.id} title={sharedWindow.title} viewCount={sharedWindow.views.length}
          leading={<div ref={setWindowToolbarViewTarget} data-pane-selection-ignore className="lab-global-view-slot" />}
          // The title is not disabled while another Window action runs: renaming does not wait for them, and focus returns to the title after a rename.
          readOnly={windowWorkspace.provisional} deleteDisabled={windowActions.busy}
          onRename={title => void windowActions.saveRename(sharedWindow.id, title)}
          onNewView={addSessionView} onOpenSession={createSessionView}
          hasDocks={sharedWindow.views.some(view => view.placement === 'dock')} docksHidden={docksHidden} onToggleDocks={() => setDocksHidden(value => !value)}
          botAppearance={windowWorkspace.group ? hasBotAppearance(windowWorkspace.group) : undefined} onBotAppearance={shown => void windowActions.setBotAppearance(shown)}
          onCopyLink={() => void windowActions.copyLink()} onAgentControl={windowWorkspace.client ? () => setAgentControlOpen(true) : undefined}
          onDelete={() => setDeleteConfirmOpen(true)} /> : null}
        <div className="lab-session-windows">{sessionWindows.entries.map(entry => <SessionWindow key={entry.id} entry={entry} baseUrl={baseUrl}
          // Not windowStageVisible: `visible` also decides docking (a hidden view leaves the dock) and, through SessionFamily, keeps the
          // conversation attached. The sessions page hides #lab-workbench instead, and visibleWindows leaves these views unseen.
          visible={windowMode && activeView === 'workbench' && !supportingRailOpen && (!compactLayout || (sharedWindow ? presentedRootView?.id : sessionWindows.selectedId) === entry.id)} compact={compactLayout}
          closeWith={sessionWindows.entries.filter(child => child.closeWith === entry.id).map(child => child.id)}
          selected={sessionWindows.selectedId === entry.id} onFocus={() => sessionWindows.focus(sharedWindow ? entry.id : entry.managed ? undefined : entry.id)}
          onChangeSession={entry.managed ? undefined : () => chooseWindowSession(entry.id)}
          hostLabel={entry.target ? remoteHosts.find(host => host.id === entry.target!.hostId)?.name ?? entry.target.hostId : ''}
          offline={entry.target ? remoteHosts.find(host => host.id === entry.target!.hostId)?.online === false : false}
          actions={entry.groupId ? <TeamGatherButton baseUrl={baseUrl} entry={entry} onGather={targets => sessionWindows.gather(entry, targets)} /> : undefined}
          onSessionBound={entry.managed ? undefined : receiveViewSession}
          missing={!!entry.target && missingSessions.has(sessionKey(entry.target))} onSessionUnavailable={markSessionMissing}
          sessionPresentation={context => presentSessionView(context, { team: !!entry.groupId || !!entry.teamMemberId })}
          transport={transport} draftStore={messageDrafts} {...windowDraftBinding(entry)} navigation={viewNavigation} onClose={() => sessionWindows.close(entry.id)}
          {...windowPaneFolding(entry.id)} />)}</div>
        {sharedWindow && !sharedWindow.views.length ? <div className="lab-window-empty" data-testid="empty-window">
          <p>No session views</p><button type="button" onClick={createSessionView}>New session view</button>
        </div> : null}
        <div className="lab-ordinary-workspace" hidden={!!sharedWindow && (!sharedWindow.views.length || compactLayout && !presentedPrimaryViewId)}>
        {sessionNotice && !nativeTakeover && !(compactLayout && contextOpen) ? <SessionConnectionNotice notice={sessionNotice} action={successionNotice ? successionRetry : undefined} /> : null}
        {successionFailure && !successionNotice ? <SessionConnectionNotice notice={{ tone: 'alert', message: successionFailure }} action={successionRetry} /> : null}
        {promptMigrations.notice}
        {uncertainMutation ? <p className="lab-control-note" role="alert">The previous action may have completed before the connection was interrupted. Its result is unknown. It will not be replayed automatically.</p> : null}
        {sharedWindow ? <SessionDockRail compact={compactLayout} onCreateView={createSessionView}
          onSelectPrimaryGroup={selectPrimaryGroup}
          onResizePrimaryGroup={(viewId, width) => windowWorkspace.authority?.operate({ type: 'view.resize', viewId, width })}
          onCollapsePrimaryGroup={(viewId, collapsed) => {
            const view = sharedWindow.views.find(item => item.id === viewId);
            if (!collapsed && view && asleepBot(view)) wakeBot(sharedWindow.id, viewId);
            if (collapsed || view?.collapsed) windowWorkspace.authority?.operate({ type: 'view.collapse', viewId, collapsed });
          }}
          onClosePrimaryGroup={viewId => windowWorkspace.authority?.operate({ type: 'view.close', viewId })}
          onRemovePrimaryGroup={viewId => setRemovingBot({ windowId: sharedWindow.id, viewId })}
          primaryGroups={primaryGroups.map(view => {
            const pendingSlot = view.id === sharedWindow.selectedPrimaryViewId ? succession.displaySlot : undefined;
            const slot = sharedSlots?.get(view.id) ?? (pendingSlot && view.binding
              && [compositionSelection(pendingSlot), { hostId: pendingSlot.origin.target.hostId, ...pendingSlot.origin.target.native }]
                .some(source => sessionKey(source) === sessionKey(view.binding!)) ? pendingSlot : undefined);
            const additionalWidth = sharedWindow.views.filter(child => child.id !== view.id && windowPrimaryViewId(sharedWindow, child.id) === view.id && !child.collapsed).reduce((total, child) => total + child.width, 0);
            const missing = !!view.binding && missingSessions.has(sessionKey(view.binding));
            return { id: view.id, title: view.binding && !missing ? view.binding.title : 'Select session', width: view.width, additionalWidth,
              // A sleeping bot stands folded and dimmed; restoring it wakes it for every device.
              selected: view.id === presentedPrimaryViewId, collapsed: view.collapsed || asleepBot(view),
              // A folded bot shows who it is and how it is doing, from the shared channel, while its conversation is released.
              ...((view.collapsed || asleepBot(view)) && !missing && isBotView(view) ? { fold: foldedBot(view) } : {}),
              content: view.binding && !missing ? <SessionFamily baseUrl={baseUrl} storageScope={baseUrl} target={view.binding} viewId={view.id} folded={asleepBot(view)} onCloseView={closeView}
                sessionIntent={view.binding.sessionIntent}
                successionContext={succession.successionContextFor(slot?.id)}
                directoryFor={hostId => hostId === selectedHost.id ? directory : undefined}
                attachmentManaged={view.id === sharedWindow.selectedPrimaryViewId}
                attachedSession={succession.binding?.session.viewId === slot?.id ? succession.binding?.session : undefined}
                attachmentNotice={view.id === sharedWindow.selectedPrimaryViewId ? openingControlNotice : undefined}
                hostLabel={remoteHosts.find(host => host.id === view.binding!.hostId)?.name ?? view.binding.hostId}
                offline={remoteHosts.find(host => host.id === view.binding!.hostId)?.online === false}
                // Not windowStageVisible: an inactive family parks its conversation and releases its attachment, so
                // the sessions page, which hides #lab-workbench, would detach every view and reattach them on Back.
                compact={compactLayout} active={windowMode && activeView === 'workbench' && !supportingRailOpen && (!compactLayout || view.id === (presentedPrimaryViewId ?? sharedWindow.selectedPrimaryViewId))}
                transport={transport} draftStore={messageDrafts} replicaFor={replicaFor} onSessionBound={receiveViewSession} onSessionUnavailable={markSessionMissing}
                draftBinding={slot ? draftOwnerBinding(slot.owners.text) : undefined} imageDraftBinding={slot?.owners.image}
                displayBinding={{ scope: baseUrl, key: view.id }} navigation={viewNavigation}
                sessionPresentation={presentSessionView} />
                : <div className="lab-empty-session-view" role="status" data-view-id={view.id} aria-current={view.id === presentedViewId || undefined}>
                  <header className="lab-empty-session-heading">
                    <strong>Select session</strong>
                    <button type="button" data-pane-selection-ignore aria-label="Close primary group: Select session" title="Close session view"
                      onClick={() => windowWorkspace.authority?.operate({ type: 'view.close', viewId: view.id })}>×</button>
                  </header><div className="lab-empty-session-body">
                    {view.binding ? <MissingSessionNote title={view.binding.title} host={remoteHosts.find(host => host.id === view.binding!.hostId)?.name ?? view.binding.hostId} /> : <p>This session view is empty.</p>}
                    <div className="lab-empty-session-actions">
                      <button type="button" onClick={() => { selectPrimaryGroup(view.id); showWindowSessionChooser(); }}>Choose session</button>
                      <button type="button" onClick={() => { selectPrimaryGroup(view.id); openNewSessionPanel(); }}>New session</button>
                    </div></div></div>,
            };
          })} /> : <SessionDockRail onCreateView={createSessionView} minimizedHeader={<div ref={setMinimizedViewTarget} data-pane-selection-ignore className="lab-global-view-slot lab-minimized-view-slot" />} mainTitle={stackRoot?.title ?? activeOpened?.title} minimumBaseWidth={stackRange.end > stackRange.start ? 640 : 320}><ConversationSplit compact={compactLayout} start={stackRange.start} end={stackRange.end}>
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(0, stackRange.start)} offset={0} onExpand={revealSession} />
        <ConversationPane className="lab-primary-conversation lab-session-composition" data-active={!sessionWindows.activeId || undefined} tabIndex={-1} hidden={!primaryExpanded} onFocusCapture={event => focusPrimaryContent(event.target)} onClickCapture={event => focusPrimaryContent(event.target)}>
        {windowSession.empty ? <div className="lab-empty-session-view" role="status"><p>This session view is empty.</p><button type="button" onClick={openNewSessionPanel}>New session</button>{successionProgress}</div> : <><CommunicationNavigationContext.Provider value={primaryCommunication}><LabWorkbench {...primaryNavigation}
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
          state={forkDisplayState(state, boundFork)} sessionStatus={!accessReady ? 'connecting' : hostOffline ? 'disconnected' : status} attachingAgentId={attachingAgentId} actions={forkInputStatus?.pending && forkInputStatus.agentId === activeAgentId ? { deleteMessage: conversationActions.deleteMessage } : availableConversationActions} visible={windowStageVisible && primaryExpanded}
          consoleCommands={[...(status === 'ready' && !hostOffline && directory && state?.agent?.capabilities.sendMessage && state.agent.capabilities.history ? forkCommands : []), ...(canHandoffPrimary ? [handoffCommand] : [])]}
          onExecuteConsoleCommand={executePrimaryCommand}
          nativeTakeover={openingControlNotice}
          composerContext={boundFork ? <ForkReference fork={boundFork} onOpen={revealSession} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} /> : undefined}
          composerNotice={<ForkEntries forks={forkStore.linked().filter((fork) => fork.target && (sideNavigationSource(fork).agentId === activeAgentId || (activeOpened && sessionKey(sideNavigationSource(fork)) === sessionKey(activeOpened))))} openSides={stackRoot ? openSideKeys(viewKey(stackRoot)) : undefined} onOpen={(fork) => void openFork(fork)} onUnlink={unlinkSide} onRecover={record => refreshRelations.reconcile(record)} />}
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
          openSides={openSideKeys(viewKey(session))}
          initialInput={forkInputStatus?.agentId === session.agentId ? forkInputStatus : undefined}
          visible={windowStageVisible} draftBinding={draftBindingFor(session)}
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
        hidden={activeView !== 'trace' || pageOpen}
      >
        <TraceView key={traceScope} state={state} visible={windowMode && activeView === 'trace' && !pageOpen}
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
      open={windowMode && inspectorOpen}
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
    </> : null}
    {/* Mounted only while open, so other dialogs on the page stay the only ones there. */}
    {sharedWindow && windowToolbarShown && windowMode && agentControlOpen ? <Sheet open title="Agent control" onClose={() => setAgentControlOpen(false)}>
      <AgentControl client={windowWorkspace.client} windowId={sharedWindow.id} current={menuCurrentBinding} active />
    </Sheet> : null}
    {sharedWindow && windowToolbarShown && windowMode && deleteConfirmOpen ? <Sheet open title="Delete this Window?" onClose={() => setDeleteConfirmOpen(false)}>
      <p className="lab-sheet-message">{`“${sharedWindow.title}” and its layout are deleted. Its agent sessions keep running and stay in All sessions.`}
        {windowCatalog(windowWorkspace).every(window => window.id === sharedWindow.id) ? ' A new empty Window opens in its place.' : null}</p>
      <div className="lab-sheet-actions">
        <Button onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
        <Button variant="destructive" disabled={windowActions.busy || windowWorkspace.provisional} onClick={() => { setDeleteConfirmOpen(false); void windowActions.deleteCurrent(); }}>Delete Window</Button>
      </div>
    </Sheet> : null}
  </main></ToastActivity.Provider>{retainedHandoff ? <div hidden {...{ inert: '' }}><SessionConversationMount mode="bot" active={false} descriptor={retainedHandoff} /></div> : null}<BotWorkspace visible={!windowMode} compact={compactLayout} scope={baseUrl} workspace={windowWorkspace} navigation={navigation} selected={selectedBot} roster={botRoster} directory={otherSessions} describeConversation={describeBotConversation} rosterCollapsed={botRosterCollapsed} onToggleRoster={() => setBotRosterCollapsed(value => !value)} onSearch={openSearch}
      hostName={hostId => remoteHosts.find(host => host.id === hostId)?.name ?? hostId} botInfo={describeBot}
      onNewBot={directory ? openNewBot : undefined} />
    {removingBot && windowMode && sharedWindow?.id === removingBot.windowId && sharedWindow.views.some(view => view.id === removingBot.viewId) ? (() => {
      const view = sharedWindow.views.find(item => item.id === removingBot.viewId)!;
      return <RemoveBotSheet name={view.binding ? botDisplayName(view.binding) : 'Session view'} window={sharedWindow} viewId={view.id}
        onCancel={() => setRemovingBot(undefined)}
        onRemove={() => { windowWorkspace.authority?.operate({ type: 'view.close', viewId: view.id }); setRemovingBot(undefined); }} />;
    })() : null}
    {!windowMode && directory && newBot.open ? <NewBotSheet open onClose={() => setNewBot({ open: false })}
      hosts={selectableHosts.map(host => ({ id: host.id, name: host.name, disabled: host.online === false }))} hostId={selectedHost.id}
      onHostChange={id => { const host = selectableHosts.find(item => item.id === id); if (host) selectHost(host as RemoteHost); }}
      providers={providerChoices.map(choice => ({ id: choice.selectionId, name: choice.displayName }))} providerId={selectedProviderChoice?.selectionId ?? ''} nativeProviderId={selectedProviderChoice ? providerId : ''} onProviderChange={selectProvider}
      directory={directory} options={sessionOptions} onOptionsChange={setSessionOptions} canBrowse={remoteHosts.find(host => host.id === selectedHost.id)?.access !== 'shared'}
      unavailableReason={windowWorkspace.sectionCreationState.state === 'unknown' ? 'A new group is not confirmed yet. Retry it in the roster first.' : creationUnavailableReason}
      starting={transitioning} failure={newBot.failure} onStart={() => void createAgent(true)} /> : null}
    {/* Mounted only while open (it closes its modal as it unmounts, returning focus), so a closed palette adds no dialog to the page. */}
    {searchOpen ? <CommandPalette open items={commandItems()} onClose={() => setSearchOpen(false)} /> : null}</SessionConversationSurfaces></RecoveryScope.Provider></PreviewScope></VscodeTunnelScope></ConversationConnectionScope.Provider></TrackViewScope.Provider></TpmViewScope.Provider></TeamViewScope.Provider></SessionDockProvider></WindowLayoutContext.Provider></WindowSessionBridgeContext.Provider></AskViewScope.Provider></SessionViewOperationsContext.Provider></SessionExcerptNavigation.Provider></SessionDescriptionsContext.Provider></LiveConnectionsContext.Provider>;
}

function PreviewScope({ client, host, polling, children }: { readonly client: HttpPreviewClient; readonly host?: RemoteHost; readonly polling: boolean; readonly children: ReactNode }) {
  const enabled = !!host && host.access !== 'shared';
  return <PreviewProvider client={client} hostId={host?.id ?? ''} enabled={enabled} canManage={enabled} polling={polling}>{children}</PreviewProvider>;
}

const nonTextInputTypes = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);
/** Whether a control uses Escape itself: text fields, selects and editable content. */
function keepsEscape(target: Element): boolean {
  const field = target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  return !!field && !(field instanceof HTMLInputElement && nonTextInputTypes.has(field.type));
}

/** Whether focus is in the Window sidebar, or in a Menu (portalled outside it) whose trigger is in it. */
function focusWithinContext(): boolean {
  const context = document.getElementById('lab-context'), active = document.activeElement;
  if (!context || !active) return false;
  if (context.contains(active)) return true;
  const menu = active.closest('[role="menu"]');
  return !!menu?.id && [...context.querySelectorAll('[aria-controls]')].some(control => control.getAttribute('aria-controls') === menu.id);
}

function createAgentId(): string {
  return `lab-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
}

/** Whether the desktop Window toolbar hides the dock rail's panes; one choice for every Window. */
const DOCKS_HIDDEN_KEY = 'agent-remote:docks-hidden';

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
    case 'unavailable': return 'Unavailable';
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
