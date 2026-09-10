import type { AgentChildSession, AgentCommand, AgentCommandResult, AgentMessageOptions } from '@borgee/agent-remote-protocol';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type {
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentProviderDescriptor,
  AgentSessionConfig,
  AgentSessionResponse,
  ResourceBinding,
} from '@borgee/agent-remote-protocol';
import {
  AgentReplica,
  RemoteOperationError,
  HttpWebSocketTransport,
  RemoteSessionClient,
  type AgentReplicaState,
  type RemoteAgentTransport,
  type RemoteSessionStatus,
} from '@borgee/agent-remote-web';
import { useRemoteHosts } from './hooks/useRemoteHosts.js';
import { HostPairing, type HostPairingService, type RemoteHost } from './components/HostPairing.js';
import { DirectoryError, RemoteHostClient, SessionDirectoryClient, type CreateSessionOptions, type OpenedSession, type SessionSummary } from './directory-client.js';
import { SessionConfiguration, SessionDirectory } from './components/SessionDirectory.js';
import { useSessionEntries } from './hooks/useSessionEntries.js';
import { sessionKey } from './session-tree.js';
import { ViewOptions } from './components/ViewOptions.js';
import { ChatSessionManager } from './components/ChatSessionManager.js';
import { LabWorkbench } from './components/LabWorkbench.js';
import { SideConversation } from './components/SideConversation.js';
import { ForkEntries, ForkReference } from './components/ForkReference.js';
import { captureForkContext, forkDisplayState, ForkStore, type SessionFork } from './session-forks.js';
import { configureFork, forkActions, forkCommands, sendForkInput } from './fork-actions.js';
import type { QuestionDraft } from '@borgee/agent-remote-web/react';
import { ReplicaInspector } from './components/ReplicaInspector.js';
import { ProviderSessionControls, type ProviderCatalogStatus } from './components/ProviderSessionControls.js';
import { RecordedPlaybackControls } from './components/RecordedPlaybackControls.js';
import { SupportingRail } from './components/SupportingRail.js';
import { TraceView } from './components/TraceView.js';

export interface LabTransport extends RemoteAgentTransport {
  listProviders(): Promise<readonly AgentProviderDescriptor[]>;
  createAgent(agentId: string, providerId: string, config: AgentSessionConfig): Promise<AgentSessionResponse>;
  resumeAgent(agentId: string, persistence: AgentPersistenceHandle): Promise<AgentSessionResponse>;
}

export interface AppActions {
  loadOlder?(): void | Promise<void>;
  sendMessage?(text: string, options?: AgentMessageOptions): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
  respondToInteraction?(requestId: string, response: AgentInteractionResponse): Promise<void>;
  requestResource?(binding: ResourceBinding): Promise<void>;
  advanceFixture?(): void | Promise<void>;
  rehydrateFixture?(): void | Promise<void>;
  stopReader?(): void | Promise<void>;
}

export interface AppProps {
  baseUrl?: string;
  transport?: LabTransport;
  directory?: SessionDirectoryClient;
  hostService?: HostPairingService;
  initialState?: AgentReplicaState;
  initialSessionStatus?: RemoteSessionStatus;
  initialProviderName?: string;
  actions?: AppActions;
  fixtureAction?(agentId: string, action: 'advance' | 'rehydrate' | 'stop-reader'): void | Promise<void>;
}

export function App({
  baseUrl = window.location.origin,
  transport: injectedTransport,
  directory: injectedDirectory,
  hostService,
  initialState,
  initialSessionStatus = 'idle',
  initialProviderName,
  actions,
  fixtureAction,
}: AppProps) {
  const transport = useMemo<LabTransport>(() => injectedTransport
    ?? new HttpWebSocketTransport(baseUrl) as LabTransport, [baseUrl, injectedTransport]);
  const [selectedHost, setSelectedHost] = useState<RemoteHost>({ id: 'local', name: 'Recorded fixture', online: true });
  const hostClient = useMemo(() => hostService ?? new RemoteHostClient(baseUrl), [baseUrl, hostService]);
  const directory = useMemo(() => injectedDirectory ?? (!injectedTransport && !initialState ? new SessionDirectoryClient(baseUrl, undefined, selectedHost.id) : undefined), [baseUrl, injectedDirectory, injectedTransport, initialState, selectedHost.id]);
  const { hosts: remoteHosts, error: hostError, retry: retryHosts } = useRemoteHosts(hostClient, directory !== undefined);
  const restoredHostSelection = useRef(false);
  const [openedSessions, setOpenedSessions] = useState<OpenedSession[]>(() => directory ? readOpenedSessions(baseUrl) : []);
  const openedSessionsRef = useRef(openedSessions);
  openedSessionsRef.current = openedSessions;
  const forkStore = useMemo(() => new ForkStore(baseUrl), [baseUrl]);
  const [, setForkRevision] = useState(0);
  useEffect(() => forkStore.subscribe(() => setForkRevision((value) => value + 1)), [forkStore]);
  const [sideSession, setSideSession] = useState<OpenedSession>();
  const forkReservation = useRef<{ key: string; record: SessionFork }>();
  const forkBusy = useRef(false);
  const [forkInputStatus, setForkInputStatus] = useState<{ agentId: string; pending: boolean; error?: string }>();
  const [sessionOptions, setSessionOptions] = useState<CreateSessionOptions>({});
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const creationReservation = useRef<{ requestId: string; options: CreateSessionOptions; providerId: string }>();
  const [creationLocked, setCreationLocked] = useState(false);
  const replicas = useRef(new Map<string, AgentReplica>());
  const [uncertainMutation, setUncertainMutation] = useState(false);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const clientRef = useRef<RemoteSessionClient>();
  const replicaRef = useRef<AgentReplica>();
  const unsubscribeReplicaRef = useRef<() => void>();
  const transitionRef = useRef(false);
  const navigationGeneration = useRef(0);
  const providerRequestGenerationRef = useRef(0);
  const workbenchTabRef = useRef<HTMLButtonElement>(null);
  const traceTabRef = useRef<HTMLButtonElement>(null);
  const viewTriggerRef = useRef<HTMLButtonElement>(null);
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
  const [state, setState] = useState<AgentReplicaState | undefined>(initialState);
  const [status, setStatus] = useState<RemoteSessionStatus>(initialSessionStatus);
  const [attachingAgentId, setAttachingAgentId] = useState<string>();
  const [transitioning, setTransitioning] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [activeView, setActiveView] = useState<'workbench' | 'trace'>('workbench');
  const [contextOpen, setContextOpen] = useState(() => compactLayoutRef.current && !initialState);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [headerHidden, setHeaderHidden] = useState(false);
  const [desktopContextVisible, setDesktopContextVisible] = useState(true);
  const [compactLayout, setCompactLayout] = useState(compactLayoutRef.current);

  useEffect(() => {
    if (restoredHostSelection.current || remoteHosts.length === 0) return;
    const activeId = state?.agent?.id ?? rememberedAgent();
    const saved = openedSessions.find((item) => item.agentId === activeId && item.hostId && item.hostId !== 'local');
    if (!saved) { restoredHostSelection.current = true; return; }
    const host = remoteHosts.find((item) => item.id === saved.hostId);
    if (!host) return;
    restoredHostSelection.current = true;
    setSelectedHost({ ...host, providerId: saved.providerId });
    const descriptor = host.providers?.find((provider) => provider.providerId === saved.providerId);
    setProviderName(descriptor ? `${descriptor.displayName} · ${host.name}` : saved.providerId);
  }, [openedSessions, remoteHosts, state?.agent?.id]);

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

  function providerConnectionName(hostId: string, selectedProviderId: string): string {
    if (hostId === 'local') return providers.find((provider) => provider.providerId === selectedProviderId)?.displayName ?? selectedProviderId;
    const host = remoteHosts.find((candidate) => candidate.id === hostId);
    const descriptor = host?.providers?.find((provider) => provider.providerId === selectedProviderId);
    return descriptor && host ? `${descriptor.displayName} · ${host.name}` : selectedProviderId;
  }

  function selectHost(host: RemoteHost): void {
    if (creationLocked || transitionRef.current) return;
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

  const attach = useCallback((agentId: string): void => {
    navigationGeneration.current += 1;
    unsubscribeReplicaRef.current?.();
    unsubscribeReplicaRef.current = undefined;
    clientRef.current?.stop();
    if (compactLayoutRef.current) {
      focusTimelineAfterAttachRef.current = true;
      setContextOpen(false);
      setInspectorOpen(false);
      setActiveView('workbench');
    }
    setState(replicas.current.get(agentId)?.getState());
    setStatus('connecting');
    setAttachingAgentId(agentId);
    const replica = replicas.current.get(agentId) ?? new AgentReplica();
    replicas.current.set(agentId, replica);
    const client = new RemoteSessionClient(agentId, transport, replica, { historyPageSize: 100 });
    replicaRef.current = replica;
    clientRef.current = client;
    unsubscribeReplicaRef.current = replica.subscribe(() => { if (replicaRef.current === replica) setState(replica.getState()); });
    client.subscribeStatus((next) => { if (clientRef.current === client) setStatus(next); });
    client.start();
    rememberAgent(agentId);
  }, [transport]);

  useEffect(() => {
    if (initialState) return;
    void loadProviders();
  }, [initialState, loadProviders]);

  useEffect(() => () => {
    providerRequestGenerationRef.current += 1;
    navigationGeneration.current += 1;
    unsubscribeReplicaRef.current?.();
    unsubscribeReplicaRef.current = undefined;
    clientRef.current?.stop();
  }, []);

  useEffect(() => {
    if (initialState) return;
    const remembered = rememberedAgent();
    if (remembered) {
      const saved = openedSessionsRef.current.find((item) => item.agentId === remembered);
      if (directory && saved) {
        setProviderName(providerConnectionName(saved.hostId ?? 'local', saved.providerId));
        const target = new SessionDirectoryClient(baseUrl, undefined, saved.hostId ?? 'local');
        const request = saved.parentNativeSessionId ? target.attachChild(saved.providerId, saved.parentNativeSessionId, saved.nativeSessionId) : target.attach(saved.providerId, saved.nativeSessionId);
        void request.then((result) => { rememberSession({ ...saved, agentId: result.agentId }); attach(result.agentId); }).catch((error) => setFailure(message(error, 'Session could not be reconnected.')));
      } else attach(remembered);
    }
    return () => clientRef.current?.stop();
  }, [attach, baseUrl, initialState]);

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
    setOpenedSessions((current) => [item, ...current.filter((entry) => !((entry.hostId ?? 'local') === (item.hostId ?? 'local') && entry.providerId === item.providerId && entry.nativeSessionId === item.nativeSessionId) && entry.agentId !== item.agentId)]);
  }

  async function openSession(item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & { hostId?: string; parentAgentId?: string; parentNativeSessionId?: string }): Promise<void> {
    if (!directory || transitionRef.current) return;
    const generation = navigationGeneration.current;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    try {
      const hostId = item.hostId ?? selectedHost.id;
      const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
      const result = item.parentNativeSessionId
        ? await target.attachChild(item.providerId, item.parentNativeSessionId, item.nativeSessionId)
        : await target.attach(item.providerId, item.nativeSessionId);
      if (navigationGeneration.current !== generation) return;
      const prior = openedSessions.find((entry) => sessionKey(entry) === sessionKey({ ...item, hostId }));
      rememberSession({ ...prior, ...item, hostId, agentId: result.agentId });
      setProviderName(providerConnectionName(hostId, item.providerId));
      if (sideSession?.nativeSessionId === item.nativeSessionId && sideSession.providerId === item.providerId && (sideSession.hostId ?? 'local') === hostId) setSideSession(undefined);
      attach(result.agentId);
    } catch (error) { setFailure(message(error, 'Session could not be connected.')); }
    finally { transitionRef.current = false; setTransitioning(false); }
  }

  async function openChildSession(child: AgentChildSession): Promise<void> {
    const parent = state?.agent;
    const parentNativeSessionId = parent?.runtimeInfo.sessionId;
    if (!directory || !parent || !parentNativeSessionId) throw new Error('The parent session is unavailable.');
    const generation = navigationGeneration.current;
    if (transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
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
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  }

  async function createAgent(): Promise<void> {
    if (!providerId || selectedHostOffline || transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    const agentId = createAgentId();
    try {
      if (directory) {
        const reservation = creationReservation.current ?? { requestId: agentId, providerId, options: { ...sessionOptions, ...(createPlanning && providerId !== 'dsh' ? { planning: true } : {}) } };
        creationReservation.current = reservation;
        setCreationLocked(true);
        const response = await directory.create(reservation.providerId, reservation.requestId, reservation.options);
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
    } catch (error) {
      const invalid = error instanceof DirectoryError && ['invalid_request', 'workspace_not_found', 'provider_not_found'].includes(error.code ?? '');
      if (invalid) { creationReservation.current = undefined; setCreationLocked(false); }
      setFailure(`${message(error, 'Agent could not be created.')}${directory && !invalid ? ' Retry keeps the same session reservation and settings.' : ''}`);
    } finally {
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
    setFailure(undefined);
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

  function openContext(): void {
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
  const sessionEntries = useSessionEntries(openedSessions, state);
  const currentSession = sessionEntries.find((item) => item.agentId === activeAgentId);
  const activeRemoteSession = activeOpened?.hostId !== undefined && activeOpened.hostId !== 'local';
  const activeHost = remoteHosts.find((host) => host.id === activeOpened?.hostId);
  const hostOffline = activeHost?.online === false;
  const connectionProviderName = providerName ?? state?.agent?.providerId ?? 'No active Agent';
  const connectionStatusLabel = hostOffline ? 'Host offline' : state?.agent?.status === 'failed' ? 'Agent failed' : sessionStatusLabel(status);


  async function runMutation<T>(operation: () => Promise<T>): Promise<T> {
    setUncertainMutation(false);
    try { return await operation(); } catch (error) {
      if (error instanceof RemoteOperationError && ['connection_disconnected', 'operation_timeout', 'operation_send_failed'].includes(error.code)) setUncertainMutation(true);
      throw error;
    }
  }

  const activeFork = forkStore.find(activeOpened ?? (state?.agent?.runtimeInfo.sessionId ? {
    providerId: state.agent.providerId, nativeSessionId: state.agent.runtimeInfo.sessionId, hostId: 'local',
  } : undefined));
  const boundFork = activeFork && activeAgentId ? { ...activeFork, target: { ...activeFork.target!, agentId: activeAgentId } } : undefined;

  async function openFork(record: SessionFork): Promise<void> {
    if (!record.target || !directory) return;
    const saved = record.target;
    const target = (saved.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, saved.hostId);
    try {
      const result = await target.attach(saved.providerId, saved.nativeSessionId);
      const session = { ...saved, agentId: result.agentId };
      forkStore.bind(record.id, session);
      await configureFork(transport, forkStore, forkStore.get(record.id));
      rememberSession(session);
      if (session.agentId !== activeAgentId) setSideSession(session);
    } catch (error) { setFailure(message(error, 'Forked session could not be opened.')); }
  }

  async function createFork(sourceState: AgentReplicaState, saved: OpenedSession | undefined, id: string, args: string): Promise<AgentCommandResult> {
    const agent = sourceState.agent;
    if (!directory || !agent?.runtimeInfo.sessionId) throw new Error('This session cannot be forked.');
    if (forkBusy.current) throw new Error('A session fork is already being created.');
    forkBusy.current = true;
    try {
      const source: OpenedSession = saved ?? { agentId: agent.id, nativeSessionId: agent.runtimeInfo.sessionId, providerId: agent.providerId, title: 'Conversation', hostId: 'local' };
      const target = (source.hostId ?? 'local') === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, source.hostId);
      const key = JSON.stringify([sessionKey(source), id, args]);
      let record = forkReservation.current?.key === key ? forkStore.get(forkReservation.current.record.id) : forkStore.all().find((fork) => fork.creationKey === key);
      if (!record) {
        const context = await captureForkContext(transport, source);
        const settings = (agent.runtimeInfo.settings ?? []).filter((setting) => setting.mutable && setting.scope === 'session' && setting.value !== null).map(({ id, value }) => ({ id, value }));
        let options: CreateSessionOptions;
        if ((source.hostId ?? 'local') !== 'local' && source.providerId === 'dsh') {
          const workspaces = (await target.workspaces(source.providerId)).workspaces;
          const workspace = workspaces.find(({ path }) => path === agent.cwd);
          if (agent.cwd && !workspace) throw new Error('The source workspace is no longer registered on this Host.');
          options = workspace ? { workspaceId: workspace.id } : {};
        } else options = { ...(agent.cwd ? { cwd: agent.cwd } : {}), ...(agent.model && source.providerId !== 'dsh' ? { model: agent.model } : {}),
          ...(agent.capabilities.planning && source.providerId !== 'dsh' ? { planning: agent.runtimeInfo.planning?.active === true } : {}) };
        record = forkStore.prepare(context, options, settings, key);
        forkReservation.current = { key, record };
      }
      const result = record.target ? await target.attach(record.target.providerId, record.target.nativeSessionId) : await target.create(source.providerId, record.id, record.options);
      const session: OpenedSession = { agentId: result.agentId, nativeSessionId: result.nativeSessionId ?? result.agentId, providerId: source.providerId,
        hostId: source.hostId ?? 'local', title: `Fork of ${source.title}`, createdAt: record.capturedAt };
      forkStore.bind(record.id, session);
      await configureFork(transport, forkStore, forkStore.get(record.id));
      rememberSession(source); rememberSession(session);
      setDirectoryRevision((value) => value + 1);
      if (args.trim()) setMessageDrafts((current) => ({ ...current, [session.agentId]: args.trim() }));
      if (id === 'console:side') setSideSession(session);
      if (args.trim() && forkStore.get(record.id).delivery !== 'sent') {
        setForkInputStatus({ agentId: session.agentId, pending: true });
        try { await sendForkInput(transport, forkStore, forkStore.get(record.id), args.trim()); }
        catch (error) { setForkInputStatus({ agentId: session.agentId, pending: false, error: message(error, 'The first fork input failed.') }); throw error; }
        setForkInputStatus(undefined);
        setMessageDrafts((current) => current[session.agentId] === args.trim() ? { ...current, [session.agentId]: '' } : current);
      }
      forkStore.finishCreation(record.id);
      forkReservation.current = undefined;
      return {};
    } finally { forkBusy.current = false; }
  }

  const submittedClient = clientRef.current;
  function commandClient(): RemoteSessionClient {
    if (!submittedClient || clientRef.current !== submittedClient) throw new RemoteOperationError('session_changed', 'The conversation changed before this action could be sent. Return to its original session to retry.', true);
    return submittedClient;
  }

  const clientActions: AppActions = actions ?? {
    loadOlder: clientRef.current?.loadOlder.bind(clientRef.current),
    sendMessage: async (text, options) => { await runMutation(() => commandClient().sendMessage(text, options)); },
    steer: async (text) => { await runMutation(() => commandClient().steer(text)); },
    cancel: async () => { await runMutation(() => commandClient().cancel()); },
    listCommands: () => commandClient().listCommands(),
    executeCommand: (id, args) => runMutation(() => commandClient().executeCommand(id, args)),
    setSessionSetting: async (id, value) => { await runMutation(() => commandClient().setSessionSetting(id, value)); },
    setPlanning: async (active) => { await runMutation(() => commandClient().setPlanning(active)); },
    respondToInteraction: async (requestId, response) => { await runMutation(() => commandClient().respondToInteraction(requestId, response)); },
    requestResource: async (binding) => { await commandClient().requestResource(binding.resourceId); },
    ...(fixtureAction && activeAgentId && state?.agent?.providerId === 'recorded' && !activeRemoteSession ? {
      advanceFixture: () => fixtureAction(activeAgentId, 'advance'),
      rehydrateFixture: () => fixtureAction(activeAgentId, 'rehydrate'),
      stopReader: () => fixtureAction(activeAgentId, 'stop-reader'),
    } : {}),
  };

  const conversationActions = forkActions(clientActions, forkStore, boundFork, transport);

  return <main className={`lab-shell${headerHidden ? ' lab-header-hidden' : ''}${!compactLayout && !desktopContextVisible ? ' lab-context-hidden' : ''}${state?.agent ? ' lab-has-agent' : ''}${supportingRailOpen ? ' lab-supporting-open' : ''}${inspectorOpen ? ' lab-inspector-open' : ''}`}>
    <ViewOptions triggerRef={viewTriggerRef} headerVisible={!headerHidden} sidebarVisible={contextVisible}
      inspectorVisible={inspectorOpen} compact={compactLayout} inert={supportingRailOpen}
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
        <span aria-live="polite">{connectionStatusLabel}</span><span aria-hidden="true">▾</span></summary>
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
      triggerRef={viewTriggerRef}
      onClose={() => setContextOpen(false)}
    >
      <div className="lab-rail-heading">
        <p className="lab-eyebrow">Context</p>
        <span title={baseUrl}>Connected runtime · {new URL(baseUrl, window.location.origin).host}</span>
      </div>
      {directory ? <HostPairing service={hostClient} selectedHostId={selectedHost.id} selectionLocked={creationLocked || transitioning} onNewSession={() => { const element = document.getElementById('provider-select'); element?.scrollIntoView({ block: 'start' }); element?.focus(); }} hosts={remoteHosts} hostError={hostError} onRetryHosts={retryHosts} onSelect={selectHost} /> : null}
      {directory ? <SessionDirectory directory={directory} providerId={providerId} activeAgentId={activeAgentId} opened={openedSessions} known={sessionEntries} hostId={selectedHost.id} onOpenRelated={(item) => void openSession(item)} busy={transitioning || (remoteHosts.find((host) => host.id === selectedHost.id)?.online === false)} revision={directoryRevision} onOpen={(item) => void openSession(item)} onSelect={(item) => void openSession(item)} onClose={(agentId) => setOpenedSessions((current) => current.filter((item) => item.agentId !== agentId))} /> : null}
      <ProviderSessionControls
        providers={providerChoices}
        selectedProviderId={selectedProviderChoice?.selectionId ?? ''}
        catalogStatus={selectedHost.id !== 'local' || (catalogStatus === 'empty' && providerChoices.length > 0) ? 'ready' : catalogStatus}
        catalogError={catalogError}
        creating={transitioning}
        unavailableReason={selectedHostOffline ? 'This Host is offline. Reconnect it or select another Provider.' : undefined}
        planning={createPlanning}
        configurationLocked={creationLocked}
        onPlanningChange={providerId !== 'dsh' && !creationLocked ? setCreatePlanning : undefined}
        onRetryProviders={() => void loadProviders()}
        persistence={activeOpened?.parentAgentId || activeOpened?.parentNativeSessionId ? undefined : state?.agent?.persistence}
        onSelectedProviderChange={selectProvider}
        onCreateSession={() => void createAgent()}
        onResumeSession={activeRemoteSession || activeOpened?.parentAgentId || activeOpened?.parentNativeSessionId ? undefined : () => void resumeAgent()}
      >{directory ? <SessionConfiguration directory={directory} providerId={providerId} value={sessionOptions} disabled={transitioning || creationLocked || selectedHostOffline} onChange={setSessionOptions} /> : null}</ProviderSessionControls>
      {clientActions.advanceFixture || clientActions.rehydrateFixture || clientActions.stopReader ? <RecordedPlaybackControls
        onAdvance={clientActions.advanceFixture}
        onRehydrate={clientActions.rehydrateFixture}
        onStopReader={clientActions.stopReader}
      /> : null}
      {failure ? <p className="lab-control-note" role="alert">{failure}</p> : null}
    </SupportingRail>
    <section className="lab-main-stage" {...backgroundInert}>
      <section
        ref={workbenchPanelRef}
        id="lab-workbench"
        data-testid="workbench"
        role="tabpanel"
        aria-labelledby="lab-workbench-tab"
        tabIndex={-1}
        hidden={activeView !== 'workbench'}
      >
        {uncertainMutation ? <p className="lab-control-note" role="alert">The previous action may have completed before the connection was interrupted. Its result is unknown. It will not be replayed automatically.</p> : null}
        <div className={`lab-conversation-split${sideSession ? ' lab-has-side' : ''}`}>
        <div className="lab-primary-conversation">
        <LabWorkbench
          state={forkDisplayState(state, boundFork)} sessionStatus={hostOffline ? 'disconnected' : status} attachingAgentId={attachingAgentId} actions={!hostOffline && !(forkInputStatus?.pending && forkInputStatus.agentId === activeAgentId) && (status === 'ready' || initialState) ? conversationActions : {}} visible={activeView === 'workbench'}
          consoleCommands={directory && state?.agent?.capabilities.sendMessage && state.agent.capabilities.history ? forkCommands : []}
          onExecuteConsoleCommand={(id, args) => state ? createFork(state, activeOpened, id, args) : Promise.reject(new Error('No active session.'))}
          composerAttachments={boundFork ? <ForkReference fork={boundFork} onOpen={(session) => void openSession(session)} /> : undefined}
          composerNotice={<ForkEntries forks={forkStore.all().filter((fork) => fork.target && (fork.source.agentId === activeAgentId || (activeOpened && sessionKey(fork.source) === sessionKey(activeOpened))))} onOpen={(fork) => void openFork(fork)} />}
          sessionManager={directory && currentSession ? <ChatSessionManager current={currentSession} entries={sessionEntries} busy={transitioning || hostOffline} onOpen={(item) => void openSession(item)} /> : undefined}
          conversationPath={ancestors.length > 0 ? <nav className="lab-conversation-path" aria-label="Conversation path">
            {ancestors.map((ancestor) => <span key={ancestor.agentId}>
              <button type="button" disabled={transitioning} onClick={() => { void openSession(ancestor); }}>{ancestor.title}</button>
              <span aria-hidden="true"> / </span>
            </span>)}
            <span aria-current="page">{activeOpened?.title}</span>
          </nav> : null}
          onOpenChildSession={directory && !hostOffline && !transitioning ? openChildSession : undefined}
          messageDraft={activeAgentId ? messageDrafts[activeAgentId] ?? '' : ''}
          onMessageDraftChange={activeAgentId ? (text) => setMessageDrafts((current) => ({ ...current, [activeAgentId]: text })) : undefined}
          questionDrafts={activeAgentId ? questionDrafts[activeAgentId] ?? {} : undefined}
          onQuestionDraftChange={activeAgentId ? (requestId, draft) => setQuestionDrafts((current) => ({
            ...current, [activeAgentId]: { ...current[activeAgentId], [requestId]: draft },
          })) : undefined}
        />
        </div>
        {sideSession ? <SideConversation key={sessionKey(sideSession)} session={sideSession} transport={transport} store={forkStore}
          initialInput={forkInputStatus?.agentId === sideSession.agentId ? forkInputStatus : undefined}
          visible={activeView === 'workbench'} draft={messageDrafts[sideSession.agentId] ?? ''}
          onDraftChange={(text) => setMessageDrafts((current) => ({ ...current, [sideSession.agentId]: text }))}
          onClose={() => { setSideSession(undefined); workbenchPanelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); }}
          onOpenSource={(session) => void openSession(session)} onOpenFork={(fork) => void openFork(fork)} onFork={createFork} /> : null}
        </div>
      </section>
      <section
        id="lab-trace"
        data-testid="trace-view"
        role="tabpanel"
        aria-labelledby="lab-trace-tab"
        hidden={activeView !== 'trace'}
      >
        <TraceView state={state} />
      </section>
    </section>
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
  </main>;
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
  const url = new URL(window.location.href);
  url.searchParams.set('agent', agentId);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function sessionStatusLabel(status: RemoteSessionStatus): string {
  switch (status) {
    case 'connecting': return 'Connecting';
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
