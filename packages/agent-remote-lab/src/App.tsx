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
import { LabWorkbench } from './components/LabWorkbench.js';
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
  sendMessage?(text: string): Promise<void>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  setPlanning?(active: boolean): Promise<void>;
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
  const [selectedHost, setSelectedHost] = useState<RemoteHost>({ id: 'local', name: 'Local runtime', online: true });
  const hostClient = useMemo(() => hostService ?? new RemoteHostClient(baseUrl), [baseUrl, hostService]);
  const directory = useMemo(() => injectedDirectory ?? (!injectedTransport && !initialState ? new SessionDirectoryClient(baseUrl, undefined, selectedHost.id) : undefined), [baseUrl, injectedDirectory, injectedTransport, initialState, selectedHost.id]);
  const { hosts: remoteHosts, error: hostError, retry: retryHosts } = useRemoteHosts(hostClient, directory !== undefined);
  const [openedSessions, setOpenedSessions] = useState<OpenedSession[]>(() => directory ? readOpenedSessions(baseUrl) : []);
  const openedSessionsRef = useRef(openedSessions);
  openedSessionsRef.current = openedSessions;
  const [sessionOptions, setSessionOptions] = useState<CreateSessionOptions>({});
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const creationReservation = useRef<{ requestId: string; options: CreateSessionOptions; providerId: string }>();
  const [creationLocked, setCreationLocked] = useState(false);
  const replicas = useRef(new Map<string, AgentReplica>());
  const [uncertainMutation, setUncertainMutation] = useState(false);
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const clientRef = useRef<RemoteSessionClient>();
  const replicaRef = useRef<AgentReplica>();
  const transitionRef = useRef(false);
  const providerRequestGenerationRef = useRef(0);
  const workbenchTabRef = useRef<HTMLButtonElement>(null);
  const traceTabRef = useRef<HTMLButtonElement>(null);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
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
  const [compactLayout, setCompactLayout] = useState(compactLayoutRef.current);

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

  const providerChoices = [
    ...providers.map((provider) => ({ ...provider, hostId: 'local', selectionId: provider.providerId })),
    ...remoteHosts.filter((host) => host.id !== 'local').map((host) => ({
      providerId: host.providerId ?? 'dsh', hostId: host.id,
      selectionId: JSON.stringify([host.id, host.providerId ?? 'dsh']),
      displayName: `DSH · ${host.name} · ${host.online ? 'Online' : 'Offline'}`,
    })),
  ];
  const selectedProviderChoice = providerChoices.find((choice) => choice.hostId === selectedHost.id && choice.providerId === providerId);
  const selectedHostOffline = selectedHost.id !== 'local' && remoteHosts.find((host) => host.id === selectedHost.id)?.online !== true;

  function selectHost(host: RemoteHost): void {
    if (creationLocked || transitionRef.current) return;
    setSelectedHost(host);
    setSessionOptions({});
    setCreatePlanning(false);
  }

  function selectProvider(selectionId: string): void {
    if (creationLocked || transitionRef.current) return;
    const choice = providerChoices.find((item) => item.selectionId === selectionId);
    if (!choice) return;
    const host = remoteHosts.find((item) => item.id === choice.hostId);
    selectHost(host ?? { id: 'local', name: 'Local runtime', online: true });
    if (choice.hostId === 'local') setLocalProviderId(choice.providerId);
  }

  const attach = useCallback((agentId: string): void => {
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
    const client = new RemoteSessionClient(agentId, transport, replica, { historyPageSize: 3 });
    replicaRef.current = replica;
    clientRef.current = client;
    replica.subscribe(() => { if (replicaRef.current === replica) setState(replica.getState()); });
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
  }, []);

  useEffect(() => {
    if (initialState) return;
    const remembered = rememberedAgent();
    if (remembered) {
      const saved = openedSessionsRef.current.find((item) => item.agentId === remembered);
      if (directory && saved) {
        setProviderName(saved.providerId);
        void new SessionDirectoryClient(baseUrl, undefined, saved.hostId ?? 'local').attach(saved.providerId, saved.nativeSessionId).then((result) => attach(result.agentId)).catch((error) => setFailure(message(error, 'Session could not be reconnected.')));
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

  function rememberSession(item: OpenedSession): void {
    setOpenedSessions((current) => [item, ...current.filter((entry) => !((entry.hostId ?? 'local') === (item.hostId ?? 'local') && entry.providerId === item.providerId && entry.nativeSessionId === item.nativeSessionId) && entry.agentId !== item.agentId)]);
  }

  async function openSession(item: Pick<SessionSummary, 'providerId' | 'nativeSessionId' | 'title'> & { hostId?: string }): Promise<void> {
    if (!directory || transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    try {
      const hostId = item.hostId ?? selectedHost.id;
      const target = hostId === selectedHost.id ? directory : new SessionDirectoryClient(baseUrl, undefined, hostId);
      const result = await target.attach(item.providerId, item.nativeSessionId);
      rememberSession({ ...item, hostId, agentId: result.agentId });
      setProviderName(providers.find((provider) => provider.providerId === item.providerId)?.displayName ?? item.providerId);
      attach(result.agentId);
    } catch (error) { setFailure(message(error, 'Session could not be connected.')); }
    finally { transitionRef.current = false; setTransitioning(false); }
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
      setProviderName(selectedHost.id === 'local' ? selectedProviderChoice?.displayName ?? providerId : `DSH · ${selectedHost.name}`);
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
    if (!persistence || transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    setFailure(undefined);
    const agentId = createAgentId();
    try {
      const response = await transport.resumeAgent(agentId, persistence);
      attach(response.payload.agentId);
    } catch (error) {
      setFailure(message(error, 'Agent could not be resumed.'));
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
    setInspectorOpen(false);
    setContextOpen(true);
  }

  function openInspector(): void {
    setContextOpen(false);
    setInspectorOpen(true);
  }

  const supportingRailOpen = compactLayout && (contextOpen || inspectorOpen);
  const backgroundInert = supportingRailOpen ? { inert: '' } : {};

  const activeAgentId = state?.agent?.id ?? attachingAgentId;
  const connectionAgentId = state?.agent?.id ?? attachingAgentId ?? 'standby';
  const activeOpened = openedSessions.find((item) => item.agentId === activeAgentId);
  const activeRemoteSession = activeOpened?.hostId !== undefined && activeOpened.hostId !== 'local';
  const activeHost = remoteHosts.find((host) => host.id === activeOpened?.hostId);
  const hostOffline = activeHost?.online === false;
  const connectionProviderName = providerName ?? state?.agent?.providerId ?? 'No active Agent';
  const connectionStatusLabel = hostOffline ? 'Host offline' : state?.agent?.status === 'failed' ? 'Agent failed' : sessionStatusLabel(status);
  function activeClient(): RemoteSessionClient {
    if (!clientRef.current) throw new Error('Remote client is not attached to an Agent.');
    return clientRef.current;
  }

  async function runMutation(operation: () => Promise<unknown>): Promise<void> {
    setUncertainMutation(false);
    try { await operation(); } catch (error) {
      if (error instanceof RemoteOperationError && ['connection_disconnected', 'operation_timeout', 'operation_send_failed'].includes(error.code)) setUncertainMutation(true);
      throw error;
    }
  }

  const clientActions: AppActions = actions ?? {
    loadOlder: () => clientRef.current?.loadOlder(),
    sendMessage: async (text) => runMutation(() => activeClient().sendMessage(text)),
    steer: async (text) => runMutation(() => activeClient().steer(text)),
    cancel: async () => runMutation(() => activeClient().cancel()),
    setPlanning: async (active) => runMutation(() => activeClient().setPlanning(active)),
    respondToInteraction: async (requestId, response) => runMutation(() => activeClient().respondToInteraction(requestId, response)),
    requestResource: async (binding) => { await activeClient().requestResource(binding.resourceId); },
    ...(fixtureAction && activeAgentId && state?.agent?.providerId === 'recorded' && !activeRemoteSession ? {
      advanceFixture: () => fixtureAction(activeAgentId, 'advance'),
      rehydrateFixture: () => fixtureAction(activeAgentId, 'rehydrate'),
      stopReader: () => fixtureAction(activeAgentId, 'stop-reader'),
    } : {}),
  };

  return <main className={`lab-shell${state?.agent ? ' lab-has-agent' : ''}${supportingRailOpen ? ' lab-supporting-open' : ''}${inspectorOpen ? ' lab-inspector-open' : ''}`}>
    <header className="lab-app-bar">
      <div className="lab-brand">
        <span className="lab-brand-mark" aria-hidden="true">AR</span>
        <div>
          <p>Agent Remote Control</p>
          <h1>Agent conversations</h1>
        </div>
      </div>
      <div
        className="lab-session-summary"
        data-testid="connection-summary"
        aria-label={`${connectionProviderName}. Agent ${connectionAgentId}. ${connectionStatusLabel}`}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className={`lab-status-dot lab-status-${state?.agent?.status ?? 'disconnected'}`} aria-hidden="true" />
        <span>{connectionProviderName}</span>
        <code title={connectionAgentId}>{connectionAgentId}</code>
        <span>{connectionStatusLabel}</span>
        {directory && activeAgentId ? <button type="button" className="lab-session-reconnect" disabled={transitioning} onClick={() => {
          const saved = openedSessions.find((item) => item.agentId === activeAgentId);
          if (saved) void openSession(saved); else attach(activeAgentId);
        }}>Reconnect</button> : null}
      </div>
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
      <div className="lab-supporting-controls" {...backgroundInert}>
        {compactLayout ? <button
          ref={contextTriggerRef}
          className="lab-supporting-trigger"
          type="button"
          aria-controls="lab-context"
          aria-expanded={contextOpen}
          onClick={() => contextOpen ? setContextOpen(false) : openContext()}
        >Context</button> : null}
        <button
          ref={inspectorTriggerRef}
          className="lab-supporting-trigger"
          type="button"
          aria-controls="lab-inspector"
          aria-expanded={inspectorOpen}
          onClick={() => inspectorOpen ? setInspectorOpen(false) : openInspector()}
        >Replica Inspector</button>
      </div>
    </header>
    <SupportingRail
      id="lab-context"
      label="Context"
      className="lab-context-rail"
      compact={compactLayout}
      open={contextOpen}
      triggerRef={contextTriggerRef}
      onClose={() => setContextOpen(false)}
    >
      <div className="lab-rail-heading">
        <p className="lab-eyebrow">Context</p>
        <span title={baseUrl}>Connected runtime · {new URL(baseUrl, window.location.origin).host}</span>
      </div>
      {directory ? <HostPairing service={hostClient} selectedHostId={selectedHost.id} selectionLocked={creationLocked || transitioning} onNewSession={() => { const element = document.getElementById('provider-select'); element?.scrollIntoView({ block: 'start' }); element?.focus(); }} hosts={remoteHosts} hostError={hostError} onRetryHosts={retryHosts} onSelect={selectHost} /> : null}
      {directory ? <SessionDirectory directory={directory} providerId={providerId} activeAgentId={activeAgentId} opened={openedSessions} busy={transitioning || (remoteHosts.find((host) => host.id === selectedHost.id)?.online === false)} revision={directoryRevision} onOpen={(item) => void openSession(item)} onSelect={(item) => void openSession(item)} onClose={(agentId) => setOpenedSessions((current) => current.filter((item) => item.agentId !== agentId))} /> : null}
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
        persistence={state?.agent?.persistence}
        onSelectedProviderChange={selectProvider}
        onCreateSession={() => void createAgent()}
        onResumeSession={activeRemoteSession ? undefined : () => void resumeAgent()}
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
        <LabWorkbench
          state={state} sessionStatus={hostOffline ? 'disconnected' : status} attachingAgentId={attachingAgentId} actions={!hostOffline && (status === 'ready' || initialState) ? clientActions : {}} visible={activeView === 'workbench'}
          messageDraft={activeAgentId ? messageDrafts[activeAgentId] ?? '' : ''}
          onMessageDraftChange={activeAgentId ? (text) => setMessageDrafts((current) => ({ ...current, [activeAgentId]: text })) : undefined}
          questionDrafts={activeAgentId ? questionDrafts[activeAgentId] ?? {} : undefined}
          onQuestionDraftChange={activeAgentId ? (requestId, draft) => setQuestionDrafts((current) => ({
            ...current, [activeAgentId]: { ...current[activeAgentId], [requestId]: draft },
          })) : undefined}
        />
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
      triggerRef={inspectorTriggerRef}
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
    return value.filter((item): item is OpenedSession => item !== null && typeof item === 'object' && ['agentId', 'providerId', 'nativeSessionId', 'title'].every((key) => typeof item[key] === 'string')).slice(0, 100);
  } catch { return []; }
}
