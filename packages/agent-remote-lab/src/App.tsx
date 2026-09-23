import { WorkspaceReady, workspaceFetch, workspaceSocket, readWorkspaceAccess } from './workspace-access.js';
import { readWorkspaceSnapshot, saveWorkspaceSnapshot } from './workspace-cache.js';
import { ControllerUpdates } from './components/ControllerUpdates.js';
import { readPromptEditReservation, retainPromptEditReservation, finishPromptEditReservation, type PromptEditReservation } from './prompt-edit-intent.js';
import { preparePromptDraft, savePromptDraft } from '@orchardworks/agent-remote-web/react';
import { useSessionMigrations } from './hooks/useSessionMigrations.js';
import { ReplicaCache } from './replica-cache.js';
import { DraftStore } from './draft-store.js';
import { useSessionStars } from './hooks/useSessionStars.js';
import { useSessionCatchUp } from './hooks/useSessionCatchUp.js';
import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { useSessionTracking } from './hooks/useSessionTracking.js';
import { FavoritesList, FavoritesMenu, StarButton } from './components/SessionFavorites.js';
import { SessionTrackingMenu } from './components/SessionTrackingMenu.js';
import { ToastProvider, useFeedbackToast } from './components/Toast.js';
import { SessionConnectionNotice, sessionConnectionFailure, type SessionConnectionMessage } from './components/SessionConnectionNotice.js';
import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { controllerPath, readControllerLocation, type ControllerLocation } from '@orchardworks/agent-remote-hosted/controller-location';
import { MobileDisplaySettings } from './components/MobileDisplaySettings.js';
import type { ScannedSession } from './session-transfer.js';
import { SessionLink, SessionTransferDialog } from './components/SessionLink.js';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@orchardworks/agent-remote-protocol';
import {
  useCallback,
  useContext,
  useEffect,
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
import { ReadingPositions, RecoveryScope, recoveryGeneration, readLastSession, saveLastSession } from './conversation-recovery.js';
import { recoverMessages } from './message-recovery.js';
import { restoreSession } from './session-restoration.js';
import { useRemoteHosts } from './hooks/useRemoteHosts.js';
import { useVisualViewport } from './hooks/useVisualViewport.js';
import { HostPairing, type HostPairingService, type RemoteHost } from './components/HostPairing.js';
import { DirectoryError, RemoteHostClient, SessionDirectoryClient, type CreateSessionOptions, type OpenedSession, type SessionSummary } from './directory-client.js';
import { SessionConfiguration, SessionDirectory } from './components/SessionDirectory.js';
import { useSessionEntries } from './hooks/useSessionEntries.js';
import { useConversationHistory } from './hooks/useConversationHistory.js';
import { sessionActivity } from './session-activity.js';
import { sessionKey, sessionRootKey, sessionChildren } from './session-tree.js';
import { ViewOptions } from './components/ViewOptions.js';
import { PreviewProvider, PreviewWorkspace, TimelineDisplay, createTimelineRenderModel, isContentOnlyItem, type AgentChildSessionView } from '@orchardworks/agent-remote-web/react';
import { useTimelineDisplayMode } from './hooks/useTimelineDisplayMode.js';
import { ChatSessionManager } from './components/ChatSessionManager.js';
import { LabWorkbench, type LabWorkbenchActions } from './components/LabWorkbench.js';
import { SideConversation } from './components/SideConversation.js';
import type { FloatingPosition } from './hooks/useTrackingPosition.js';
import { AskButton } from './components/AskButton.js';
import { AskConversation } from './components/AskConversation.js';
import { useAskConversations } from './hooks/useAskConversations.js';
import { ForkEntries, ForkReference } from './components/ForkReference.js';
import { referenceForkContext, captureForkContext, forkDisplayState, ForkStore, type SessionFork } from './session-forks.js';
import { CollapsedConversations } from './components/CollapsedConversations.js';
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
  const askPositionRef = useRef<FloatingPosition>(null);
  const askTriggerRef = useRef<HTMLButtonElement>(null);
  const readingPositions = useMemo(() => new ReadingPositions(baseUrl), [baseUrl]);
  const transport = useMemo<LabTransport>(() => injectedTransport
    ?? new HttpWebSocketTransport(baseUrl, { sessionChannels: true, fetch: workspaceFetch, webSocketFactory: workspaceSocket }) as LabTransport, [baseUrl, injectedTransport]);
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
  const [requested] = useState<{ target?: ControllerLocation; error?: string }>(() => {
    try {
      const target = readControllerLocation(new URLSearchParams(window.location.search));
      return { target: Object.keys(target).length ? target : readLastSession(baseUrl) };
    }
    catch { return { error: 'Invalid session link.' }; }
  });
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
  const [askSimple, setAskSimple] = useState(false);
  const restoredHostSelection = useRef(false);
  const [openedSessions, setOpenedSessions] = useState<OpenedSession[]>(() => directory || cachedState ? readOpenedSessions(baseUrl) : []);
  const openedSessionsRef = useRef(openedSessions);
  openedSessionsRef.current = openedSessions;
  const forkStore = useMemo(() => new ForkStore(baseUrl), [baseUrl]);
  const [, setForkRevision] = useState(0);
  useEffect(() => forkStore.subscribe(() => setForkRevision((value) => value + 1)), [forkStore]);
  const [sideSessions, setSideSessions] = useState<OpenedSession[]>([]);
  const [sideActivity, setSideActivity] = useState<Record<string, ReturnType<typeof sessionActivity>>>({});
  const observeSideActivity = useCallback((agentId: string, activity: ReturnType<typeof sessionActivity>) => {
    setSideActivity(current => current[agentId] === activity ? current : { ...current, [agentId]: activity });
  }, []);
  const [sideSelections, setSideSelections] = useState<SideSelections>({});
  const [sideFocus, setSideFocus] = useState<string>();
  const sideRequests = useRef(new Map<string, number>());
  const forkReservation = useRef<{ key: string; record: SessionFork }>();
  const forkBusy = useRef(false);
  const [forkInputStatus, setForkInputStatus] = useState<{ agentId: string; pending: boolean; error?: string }>();
  const [sessionOptions, setSessionOptions] = useState<CreateSessionOptions>({});
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const creationReservation = useRef<{ operationId: string; options: CreateSessionOptions; providerId: string }>();
  const [creationLocked, setCreationLocked] = useState(false);
  const { value: catchUp, begin: beginCatchUp, focus: focusCatchUp } = useSessionCatchUp();
  useEffect(() => beginCatchUp(), [baseUrl, transport, beginCatchUp]);
  const replicas = useMemo(() => new ReplicaCache(), [baseUrl, transport]);
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
  const providerRequestGenerationRef = useRef(0);
  const workbenchTabRef = useRef<HTMLButtonElement>(null);
  const traceTabRef = useRef<HTMLButtonElement>(null);
  const sessionsTriggerRef = useRef<HTMLButtonElement>(null);
  const [contextFromSessions, setContextFromSessions] = useState(true);
  const [sessionPanel, setSessionPanel] = useState<'list' | 'favorites' | 'new' | 'settings'>('list');
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
  const [timelineDisplay, setTimelineDisplay] = useTimelineDisplayMode();
  const connectionSummaryRef = useRef<HTMLDetailsElement>(null);
  const workbenchPanelRef = useRef<HTMLElement>(null);
  const compactLayoutRef = useRef(isCompactLayout());
  const focusTimelineAfterAttachRef = useRef(false);
  const [providers, setProviders] = useState<readonly AgentProviderDescriptor[]>([]);
  const [localProviderId, setLocalProviderId] = useState('');
  const providerId = selectedHost.id === 'local' ? localProviderId : selectedHost.providerId ?? 'dsh';
  const [createPlanning, setCreatePlanning] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Readonly<Record<string, Readonly<Record<string, QuestionDraft>>>>>({});
  const [providerName, setProviderName] = useState(initialProviderName);
  const [catalogStatus, setCatalogStatus] = useState<ProviderCatalogStatus>(initialState ? 'ready' : 'loading');
  const [catalogError, setCatalogError] = useState<string>();
  const [state, setState] = useState<AgentReplicaState | undefined>(initialState ?? cachedState);
  const [status, setStatus] = useState<RemoteSessionStatus>(cachedState ? 'connecting' : initialSessionStatus);
  const [attachingAgentId, setAttachingAgentId] = useState<string>();
  const [transitioning, setTransitioning] = useState(false);
  const [sessionNotice, setSessionNotice] = useState<SessionConnectionMessage>();
  const [failure, setFailure] = useState<string | undefined>(requested.error);
  useFeedbackToast('Session operation', failure);
  useFeedbackToast('Session connection', sessionNotice?.message, sessionNotice?.tone === 'alert' ? 'error' : 'info');
  useFeedbackToast('Provider catalog', catalogError);
  const [activeView, setActiveView] = useState<'workbench' | 'trace'>('workbench');
  const [traceNavigation, setTraceNavigation] = useState<{ scope: string; key: string; requestId: number; view: 'workbench' | 'trace' }>();
  const traceRequestCounter = useRef(0);
  const [scanOpen, setScanOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(() => compactLayoutRef.current && !initialState && !cachedState);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const sidebar = useSidebarWidth(inspectorOpen);
  const [headerHidden, setHeaderHidden] = useState(true);
  const [desktopContextVisible, setDesktopContextVisible] = useState(true);
  const [compactLayout, setCompactLayout] = useState(compactLayoutRef.current);

  const { hosts: remoteHosts, error: hostError, retry: retryHosts } = useRemoteHosts(hostClient, accessReady && directory !== undefined, (compactLayout ? contextOpen : desktopContextVisible) || status !== 'ready' || creationLocked, selectedHost.id);
  const ask = useAskConversations(baseUrl, transport, directory, selectedHost.id, retryHosts);
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

  const providerChoices = [
    ...providers.map((provider) => ({ ...provider, hostId: 'local', selectionId: provider.providerId })),
    ...remoteHosts.flatMap((host) => (host.providers ?? [{ providerId: host.providerId ?? 'dsh', displayName: 'DeepSeek Harness' }]).map((provider) => ({
      ...provider, hostId: host.id,
      selectionId: JSON.stringify([host.id, provider.providerId]),
      displayName: `${provider.displayName} · ${host.name} · ${host.online ? 'Online' : 'Offline'}`,
    }))),
  ];
  const selectedProviderChoice = providerChoices.find((choice) => choice.hostId === selectedHost.id && choice.providerId === providerId);
  const selectedHostOffline = selectedHost.id !== 'local' && remoteHosts.find((host) => host.id === selectedHost.id)?.online !== true;
  const selectedQuota = remoteHosts.find((host) => host.id === selectedHost.id)?.sessionQuota;
  const creationQuotaExhausted = selectedQuota !== undefined && selectedQuota.used >= selectedQuota.limit && !creationReservation.current;
  const requestedHostUnavailable = requestedHostId && requestedHostId !== 'local' && !restoredHostSelection.current && !remoteHosts.some((host) => host.id === requestedHostId)
    ? 'Requested Host is unavailable or is not shared with you. Retry Hosts or select another Host.' : undefined;
  const creationUnavailableReason = requestedHostUnavailable ?? (selectedHostOffline ? 'This Host is offline. Reconnect it or select another Provider.'
    : creationQuotaExhausted ? 'Session creation limit reached. Existing sessions remain available. Ask the owner to raise your limit.' : undefined);

  function providerConnectionName(hostId: string, selectedProviderId: string): string {
    if (hostId === 'local') return providers.find((provider) => provider.providerId === selectedProviderId)?.displayName ?? selectedProviderId;
    const host = remoteHosts.find((candidate) => candidate.id === hostId);
    const descriptor = host?.providers?.find((provider) => provider.providerId === selectedProviderId);
    return descriptor && host ? `${descriptor.displayName} · ${host.name}` : selectedProviderId;
  }

  function selectHost(host: RemoteHost): void {
    if (creationLocked || transitionRef.current) return;
    restoredHostSelection.current = true;
    if (host.id === 'local') setSelectedHost(host);
    else {
      const advertised = host.providers ?? (host.providerId ? [{ providerId: host.providerId, displayName: host.providerId }] : []);
      const selectedProviderId = advertised.some((provider) => provider.providerId === host.providerId)
        ? host.providerId
        : advertised.some((provider) => provider.providerId === providerId) ? providerId : advertised[0]?.providerId;
      setSelectedHost({ ...host, ...(selectedProviderId ? { providerId: selectedProviderId } : {}) });
    }
    setSessionOptions({});
    setCreatePlanning(false);
  }

  function selectProvider(selectionId: string): void {
    if (creationLocked || transitionRef.current) return;
    const choice = providerChoices.find((item) => item.selectionId === selectionId);
    if (!choice) return;
    const host = remoteHosts.find((item) => item.id === choice.hostId);
    selectHost(host ? { ...host, providerId: choice.providerId } : { id: 'local', name: 'Recorded fixture', online: true });
    if (choice.hostId === 'local') setLocalProviderId(choice.providerId);
  }

  const attach = useCallback((agentId: string, catchUpTarget?: TimelineCursor): void => {
    if (!accessReadyRef.current) return;
    navigationGeneration.current += 1;
    setSessionNotice(undefined);
    setUncertainMutation(false);
    unsubscribeReplicaRef.current?.();
    unsubscribeReplicaRef.current = undefined;
    clientRef.current?.stop();
    if (compactLayoutRef.current) {
      focusTimelineAfterAttachRef.current = true;
      setContextOpen(false);
      setInspectorOpen(false);
      setActiveView('workbench');
    }
    setState(previous => replicas.get(agentId)?.getState().agent ? replicas.get(agentId)!.getState()
      : previous?.agent?.id === agentId ? previous : undefined);
    setStatus('connecting');
    setAttachingAgentId(agentId);
    const replica = replicaFor(agentId);
    beginCatchUp(replica, catchUpTarget);
    const saved = openedSessionsRef.current.find(item => item.agentId === agentId);
    const stopMessageRecovery = recoverMessages(replica, baseUrl, saved ? sessionKey(saved) : agentId, agentId);
    const client = new RemoteSessionClient(agentId, transport, replica, { historyPageSize: 100 });
    replicaRef.current = replica;
    clientRef.current = client;
    primaryBinding.current = { baseUrl, transport, agentId };
    const unsubscribe = replica.subscribe(() => {
      if (replicaRef.current !== replica) return;
      const next = replica.getState();
      setState(previous => next.timeline.initialized || !previous?.timeline.initialized ? next : previous);
    });
    unsubscribeReplicaRef.current = () => { unsubscribe(); stopMessageRecovery(); };
    client.subscribeStatus((next) => { if (clientRef.current === client) setStatus(next); });
    client.start();
    rememberAgent(agentId);
  }, [baseUrl, transport, replicas, replicaFor, beginCatchUp]);

  useEffect(() => {
    if (initialState || !activated) return;
    void loadProviders();
  }, [initialState, loadProviders, activated]);

  useEffect(() => () => {
    providerRequestGenerationRef.current += 1;
    navigationGeneration.current += 1;
    unsubscribeReplicaRef.current?.();
    unsubscribeReplicaRef.current = undefined;
    clientRef.current?.stop();
  }, []);

  useEffect(() => {
    if (initialState || !activated) return;
    if (requested.error) return;
    const remembered = rememberedAgent();
    const saved = openedSessionsRef.current.find(item => item.agentId === remembered);
    const location = requested.target?.hostId ? requested.target
      : directory && saved ? { ...saved, hostId: saved.hostId ?? 'local' } : undefined;
    if (!location?.hostId || !location.providerId || !location.nativeSessionId) {
      if (!requestedHostId && remembered) attach(remembered);
      return () => clientRef.current?.stop();
    }
    const { hostId, providerId: restoredProvider, nativeSessionId, parentNativeSessionId } = location;
    const generation = navigationGeneration.current;
    const target = new SessionDirectoryClient(baseUrl, undefined, hostId);
    setAttachingAgentId(location.agentId ?? nativeSessionId);
    setStatus('connecting');
    if (!cachedState) setSessionNotice({ tone: 'status', message: 'Opening the existing session. Waiting for the Host…' });
    const cancel = restoreSession({
      active: () => navigationGeneration.current === generation,
      open: signal => parentNativeSessionId
        ? target.attachChild(restoredProvider, parentNativeSessionId, nativeSessionId, signal)
        : target.attach(restoredProvider, nativeSessionId, signal),
      restored: result => {
        rememberSession({ hostId, providerId: restoredProvider, nativeSessionId,
          agentId: result.agentId, parentNativeSessionId,
          title: openedSessionsRef.current.find(session => session.hostId === hostId && session.providerId === restoredProvider && session.nativeSessionId === nativeSessionId)?.title ?? 'Session' });
        if (hostId === 'local') setLocalProviderId(restoredProvider);
        setProviderName(providerConnectionName(hostId, restoredProvider));
        setFailure(undefined); setSessionNotice(undefined);
        attach(result.agentId);
      },
      failed: (error, retrying) => {
        setFailure(undefined);
        setSessionNotice(sessionConnectionFailure(error, retrying));
        if (!retrying) { setAttachingAgentId(undefined); setStatus('idle'); if (compactLayoutRef.current) setContextOpen(true); }
      },
    });
    return () => { cancel(); clientRef.current?.stop(); };
  }, [attach, baseUrl, initialState, requestedHostId, activated]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 1180px)');
    const update = (event: MediaQueryListEvent) => {
      compactLayoutRef.current = event.matches;
      setCompactLayout(event.matches);
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
    if (!compactLayout) {
      setContextOpen(false);
      setInspectorOpen(false);
      return;
    }
    if (state?.agent || attachingAgentId) setContextOpen(false);
    else setContextOpen(true);
  }, [attachingAgentId, compactLayout, state?.agent?.id]);

  useEffect(() => {
    if (!compactLayout || contextOpen || inspectorOpen || !focusTimelineAfterAttachRef.current) return;
    focusTimelineAfterAttachRef.current = false;
    workbenchPanelRef.current?.focus();
  }, [activeView, compactLayout, contextOpen, inspectorOpen]);

  useEffect(() => {
    if (!directory) return;
    try { window.localStorage.setItem(openedSessionsKey(baseUrl), JSON.stringify(openedSessions)); } catch { /* Storage may be unavailable in private browser contexts. */ }
  }, [baseUrl, directory, openedSessions]);

  function rememberSession(value: OpenedSession): void {
    const item = openedSessionMetadata(value);
    const next = [item, ...openedSessionsRef.current.filter((entry) => !((entry.hostId ?? 'local') === (item.hostId ?? 'local') && entry.providerId === item.providerId && entry.nativeSessionId === item.nativeSessionId) && entry.agentId !== item.agentId)];
    openedSessionsRef.current = next;
    setOpenedSessions(next);
  }

  async function openSession(item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & { hostId?: string; parentAgentId?: string; parentNativeSessionId?: string }): Promise<boolean> {
    if (!directory || transitionRef.current) return false;
    const hostId = item.hostId ?? selectedHost.id;
    const key = sessionKey({ ...item, hostId });
    const visible = stackPath.find(entry => sessionKey(entry) === key);
    // Existing windows keep their connections; live tracking can also supply a confirmed binding.
    if (visible && (visible.agentId !== activeAgentId || status === 'ready')) {
      const observation = tracking.observations[key];
      beginCatchUp(replicaFor(visible.agentId), observation?.connection === 'ready' && observation.agentId === visible.agentId ? observation.cursor : undefined);
      setSideFocus(key);
      setFailure(undefined); setSessionNotice(undefined);
      setActiveView('workbench');
      if (compactLayoutRef.current) { setContextOpen(false); setInspectorOpen(false); }
      return true;
    }
    const generation = navigationGeneration.current;
    transitionRef.current = true;
    setTransitioning(true);
    setActiveView('workbench');
    setFailure(undefined);
    setSessionNotice({ tone: 'status', message: 'Opening the existing session. Waiting for the Host to confirm it is ready…' });
    try {
      const observation = tracking.observations[key];
      let agentId = observation?.connection === 'ready' ? observation.agentId : undefined;
      // Activity-only tracking already attached this session. Content transport still checks
      // access and recovers the binding after Host reconnects; persisted IDs are never trusted here.
      if (!agentId) {
        const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
        const result = item.parentNativeSessionId
          ? await target.attachChild(item.providerId, item.parentNativeSessionId, item.nativeSessionId)
          : await target.attach(item.providerId, item.nativeSessionId);
        agentId = result.agentId;
      }
      if (navigationGeneration.current !== generation) return false;
      if (currentSession?.agentId) rememberSession({ ...currentSession, agentId: currentSession.agentId });
      const prior = openedSessions.find((entry) => sessionKey(entry) === sessionKey({ ...item, hostId }));
      rememberSession({ ...prior, ...item, hostId, agentId });
      setProviderName(providerConnectionName(hostId, item.providerId));
      setSideFocus(undefined);
      attach(agentId, observation?.connection === 'ready' && observation.agentId === agentId ? observation.cursor : undefined);
      return true;
    } catch (error) {
      if (navigationGeneration.current === generation) setSessionNotice(sessionConnectionFailure(error, false));
      return false;
    }
    finally { transitionRef.current = false; setTransitioning(false); }
  }

  async function openChildSession(child: AgentChildSessionView): Promise<void> {
    const known = currentSession && sessionEntries.find(entry => entry.nativeSessionId === child.nativeSessionId
      && entry.providerId === currentSession.providerId && (entry.hostId ?? 'local') === (currentSession.hostId ?? 'local'));
    if (known && currentSession && sessionRootKey(known, sessionEntries) === sessionRootKey(currentSession, sessionEntries)) {
      if (!await openSession(known)) throw new Error('This subagent could not be opened.');
      return;
    }
    const parent = state?.agent;
    const parentNativeSessionId = parent?.runtimeInfo.sessionId;
    if (!directory || !parent || !parentNativeSessionId) throw new Error('The parent session is unavailable.');
    const generation = navigationGeneration.current;
    if (transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    setSessionNotice({ tone: 'status', message: 'Opening the existing child session. Waiting for the Host to confirm it is ready…' });
    try {
      const saved = openedSessions.find((item) => item.agentId === parent.id);
      const hostId = saved?.hostId ?? 'local';
      const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
      const result = await target.attachChild(parent.providerId, parentNativeSessionId, child.nativeSessionId);
      if (navigationGeneration.current !== generation) return;
      rememberSession(saved ?? { agentId: parent.id, providerId: parent.providerId, nativeSessionId: parentNativeSessionId, hostId, title: 'Parent conversation' });
      rememberSession({ agentId: result.agentId, providerId: parent.providerId, nativeSessionId: result.nativeSessionId,
        title: child.title, createdAt: child.createdAt, hostId, parentAgentId: parent.id, parentNativeSessionId });
      attach(result.agentId);
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
        const reservation = creationReservation.current ?? { operationId: crypto.randomUUID(), providerId, options: { ...sessionOptions, ...(createPlanning && providerId !== 'dsh' ? { planning: true } : {}) } };
        creationReservation.current = reservation;
        setCreationLocked(true);
        const response = await directory.create(reservation.providerId, reservation.operationId, reservation.options);
        rememberSession({ agentId: response.agentId, nativeSessionId: response.nativeSessionId ?? response.agentId, providerId: reservation.providerId, title: 'New session', hostId: selectedHost.id });
        attach(response.agentId);
        creationReservation.current = undefined;
        setCreationLocked(false);
        setDirectoryRevision((current) => current + 1);
      } else {
        const response = await transport.createAgent(agentId, providerId, { sessionId: agentId, ...(createPlanning ? { planning: true } : {}) });
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
        const hostId = session?.hostId ?? 'local';
        const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
        const response = await target.attach(persistence.providerId, persistence.sessionId);
        if (navigationGeneration.current !== generation) return;
        rememberSession({ ...session, agentId: response.agentId, providerId: persistence.providerId,
          nativeSessionId: response.nativeSessionId ?? persistence.sessionId, hostId, title: session?.title ?? 'Resumed session' });
        attach(response.agentId);
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

  const activeAgentId = state?.agent?.id ?? attachingAgentId;
  const connectionAgentId = state?.agent?.id ?? attachingAgentId ?? 'standby';
  const activeOpened = openedSessions.find((item) => item.agentId === activeAgentId);
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
  const observedSessionEntries = useSessionEntries(openedSessions, state);
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
    const childTitles = new Map(sessionEntries.filter((item) => item.parentNativeSessionId).map((item) => [sessionKey(item), item.title]));
    setOpenedSessions((current) => {
      const next = current.map((item) => {
        const title = childTitles.get(sessionKey(item));
        return title !== undefined && title !== item.title ? { ...item, title } : item;
      });
      return next.some((item, index) => item !== current[index]) ? next : current;
    });
  }, [sessionEntries]);
  const currentSession = sessionEntries.find((item) => item.agentId === activeAgentId);
  const activeRemoteSession = activeOpened?.hostId !== undefined && activeOpened.hostId !== 'local';
  const activeHost = remoteHosts.find((host) => host.id === activeOpened?.hostId);
  const selectedRemoteHost = selectedHost.id !== 'local' ? remoteHosts.find((host) => host.id === selectedHost.id) : undefined;
  const previewHost = activeHost ?? selectedRemoteHost;
  const hostOffline = activeHost?.online === false;
  const connectionProviderName = providerName ?? state?.agent?.providerId ?? 'No active Agent';
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

  const stackRoot = activeOpened ?? (state?.agent?.runtimeInfo.sessionId ? {
    agentId: state.agent.id, nativeSessionId: state.agent.runtimeInfo.sessionId,
    providerId: state.agent.providerId, hostId: 'local', title: 'Conversation',
  } : undefined);
  const stackPath = sidePath(stackRoot, sideSessions, sideSelections).map((session) => ({
    ...session, title: forkStore.find(session)?.firstInput?.trim().slice(0, 72) || session.title,
  }));
  const stackRange = expandedSideRange(stackPath, sideFocus, compactLayout ? 1 : 2);
  const expandedKeys = new Set(stackPath.slice(stackRange.start, stackRange.end + 1).map(sessionKey));
  const focusedWindow = stackPath[stackRange.end];
  const primaryExpanded = stackRange.start === 0;
  const addressSession = stackPath.find((session) => sessionKey(session) === sideFocus) ?? stackRoot;
  const askKey = addressSession ? sessionKey(addressSession) : undefined;
  const askEntry = addressSession ? ask.entryFor(addressSession) : undefined;
  const askVisible = ask.enabled && ask.openKey === askKey && !!askEntry && activeView === 'workbench' && !supportingRailOpen;
  const askSourceState = addressSession?.agentId === state?.agent?.id ? state : addressSession ? replicas.get(addressSession.agentId)?.getState() : undefined;
  function openAsk(clean = false) {
    if (addressSession && askSourceState) void ask.open(askSourceState, addressSession, '', clean).catch(() => {});
  }
  useEffect(() => focusCatchUp(addressSession ? replicas.get(addressSession.agentId) : undefined), [addressSession?.agentId, replicas, focusCatchUp]);
  const primaryIsBound = initialState?.agent?.id === stackRoot?.agentId || (primaryBinding.current?.baseUrl === baseUrl
    && primaryBinding.current.transport === transport && primaryBinding.current.agentId === stackRoot?.agentId);
  const openWindows = useMemo(() => [...(stackRoot && primaryIsBound ? [stackRoot] : []), ...sideSessions], [stackRoot, primaryIsBound, sideSessions]);
  useEffect(() => {
    replicas.retain([
      ...(primaryBinding.current?.agentId ? [primaryBinding.current.agentId] : []),
      ...sideSessions.map(session => session.agentId),
      ...(askVisible && askEntry?.record?.target ? [askEntry.record.target.agentId] : []),
      ...(addressSession ? [addressSession.agentId] : []),
    ]);
  });
  const askActivitySessions = useMemo(() => ask.enabled && askEntry?.record?.target ? [{ session: askEntry.record.target, visible: askVisible,
    liveAgentId: askEntry.attached ? askEntry.record.target.agentId : undefined }] : [], [ask.enabled, askEntry?.record?.target, askEntry?.attached, askVisible]);
  const tracking = useSessionTracking(baseUrl, transport, addressSession ? sessionKey(addressSession) : undefined, openWindows, askActivitySessions);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = transport.onSessionTitle?.(session => {
      const update = (items: OpenedSession[]) => {
        if (!items.some(item => sessionKey(item) === sessionKey(session) && item.title !== session.title)) return items;
        return items.map(item => sessionKey(item) === sessionKey(session) ? { ...item, title: session.title } : item);
      };
      setOpenedSessions(update); setSideSessions(update); tracking.rename(session);
      clearTimeout(timer); timer = setTimeout(() => setDirectoryRevision(value => value + 1), 100);
    });
    return () => { remove?.(); clearTimeout(timer); };
  }, [transport, tracking.rename]);
  const displayChanged = useRef<() => void>(() => undefined);
  useEffect(() => displayChanged.current(), [state, addressSession, accessReady, status]);
  const latestDisplay = useRef<{ target?: OpenedSession; state?: AgentReplicaState; allowed: boolean }>({ allowed: false });
  latestDisplay.current = { target: addressSession, state, allowed: accessReady && status === 'ready' && !!state?.timeline.epoch };
  useEffect(() => {
    let dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const generation = recoveryGeneration(baseUrl);
    const save = () => {
      const current = latestDisplay.current;
      clearTimeout(timer); timer = undefined;
      if (generation === recoveryGeneration(baseUrl) && dirty && current.allowed && current.target && current.state) {
        dirty = false; saveWorkspaceSnapshot(baseUrl, current.target, current.state);
      }
    };
    const onHide = () => { if (document.visibilityState === 'hidden') save(); };
    // Coalesce streamed updates without writing on every token or delaying pagehide.
    const mark = () => { dirty = true; timer ??= setTimeout(save, 2000); };
    displayChanged.current = mark; mark();
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', onHide);
    return () => { save(); clearTimeout(timer); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', onHide); };
  }, [baseUrl]);
  const promptEditBusy = useRef(false);
  const [promptEditPending, setPromptEditPending] = useState(false);
  const promptEditReservation = useMemo<{ current: PromptEditReservation | undefined }>(() => ({ current: readPromptEditReservation(baseUrl) }), [baseUrl]);
  const promptMigrations = useSessionMigrations({ baseUrl, enabled: userScoped && accessReady, transport, current: activeOpened, loaded: openWindows,
    blocked: () => promptEditBusy.current || transitionRef.current || activeView !== 'workbench' || supportingRailOpen,
    needsPromptRestore: migration => !promptEditBusy.current && promptEditReservation.current?.operationId === migration.id && !promptEditReservation.current.restored,
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
      const target = { ...session, agentId: result.agentId };
      const fork = forkStore.find(source);
      if (fork) forkStore.bind(fork.id, target);
      rememberSession(target);
      setSideSessions(values => values.map(item => sessionKey(item) === sessionKey(source) ? target : item));
      setSideSelections(values => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === sessionKey(source) ? sessionKey(target) : value])));
      setSideFocus(value => value === sessionKey(source) ? sessionKey(target) : value);
      return true;
    },
  });
  async function editPrompt(entry: import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry): Promise<void> {
    const source = activeOpened; const item = entry.item; const sourceClient = clientRef.current;
    if (!source || !sourceClient || !directory || source.providerId !== 'codex' || item.type !== 'user_message' || !item.messageId || !entry.turnId) throw new Error('This prompt cannot be edited.');
    if (promptEditBusy.current) throw new Error('A prompt edit is already being prepared.');
    promptEditBusy.current = true; setPromptEditPending(true);
    const assertActiveAccount = () => { if (mountedTransport.current !== transport) throw new Error('The account connection changed. Reopen the source conversation before editing.'); };
    try {
      const draft = await preparePromptDraft(item, { scopeKey: JSON.stringify([source.agentId, state?.timeline.epoch]), bindings: entry.resources, resources: state?.resources ?? {},
        resolveResource: sourceClient.resolveResource.bind(sourceClient), requestResource: async binding => (await sourceClient.requestResource(binding.resourceId)).payload.state });
      assertActiveAccount();
      const key = JSON.stringify([sessionKey(source), entry.turnId, item.messageId]);
      let reservation = promptEditReservation.current?.key === key ? promptEditReservation.current : undefined;
      if (!reservation) {
        const storageKey = 'arc:prompt-edit-intent:' + baseUrl + ':' + key;
        let operationId = crypto.randomUUID() as string;
        try { const saved = sessionStorage.getItem(storageKey); if (saved && /^[a-f0-9-]{36}$/i.test(saved)) operationId = saved; else sessionStorage.setItem(storageKey, operationId); } catch { /* Preserve the same intent in memory when storage is unavailable. */ }
        reservation = { key, operationId }; promptEditReservation.current = reservation;
      }
      retainPromptEditReservation(baseUrl, reservation);
      if (!reservation.target) {
        const targetDirectory = new SessionDirectoryClient(baseUrl, undefined, source.hostId);
        const result = await targetDirectory.create(source.providerId, reservation.operationId, { editNativeSessionId: source.nativeSessionId, editTurnId: entry.turnId, editMessageId: item.messageId });
        assertActiveAccount();
        if (!result.nativeSessionId || result.nativeSessionId === source.nativeSessionId) throw new Error('The native prompt-edit branch could not be confirmed.');
        reservation.target = { ...source, agentId: result.agentId, nativeSessionId: result.nativeSessionId, parentAgentId: undefined, parentNativeSessionId: undefined };
      }
      if (!reservation.restored) {
        const text = await savePromptDraft(baseUrl, sessionKey(reservation.target), draft);
        assertActiveAccount();
        messageDrafts.set(reservation.target.agentId, text); reservation.restored = true;
        finishPromptEditReservation(baseUrl, reservation.operationId);
      }
      rememberSession(reservation.target); setDirectoryRevision(value => value + 1);
      promptMigrations.requestFollow(reservation.operationId);
    } finally { promptEditBusy.current = false; setPromptEditPending(false); }
  }

  const conversationHistory = useConversationHistory(addressSession, sessionEntries, openSession);
  useEffect(() => {
    if (addressSession && state?.agent && !initialState) saveLastSession(baseUrl, { ...addressSession, hostId: addressSession.hostId ?? 'local' });
  }, [baseUrl, addressSession?.agentId, addressSession?.hostId, addressSession?.providerId, addressSession?.nativeSessionId, addressSession?.parentNativeSessionId, state?.agent?.id, initialState]);

  const traceScope = JSON.stringify([state?.agent?.id, state?.timeline.epoch]);
  const traceRequest = traceNavigation?.scope === traceScope ? traceNavigation : undefined;
  useEffect(() => {
    setTraceNavigation(previous => previous?.scope === traceScope ? previous : undefined);
  }, [traceScope]);
  function inspectTimelineEntry(key: string, view: 'workbench' | 'trace') {
    if (view === 'workbench' && timelineDisplay === 'content' && state) {
      const item = createTimelineRenderModel(state.timeline.epoch, state.timeline.entries).find(entry => entry.key === key)?.entry.item;
      if (item && !isContentOnlyItem(item)) setTimelineDisplay('simple');
    }
    setTraceNavigation({ scope: traceScope, key, view, requestId: ++traceRequestCounter.current });
    if (view === 'workbench') setSideFocus(stackRoot ? sessionKey(stackRoot) : undefined);
    setActiveView(view);
  }

  function resolveSessionLink(nativeSessionId: string) {
    if (!currentSession || !directory || hostOffline || transitioning) return undefined;
    const target = sessionEntries.find(item => item.nativeSessionId === nativeSessionId && item.providerId === currentSession.providerId && (item.hostId ?? 'local') === (currentSession.hostId ?? 'local'));
    if (!target || sessionRootKey(target, sessionEntries) !== sessionRootKey(currentSession, sessionEntries)) return undefined;
    return { title: target.title, href: controllerPath({ ...target, hostId: target.hostId ?? 'local' }), open: async () => {
      if (!await openSession(target)) throw new Error('This session could not be opened.');
    } };
  }

  function nextSideRequest(source: OpenedSession): number {
    const key = sessionKey(source);
    const request = (sideRequests.current.get(key) ?? 0) + 1;
    sideRequests.current.set(key, request);
    return request;
  }
  function selectSide(source: OpenedSession, session: OpenedSession): void {
    nextSideRequest(source);
    setSideSessions((current) => [...current.filter((entry) => sessionKey(entry) !== sessionKey(session)), session]);
    setSideSelections((current) => ({ ...current, [sessionKey(source)]: sessionKey(session) }));
    setSideFocus(sessionKey(session));
  }
  function revealSession(session: OpenedSession): void {
    if (stackPath.some((entry) => sessionKey(entry) === sessionKey(session))) setSideFocus(sessionKey(session));
    else void openSession(session);
  }
  function closeSide(session: OpenedSession): void {
    const record = forkStore.find(session);
    if (!record) return;
    nextSideRequest(record.source);
    setSideSelections((current) => ({ ...current, [sessionKey(record.source)]: null }));
    setSideFocus(sessionKey(record.source));
  }
  useEffect(() => {
    if (stackRange.end === 0 && sideFocus && activeView === 'workbench') {
      if (workbenchPanelRef.current?.querySelector('[data-inspected="true"]:focus')) return;
      workbenchPanelRef.current?.querySelector<HTMLTextAreaElement>('.lab-primary-conversation textarea')?.focus({ preventScroll: true });
    }
  }, [sideFocus, stackRange.end, activeView]);

  async function openFork(record: SessionFork): Promise<void> {
    if (!record.target || !directory) return;
    const saved = record.target;
    const request = nextSideRequest(record.source);
    const target = (saved.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, saved.hostId);
    try {
      const result = await target.attach(saved.providerId, saved.nativeSessionId);
      const session = { ...saved, agentId: result.agentId };
      forkStore.bind(record.id, session);
      await configureFork(transport, forkStore, forkStore.get(record.id));
      rememberSession(session);
      if (sideRequests.current.get(sessionKey(record.source)) === request && session.agentId !== activeAgentId) selectSide(record.source, session);
    } catch (error) {
      if (sideRequests.current.get(sessionKey(record.source)) === request) setFailure(message(error, 'Forked session could not be opened.'));
    }
  }

  async function createFork(sourceState: AgentReplicaState, saved: OpenedSession | undefined, id: string, args: string): Promise<AgentCommandResult> {
    if (id === 'console:ask' && !args.trim()) { ask.toggle(); return {}; }
    const agent = sourceState.agent;
    if (!directory || !agent?.runtimeInfo.sessionId) throw new Error('This session cannot be forked.');
    if (id === 'console:ask') return ask.open(sourceState, saved ?? { agentId: agent.id, nativeSessionId: agent.runtimeInfo.sessionId, providerId: agent.providerId, title: 'Conversation', hostId: 'local' }, args);
    if (forkBusy.current) throw new Error('A session fork is already being created.');
    forkBusy.current = true;
    try {
      const source: OpenedSession = saved ?? { agentId: agent.id, nativeSessionId: agent.runtimeInfo.sessionId, providerId: agent.providerId, title: 'Conversation', hostId: 'local' };
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
        if (context.mode === 'reference') options.sourceNativeSessionId = source.nativeSessionId;
        record = forkStore.prepare(context, options, settings, key);
        forkReservation.current = { key, record };
      }
      let result: { agentId: string; nativeSessionId?: string };
      if (record.target) result = await target.attach(record.target.providerId, record.target.nativeSessionId);
      else {
        try { result = await target.create(source.providerId, record.id, record.options); }
        finally { if (source.hostId && source.hostId !== 'local') retryHosts(); }
      }
      const session: OpenedSession = { agentId: result.agentId, nativeSessionId: result.nativeSessionId ?? result.agentId, providerId: source.providerId,
        hostId: source.hostId ?? 'local', title: `Fork of ${source.title}`, createdAt: record.capturedAt };
      forkStore.bind(record.id, session);
      await configureFork(transport, forkStore, forkStore.get(record.id));
      rememberSession(source); rememberSession(session);
      setDirectoryRevision((value) => value + 1);
      if (args.trim()) messageDrafts.set(session.agentId, args.trim());
      if (id === 'console:side') selectSide(source, session);
      if (args.trim() && forkStore.get(record.id).delivery !== 'sent') {
        setForkInputStatus({ agentId: session.agentId, pending: true });
        try { await sendForkInput(transport, forkStore, forkStore.get(record.id), args.trim()); }
        catch (error) { setForkInputStatus({ agentId: session.agentId, pending: false, error: message(error, 'The first fork input failed.') }); throw error; }
        setForkInputStatus(undefined);
        if (messageDrafts.get(session.agentId) === args.trim()) messageDrafts.set(session.agentId, '');
      }
      forkStore.finishCreation(record.id);
      forkReservation.current = undefined;
      return {};
    } finally { forkBusy.current = false; }
  }

  const submittedClient = clientRef.current;
  function commandClient(): RemoteSessionClient {
    if (!accessReadyRef.current) throw new Error('Workspace access is restoring.');
    if (!submittedClient || clientRef.current !== submittedClient) throw new RemoteOperationError('session_changed', 'The conversation changed before this action could be sent. Return to its original session to retry.', true);
    return submittedClient;
  }

  const clientActions: AppActions = actions ?? {
    ...(userScoped && activeOpened && activeOpened.providerId === 'codex' && !activeOpened.parentNativeSessionId && !boundFork && !promptEditPending ? { editPrompt } : {}),
    loadOlder: clientRef.current?.loadOlder.bind(clientRef.current),
    sendMessage: async (text, options) => { await commandClient().sendMessage(text, options); },
    sendMessageContent: async (content, options) => { await commandClient().sendMessageContent(content, options); },
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
    return openSession({ ...target, title: known?.title || target.nativeSessionId });
  }

  const conversationActions = forkActions(clientActions, forkStore, boundFork, transport);
  // Retain message handlers so the composer can wait for readiness before sending.
  const availableConversationActions = accessReady && !hostOffline && status === 'ready' ? conversationActions : {
    sendMessage: conversationActions.sendMessage,
    sendMessageContent: conversationActions.sendMessageContent,
    deleteMessage: conversationActions.deleteMessage,
  };

  return <VscodeTunnelScope service={vscodeTunnelClient} host={previewHost} polling={compactLayout ? contextOpen : desktopContextVisible}><PreviewScope client={previewClient} host={previewHost} polling={compactLayout ? contextOpen : desktopContextVisible}><TimelineDisplay.Provider value={timelineDisplay}><RecoveryScope.Provider value={readingPositions}><main ref={shellRef} style={sidebar.style} className={`lab-shell${headerHidden ? ' lab-header-hidden' : ''}${!compactLayout && !desktopContextVisible ? ' lab-context-hidden' : ''}${state?.agent ? ' lab-has-agent' : ''}${supportingRailOpen ? ' lab-supporting-open' : ''}${inspectorOpen ? ' lab-inspector-open' : ''}`}>
    {scanOpen ? <SessionTransferDialog onOpen={openScannedSession} onClose={() => setScanOpen(false)} /> : null}
    {accessReady ? tracking.observers : null}
    {ask.enabled && addressSession && directory && activeView === 'workbench' && !supportingRailOpen ? <><AskButton positionRef={askPositionRef} triggerRef={askTriggerRef} hidden={askVisible} disabled={!askSourceState?.agent || hostOffline || transitioning}
      observation={askEntry?.record?.target ? tracking.observations[sessionKey(askEntry.record.target)] : undefined} onOpen={() => openAsk()} />
      {askVisible ? <AskConversation positionRef={askPositionRef} triggerRef={askTriggerRef} simple={askSimple} onToggleSimple={() => setAskSimple(value => !value)}
      entry={askEntry!} store={ask.store} transport={transport} replica={askEntry?.record?.target ? replicaFor(askEntry.record.target.agentId) : undefined}
      onSendInput={(id, send) => ask.sendInput(askKey!, id, send)} draftBinding={{ store: ask.drafts, key: askKey! }} onClose={ask.close} onToggleEnabled={ask.toggle} onClean={() => openAsk(true)} onRetry={() => openAsk()} />
      : null}</> : null}
    {userScoped ? <SessionTrackingMenu catchUp={catchUp} tracking={tracking} busy={transitioning} inert={supportingRailOpen} onOpen={item => void openSession(item)} /> : null}
    {compactLayout ? <nav className="lab-mobile-navigation" aria-label="Session navigation" {...backgroundInert}>
      <button ref={sessionsTriggerRef} type="button" aria-label="Open sessions" aria-haspopup="dialog" aria-expanded={contextOpen} aria-controls="lab-context" onClick={() => { openContext(true); }}>Sessions</button>
      {userScoped ? <FavoritesMenu onScan={directory ? () => setScanOpen(true) : undefined} status={addressSession?.agentId === state?.agent?.id ? sessionActivity(state) : sessionEntries.find(entry => addressSession && sessionKey(entry) === sessionKey(addressSession))?.status} currentSession={addressSession} title={addressSession?.title || activeOpened?.title || 'Agent Remote'} favorites={favorites} tracking={tracking} activeKey={addressSession ? sessionKey(addressSession) : undefined} busy={transitioning} onOpen={item => void openSession(item)} /> : stackPath.length > 1 ? <select className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === focusedWindow?.agentId)?.status} aria-label="Side path" value={focusedWindow ? sessionKey(focusedWindow) : ''} onChange={(event) => { const session = stackPath.find((entry) => sessionKey(entry) === event.target.value); if (session) revealSession(session); }}>
        {stackPath.map((session, index) => <option className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === session.agentId)?.status} key={sessionKey(session)} value={sessionKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
      </select> : <span className="lab-mobile-session-title agent-session-title" data-session-status={sessionActivity(state)}>{activeOpened?.title || 'Agent Remote'}</span>}
      {userScoped && stackPath.length > 1 ? <select className="lab-mobile-side-path" aria-label="Side path" value={focusedWindow ? sessionKey(focusedWindow) : ''} onChange={event => { const session = stackPath.find(entry => sessionKey(entry) === event.target.value); if (session) revealSession(session); }}>
        {stackPath.map((session, index) => <option key={sessionKey(session)} value={sessionKey(session)}>{index === 0 ? 'Root' : `Side ${index}`} · {session.title}</option>)}
      </select> : null}
    </nav> : null}
    <ViewOptions triggerRef={viewTriggerRef} headerVisible={!headerHidden} sidebarVisible={contextVisible}
      inspectorVisible={inspectorOpen} compact={compactLayout} inert={supportingRailOpen}
      contentOnly={timelineDisplay === 'content'} onToggleContentOnly={() => setTimelineDisplay(value => value === 'content' ? 'preview' : 'content')}
      simpleConversation={timelineDisplay === 'simple'} onToggleSimpleConversation={() => setTimelineDisplay(value => value === 'simple' ? 'preview' : 'simple')}
      onSetAllVisible={setAllPanelsVisible} onToggleHeader={() => setHeaderHidden((value) => !value)} onToggleSidebar={toggleContext}
      onToggleInspector={() => inspectorOpen ? setInspectorOpen(false) : openInspector()} />
    <header className="lab-app-bar" hidden={headerHidden}>
      <div className="lab-brand">
        <div>
          <p>Agent Remote Control</p>
          <h1>Agent conversations</h1>
        </div>
      </div>
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
        <p className="lab-eyebrow" title={baseUrl}>Workspace</p>
      </div>
      {!compactLayout ? <nav className="lab-sidebar-tabs" aria-label="Sidebar sections">
        <button type="button" aria-pressed={sessionPanel === 'list'} onClick={() => setSessionPanel('list')}>Sessions</button>
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'favorites'} onClick={() => { setSessionPanel('favorites'); void favorites.refresh(); }}>Favorites</button> : null}
        <button type="button" className="lab-sidebar-new" aria-pressed={sessionPanel === 'new'} onClick={() => setSessionPanel('new')}><span aria-hidden="true">＋</span> New session</button>
        <button type="button" aria-label="Sidebar settings" title="Settings" aria-pressed={sessionPanel === 'settings'} onClick={() => setSessionPanel('settings')}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none" /></svg>
        </button>
      </nav> : null}
      {compactLayout && accountAction ? <div className="lab-sidebar-account">{accountAction}</div> : null}
      {compactLayout ? <nav className="lab-session-panel-actions" aria-label="Sidebar sections">
        <button type="button" aria-pressed={sessionPanel === 'list'} onClick={() => setSessionPanel('list')}>Sessions</button>
        {userScoped ? <button type="button" aria-pressed={sessionPanel === 'favorites'} onClick={() => { setSessionPanel('favorites'); void favorites.refresh(); }}>Favorites</button> : null}
        <button type="button" aria-pressed={sessionPanel === 'settings'} onClick={() => setSessionPanel('settings')}>Settings</button>
      </nav> : null}
      <div className="lab-sidebar-content">
      {!compactLayout && accountAction ? <div className="lab-sidebar-account">{accountAction}</div> : null}
      {sessionPanel === 'settings' ? <section className="lab-mobile-settings" aria-label="Controller settings">
        <MobileDisplaySettings />
        <p>Message drafts and reading positions are saved in this browser tab. Use Sessions to switch conversations.</p>
      </section> : null}
      {userScoped && sessionPanel === 'favorites' ? <section className="lab-session-directory lab-favorites-section" aria-label="Favorites"><div className="lab-directory-heading"><h2>Favorites</h2></div><FavoritesList favorites={favorites} tracking={tracking} activeKey={addressSession ? sessionKey(addressSession) : undefined} busy={transitioning} onOpen={item => void openSession(item)} /></section> : null}
      {directory && sessionPanel !== 'favorites' ? <HostPairing compact={compactLayout && sessionPanel === 'list'} managementVisible={sessionPanel === 'settings'} service={hostClient} selectedHostId={selectedHost.id} selectionLocked={creationLocked || transitioning} hosts={remoteHosts} hostError={hostError ?? requestedHostUnavailable} onRetryHosts={retryHosts} onSelect={selectHost} /> : null}
      {(!compactLayout && sessionPanel === 'list') || sessionPanel === 'settings' ? selectedRemoteHost?.id === previewHost?.id ? <HostVscodeTunnel />
        : <VscodeTunnelScope service={vscodeTunnelClient} host={selectedRemoteHost} polling={compactLayout ? contextOpen : desktopContextVisible}>
          <HostVscodeTunnel />
        </VscodeTunnelScope> : null}
      {directory && userScoped ? <div hidden={sessionPanel !== 'settings'}><ControllerUpdates service={hostClient} hosts={remoteHosts} /></div> : null}
      {!compactLayout ? <>
      {sessionPanel === 'list' ? <HostPreviewGroups client={previewClient} hosts={remoteHosts} activeHostId={previewHost?.access !== 'shared' ? previewHost?.id : undefined} polling={compactLayout ? contextOpen : desktopContextVisible} onOpen={() => { if (compactLayout) { setContextOpen(false); setInspectorOpen(false); } }} onOpenSource={(sessionId, itemId, hostId) => void openPreviewSource(sessionId, itemId, hostId)} /> : null}
      </> : null}
      <div className="lab-directory-panel" hidden={sessionPanel !== 'list'}>
      {providerChoices.length > 1 ? <label className="lab-browse-provider">Browse provider<select aria-label="Browse provider" value={selectedProviderChoice?.selectionId ?? ''} disabled={creationLocked || transitioning} onChange={(event) => selectProvider(event.target.value)}>{providerChoices.map((provider) => <option key={provider.selectionId} value={provider.selectionId}>{provider.displayName}</option>)}</select></label> : null}
      {directory ? <SessionDirectory quickOpen={<button type="button" className="lab-session-scan-trigger" aria-label="Scan session QR code" onClick={() => setScanOpen(true)}>Scan</button>} favorites={favorites} searchable directory={directory} providerId={providerId} activeAgentId={addressSession?.agentId ?? activeAgentId} opened={openedSessions} known={sessionEntries} hostId={selectedHost.id} onOpenRelated={(item) => void openSession(item)} busy={transitioning || (remoteHosts.find((host) => host.id === selectedHost.id)?.online === false)} revision={directoryRevision} onOpen={(item) => void openSession(item)} onSelect={(item) => void openSession(item)} onClose={(agentId) => setOpenedSessions((current) => current.filter((item) => item.agentId !== agentId))} /> : null}
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
      {sessionNotice && compactLayout && contextOpen ? <SessionConnectionNotice notice={sessionNotice} /> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
      </div>
      {compactLayout && sessionPanel !== 'new' ? <footer className="lab-session-panel-footer"><button type="button" onClick={() => setSessionPanel('new')}><span aria-hidden="true">＋</span> New session</button></footer> : null}
    </SupportingRail>
    {!compactLayout && contextVisible ? <SidebarResize width={sidebar.width} maximum={sidebar.maximum} onChange={sidebar.setWidth} /> : null}
    <PreviewWorkspace resourceScope={JSON.stringify([activeOpened?.hostId, activeAgentId, state?.timeline.epoch])} className="lab-main-stage" {...backgroundInert}>
      <section
        ref={workbenchPanelRef}
        className={(sessionNotice && !(compactLayout && contextOpen)) || promptMigrations.notice ? 'lab-workbench-with-notice' : undefined}
        id="lab-workbench"
        data-testid="workbench"
        role="tabpanel"
        aria-labelledby="lab-workbench-tab"
        tabIndex={-1}
        hidden={activeView !== 'workbench'}
      >
        {sessionNotice && !(compactLayout && contextOpen) ? <SessionConnectionNotice notice={sessionNotice} /> : null}
        {promptMigrations.notice}
        {uncertainMutation ? <p className="lab-control-note" role="alert">The previous action may have completed before the connection was interrupted. Its result is unknown. It will not be replayed automatically.</p> : null}
        <div className={`lab-conversation-split${stackPath.length > 1 ? ' lab-has-side' : ''}`}>
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(0, stackRange.start)} offset={0} onExpand={revealSession} />
        <div className="lab-primary-conversation" hidden={!primaryExpanded} onFocusCapture={() => { if (stackRoot && sideFocus && sideFocus !== sessionKey(stackRoot)) setSideFocus(sessionKey(stackRoot)); }}>
        <LabWorkbench
          draftSessionKey={stackRoot ? sessionKey(stackRoot) : activeAgentId}
          onInspectEntry={key => inspectTimelineEntry(key, 'trace')}
          revealEntry={traceRequest?.view === 'workbench' ? traceRequest : undefined}
          state={forkDisplayState(state, boundFork)} sessionStatus={!accessReady ? 'connecting' : hostOffline ? 'disconnected' : status} attachingAgentId={attachingAgentId} actions={forkInputStatus?.pending && forkInputStatus.agentId === activeAgentId ? { deleteMessage: conversationActions.deleteMessage } : availableConversationActions} visible={activeView === 'workbench' && primaryExpanded}
          consoleCommands={status === 'ready' && !hostOffline && directory && state?.agent?.capabilities.sendMessage && state.agent.capabilities.history ? forkCommands : []}
          onExecuteConsoleCommand={(id, args) => state && status === 'ready' && !hostOffline ? createFork(state, activeOpened, id, args) : Promise.reject(new Error('Wait for this session to finish synchronizing.'))}
          composerContext={boundFork ? <ForkReference fork={boundFork} onOpen={revealSession} /> : undefined}
          composerNotice={<ForkEntries forks={forkStore.all().filter((fork) => fork.target && (fork.source.agentId === activeAgentId || (activeOpened && sessionKey(fork.source) === sessionKey(activeOpened))))} selectedChild={stackRoot ? sideSelections[sessionKey(stackRoot)] : undefined} onOpen={(fork) => void openFork(fork)} />}
          sessionManager={<>{!compactLayout && addressSession ? <StarButton session={addressSession} favorites={favorites} /> : null}<nav className="lab-conversation-history" aria-label="Conversation history">
            <button type="button" aria-label="Back to previous conversation" title="Back" disabled={transitioning || hostOffline || !conversationHistory.canBack} onClick={conversationHistory.back}>←</button>
            <button type="button" aria-label="Forward to next conversation" title="Forward" disabled={transitioning || hostOffline || !conversationHistory.canForward} onClick={conversationHistory.forward}>→</button>
          </nav>{directory && currentSession ? <ChatSessionManager current={currentSession} entries={sessionEntries} busy={transitioning || hostOffline} onOpen={(item) => void openSession(item)} /> : null}{addressSession ? <SessionLink session={addressSession} /> : null}</>}
          conversationPath={ancestors.length > 0 ? <nav className="lab-conversation-path" aria-label="Conversation path">
            {ancestors.map((ancestor) => <span key={ancestor.agentId}>
              <button type="button" className="agent-session-title" data-session-status={sessionEntries.find(entry => entry.agentId === ancestor.agentId)?.status} disabled={transitioning} onClick={() => { void openSession(ancestor); }}>{ancestor.title}</button>
              <span aria-hidden="true"> / </span>
            </span>)}
            <span className="agent-session-title" data-session-status={sessionActivity(state)} aria-current="page">{activeOpened?.title}</span>
          </nav> : null}
          resolveSessionLink={resolveSessionLink}
          childrenFor={currentSession ? nativeSessionId => sessionChildren({ ...currentSession, nativeSessionId }, sessionEntries) : undefined}
          onOpenChildSession={directory && !hostOffline && !transitioning ? openChildSession : undefined}
          draftBinding={activeAgentId ? { store: messageDrafts, key: activeAgentId } : undefined}
          questionDrafts={activeAgentId ? questionDrafts[activeAgentId] ?? {} : undefined}
          onQuestionDraftChange={activeAgentId ? (requestId, draft) => setQuestionDrafts((current) => ({
            ...current, [activeAgentId]: { ...current[activeAgentId], [requestId]: draft },
          })) : undefined}
        />
        </div>
        {sideSessions.filter((session) => !stackRoot || sessionKey(session) !== sessionKey(stackRoot)).map((session) => <SideConversation
          key={sessionKey(session)} session={session} replica={replicaFor(session.agentId)} transport={transport} store={forkStore} onActivityChange={observeSideActivity}
          position={stackPath.findIndex((entry) => sessionKey(entry) === sessionKey(session))}
          expanded={expandedKeys.has(sessionKey(session))}
          focused={focusedWindow !== undefined && sessionKey(focusedWindow) === sessionKey(session)}
          selectedChild={sideSelections[sessionKey(session)]}
          initialInput={forkInputStatus?.agentId === session.agentId ? forkInputStatus : undefined}
          visible={activeView === 'workbench'} draftBinding={{ store: messageDrafts, key: session.agentId }}
          onFocus={() => { if (sideFocus !== sessionKey(session)) setSideFocus(sessionKey(session)); }} onClose={() => closeSide(session)} onOpenSource={revealSession} onOpenFork={(fork) => void openFork(fork)} onFork={createFork} />)}
        <CollapsedConversations entries={sessionEntries} sessions={stackPath.slice(stackRange.end + 1)} offset={stackRange.end + 1} onExpand={revealSession} />
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
          sessionTitle={activeOpened?.title} sessionStatus={!accessReady ? 'connecting' : hostOffline ? 'disconnected' : status}
          revealEntry={traceRequest?.view === 'trace' ? traceRequest : undefined}
          onShowConversation={key => inspectTimelineEntry(key, 'workbench')}
          resolveSessionLink={resolveSessionLink} onLoadOlder={!hostOffline ? conversationActions.loadOlder : undefined} />
      </section>
    </PreviewWorkspace>
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
  </main></RecoveryScope.Provider></TimelineDisplay.Provider></PreviewScope></VscodeTunnelScope>;
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
    const value: unknown = JSON.parse(window.localStorage.getItem(openedSessionsKey(baseUrl)) ?? '[]');
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
