import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import { CommunicationNavigationContext, type AgentChildSessionView, type TimelineDisplayMode } from '@orchardworks/agent-remote-web/react';
import type { SessionWindowTarget } from '../hooks/useSessionWindows.js';
import { WorkspaceReady } from '../workspace-access.js';
import { ConversationConnectionScope } from '../conversation-connections.js';
import { SessionLink } from './SessionLink.js';
import { SessionHeadingActions } from './SessionHeadingActions.js';
import { SessionControlNotice } from './SessionControlNotice.js';
import { AgentReplica, sessionHandoffScope, SessionHandoffRejectedError } from '@orchardworks/agent-remote-web';
import type { NativeSessionOwner, NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { DirectoryError, nativeSessionMissing, SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { readWorkspaceSnapshot, workspaceDisplayState } from '../workspace-cache.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import type { ImageDraftBinding, ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding } from '../draft-store.js';
import { sessionViewNavigation, type SessionViewNavigationActions, type SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { LabWorkbench } from './LabWorkbench.js';
import type { DisplayPreferenceBinding } from '../hooks/useSessionDisplayPreferences.js';
import { SessionLocatorSynchronizingError, SessionViewOperationsContext } from '../session-view-operations.js';
import { useSuccessionContext } from '../hooks/useSuccessionContext.js';

export type FamilySessionPresentationContext = ReturnType<typeof useConversationSession> & {
  session: OpenedSession; viewId?: string; windowViewId?: string;
  conversation: ReturnType<typeof useConversationSession>;
  pending: boolean; offline: boolean; isRoot: boolean; controls?: ReactNode; menuActions?: ReactNode;
};

export interface SessionConversationProps extends Pick<ComponentProps<typeof LabWorkbench>, 'consoleCommands' | 'onExecuteConsoleCommand'> {
  attachmentManaged?: boolean; attachmentNotice?: ReactNode; sessionIntent?: 'history';
  successionContext?: { operationId: string; target: NativeSessionRef };
  directoryFor?(hostId: string): SessionDirectoryClient | undefined;
  replica?: import('@orchardworks/agent-remote-web').AgentReplica;
  replicaFor?(agentId: string): import('@orchardworks/agent-remote-web').AgentReplica;
  onSessionBound?(session: OpenedSession, viewId?: string, windowViewId?: string): void;
  /** The Host confirmed that the view's own session no longer exists; the container presents the view as empty instead. */
  onSessionUnavailable?(target: SessionWindowTarget): void;
  onSessionReady?(session: ReturnType<typeof useConversationSession> | undefined): void;
  attachedSession?: OpenedSession; viewId?: string; windowViewId?: string; nativePrefixOnly?: boolean;
  sessionPresentation?(context: FamilySessionPresentationContext): Partial<ComponentProps<typeof LabWorkbench>>;
  renderSessionFooter?(context: FamilySessionPresentationContext): ReactNode;
  storageScope: string; baseUrl: string; target: SessionWindowTarget; hostLabel: string;
  compact: boolean; active: boolean; offline: boolean; controls?: ReactNode; menuActions?: ReactNode;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; draftBinding?: DraftBinding; imageDraftBinding?: ImageDraftBinding; imageRecipient?: ImageDraftRecipient; navigation?: SessionViewNavigationFactory;
  displayBinding?: DisplayPreferenceBinding;
  visible?: boolean; fixedDisplayMode?: TimelineDisplayMode; dockHeadingStart?: ReactNode;
  attachmentEnabled?: boolean; mutationBlocked?: boolean; onPendingInputChange?(count: number): void;
  familyRoot: boolean; entries: SessionWindowTarget[];
  onNavigate(destination: SessionEntry | AgentChildSessionView, childrenFor: (id: string) => readonly AgentChildSessionView[], source: OpenedSession): Promise<void>;
}
/** How long a view waits for its locator before it reports the wait with a Retry. */
export const locatorSynchronizingNoticeMs = 30_000;
export function SessionConversation(props: SessionConversationProps) {
  const { target, baseUrl, attachmentEnabled = true } = props;
  const operations = useContext(SessionViewOperationsContext);
  const [inputOwner, setInputOwner] = useState<{ source: SessionWindowTarget; target: SessionWindowTarget; count: number }>();
  let currentTarget = target, historyRoleId: string | undefined, resolutionError: string | undefined, synchronizing = false, staleLocator = false;
  try {
    const resolved = operations?.resolveTarget(target, { viewId: props.viewId, nativePrefixOnly: props.nativePrefixOnly });
    if (resolved) { currentTarget = { ...target, ...resolved.target, hostId: resolved.target.hostId ?? 'local' }; historyRoleId = resolved.historyRoleId; }
  } catch (error) {
    resolutionError = error instanceof Error ? error.message : 'The current session locator is unavailable.';
    synchronizing = error instanceof SessionLocatorSynchronizingError;
    staleLocator = error instanceof SessionLocatorSynchronizingError && error.stale;
  }
  // A discovery refresh briefly withholds every locator. Keep attaching the target this view last resolved, so a refresh
  // does not cancel an attachment in flight and start another; input still waits until the locator is confirmed again.
  const resolutionRequest = JSON.stringify([sessionKey(target), props.viewId ?? null, !!props.nativePrefixOnly]);
  const lastResolution = useRef<{ request: string; target: SessionWindowTarget; historyRoleId?: string }>();
  const retainedResolution = synchronizing && lastResolution.current?.request === resolutionRequest ? lastResolution.current : undefined;
  if (!resolutionError) lastResolution.current = { request: resolutionRequest, target: currentTarget, historyRoleId };
  else if (retainedResolution) { currentTarget = retainedResolution.target; historyRoleId = retainedResolution.historyRoleId; }
  const attachmentError = retainedResolution ? undefined : resolutionError;
  // Keep the same source's queue observable while its live locator follows succession. Explicit navigation admits its own target.
  const retainingInput = !!inputOwner?.count && sessionKey(inputOwner.source) === sessionKey(target)
    && sessionKey(inputOwner.target) !== sessionKey(currentTarget);
  if (retainingInput) {
    currentTarget = inputOwner!.target;
    resolutionError ??= 'The previous input is still pending. Check its result before continuing in the replacement session.';
  }
  // Synchronizing is a wait, not a failure: the view shows it as opening, without an alert and its Retry, unless the
  // wait lasts long enough to need one.
  const [synchronizingOverdue, setSynchronizingOverdue] = useState(false);
  useEffect(() => {
    setSynchronizingOverdue(false);
    if (!synchronizing) return;
    const timer = setTimeout(() => setSynchronizingOverdue(true), locatorSynchronizingNoticeMs);
    return () => clearTimeout(timer);
  }, [synchronizing]);
  const resolutionNotice = synchronizing && !retainingInput && !synchronizingOverdue ? undefined : resolutionError;
  const retrySynchronizing = synchronizing && synchronizingOverdue && operations?.synchronize
    ? () => { setSynchronizingOverdue(false); operations.synchronize!(); } : undefined;
  const canAttach = attachmentEnabled && !retainingInput;
  const connections = useContext(ConversationConnectionScope);
  const enabled = useContext(WorkspaceReady);
  const preview = useMemo(() => readWorkspaceSnapshot(baseUrl, currentTarget), [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId]);
  const localDirectory = useMemo(() => new SessionDirectoryClient(baseUrl, undefined, currentTarget.hostId), [baseUrl, currentTarget.hostId]);
  const directory = props.directoryFor?.(currentTarget.hostId) ?? localDirectory;
  const [session, setSession] = useState<OpenedSession | undefined>(props.attachedSession), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const targetKey = sessionKey(currentTarget);
  const [nativeOwner, setNativeOwner] = useState<{ targetKey: string; owner: NativeSessionOwner }>();
  const owner = nativeOwner?.targetKey === targetKey ? nativeOwner.owner : undefined;
  const restorations = useRef(new Set<AbortController>());
  useEffect(() => () => {
    for (const request of restorations.current) request.abort();
    restorations.current.clear();
  }, [baseUrl, props.transport, targetKey, directory, enabled, canAttach]);
  const handoff = sessionHandoffScope(props.transport).forTarget(targetKey);
  const [, refreshHandoff] = useState(0);
  useEffect(() => handoff.subscribe(() => refreshHandoff(value => value + 1)), [handoff]);
  const availability = useRef({ targetKey, enabled: enabled && canAttach, offline: props.offline });
  availability.current = { targetKey, enabled: enabled && canAttach, offline: props.offline };
  const nativeTakeover = props.attachmentManaged ? props.attachmentNotice : owner ? <><SessionControlNotice control={{ access: 'read_only', available: false, nativeOwner: owner }}
    connected={enabled && canAttach && !props.offline} handoff={handoff.getState(owner.generation)} onTakeControl={async options => {
      const abort = new AbortController(); restorations.current.add(abort);
      try { await handoff.run(owner.generation, async progress => {
        if (!availability.current.enabled || availability.current.offline || availability.current.targetKey !== targetKey)
          throw new SessionHandoffRejectedError('Workspace access is restoring or the session changed.');
        const value = await directory.attach(currentTarget.providerId, currentTarget.nativeSessionId, abort.signal, progress.checkOnly ? undefined : owner.generation);
        abort.signal.throwIfAborted();
        progress.onRestoring();
        if (!availability.current.enabled || availability.current.targetKey !== targetKey) throw new Error('Session navigation changed before native restoration was confirmed.');
        if (value.nativeSessionId && value.nativeSessionId !== currentTarget.nativeSessionId) throw new Error('The Host returned a different session.');
        const restored = { ...currentTarget, agentId: value.agentId };
        const lease = connections?.acquire(value.agentId, props.replicaFor?.(value.agentId) ?? new AgentReplica(), restored);
        setSession(restored); setError('');
        try { await lease?.client.takeControlAfterNativeResume(); } finally { lease?.release(); }
      }, options); } catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : 'The session could not be restored.'); throw failure; }
      finally { restorations.current.delete(abort); }
      setNativeOwner(current => current?.targetKey === targetKey && current.owner.generation === owner.generation ? undefined : current);
    }} />{error ? <p role="alert">{error}</p> : null}</> : undefined;
  useEffect(() => {
    if (props.attachmentManaged) {
      setError(''); setNativeOwner(undefined);
      if (props.attachedSession && sessionKey(props.attachedSession) === targetKey) setSession(props.attachedSession);
      return;
    }
    if (!enabled || !canAttach) return;
    let stopped = false; const abort = new AbortController(); setError('');
    if (attachmentError) { setError(synchronizing ? '' : attachmentError); return; }
    if (props.attachedSession && sessionKey(props.attachedSession) === sessionKey(currentTarget) && !historyRoleId) { setSession(props.attachedSession); return; }
    if (session && sessionKey(session) === targetKey && !historyRoleId) return;
    const cached = connections?.find(currentTarget);
    if (cached && !historyRoleId) { setSession({ ...currentTarget, agentId: cached.agentId }); return () => { stopped = true; abort.abort(); }; }
    const client = directory;
    const attachment = currentTarget.parentNativeSessionId
      ? client.attachChild(currentTarget.providerId, currentTarget.parentNativeSessionId, currentTarget.nativeSessionId, abort.signal)
      : historyRoleId ? client.attachHistorical(currentTarget.providerId, currentTarget.nativeSessionId, historyRoleId, abort.signal)
      : client.attach(currentTarget.providerId, currentTarget.nativeSessionId, abort.signal);
    void attachment.then(value => {
      if (stopped || !availability.current.enabled || availability.current.targetKey !== targetKey) return;
      if (value.nativeSessionId && value.nativeSessionId !== currentTarget.nativeSessionId) throw new Error('The Host returned a different session. Reopen this subagent from its parent.');
      setSession({ ...currentTarget, agentId: value.agentId }); setNativeOwner(undefined);
    }).catch(error => {
      if (stopped || !availability.current.enabled || availability.current.targetKey !== targetKey) return;
      if (props.familyRoot && props.onSessionUnavailable && nativeSessionMissing(error) && !historyRoleId && !currentTarget.parentNativeSessionId
        && sessionKey(currentTarget) === sessionKey(target)) { props.onSessionUnavailable(currentTarget); return; }
      setError(error instanceof DirectoryError && error.nativeOwner ? '' : error instanceof Error ? error.message : 'The session could not be opened.');
      setNativeOwner(error instanceof DirectoryError && error.nativeOwner ? { targetKey, owner: error.nativeOwner } : undefined);
    });
    return () => { stopped = true; abort.abort(); };
  }, [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId, currentTarget.parentNativeSessionId, historyRoleId, attachmentError, attempt, connections, enabled, canAttach, directory, props.attachedSession?.agentId, props.attachmentManaged]);
  const displayedSession = session && sessionKey(session) === targetKey ? session : undefined;
  // A view whose locator was restored while the Relay is unreachable keeps showing its last resolved target, attached;
  // only its input waits (it queues) until a discovery confirms the locator again.
  const locatorWaiting = !!retainedResolution && staleLocator && !retainingInput;
  const pending = !!resolutionError && !locatorWaiting || !displayedSession;
  return <FamilyChat {...props} onPendingInputChange={count => {
      setInputOwner(previous => count ? previous?.count === count && sessionKey(previous.source) === sessionKey(target) && sessionKey(previous.target) === sessionKey(currentTarget)
        ? previous : { source: target, target: currentTarget, count } : undefined);
      props.onPendingInputChange?.(count);
    }} session={session ?? { ...currentTarget, agentId: '' }} attachmentAvailable={!!session} target={currentTarget} pending={pending} preview={preview} availabilityError={owner ? undefined : resolutionNotice ?? error} nativeTakeover={nativeTakeover}
    onRetryAttachment={retrySynchronizing ?? (enabled && canAttach && !props.offline && !props.attachmentManaged ? () => setAttempt(value => value + 1) : undefined)} />;
}
function FamilyChat({ visible = true, fixedDisplayMode, dockHeadingStart, mutationBlocked = false, onPendingInputChange, session, pending, transport, navigation, draftStore, draftBinding, imageDraftBinding, imageRecipient: explicitImageRecipient, controls, menuActions, offline, entries, onNavigate, displayBinding, baseUrl, target, preview, viewId, nativePrefixOnly, availabilityError, onRetryAttachment, consoleCommands, onExecuteConsoleCommand, replica, replicaFor, onSessionReady, onSessionBound, windowViewId, sessionPresentation, renderSessionFooter, familyRoot, nativeTakeover, sessionIntent, attachmentAvailable, compact, successionContext: explicitContext, directoryFor }: SessionConversationProps & { nativeTakeover?: ReactNode; attachmentAvailable: boolean; session: OpenedSession; pending: boolean; preview?: AgentReplicaState; availabilityError?: string; onRetryAttachment?(): void }) {
  const conversation = useConversationSession(session, transport, replica ?? replicaFor?.(session.agentId), pending, { viewId, nativePrefixOnly, externalAttachment: true, sessionIntent, attachmentAvailable });
  const { state, sessionState, status, actions, questions, setQuestions, imageRecipient, operationBinding } = conversation;
  const nativeIdentityMatches = state?.agent?.id === session.agentId && state.agent.providerId === session.providerId
    && state.agent.runtimeInfo.providerId === session.providerId && state.agent.runtimeInfo.sessionId === session.nativeSessionId;
  const bound = nativeIdentityMatches && !!state?.timeline.initialized && !pending;
  const identityMismatch = !!state?.agent && !nativeIdentityMatches;
  const retainedDisplay = useRef<{ key: string; state: AgentReplicaState }>();
  if (!pending && nativeIdentityMatches && state?.timeline.initialized) retainedDisplay.current = { key: sessionKey(session), state: workspaceDisplayState(state) };
  const retainedState = retainedDisplay.current?.key === sessionKey(target) ? retainedDisplay.current.state : undefined;
  const displayedState = !pending && nativeIdentityMatches && state?.timeline.initialized ? state : retainedState ?? preview ?? (!pending && nativeIdentityMatches ? state : undefined);
  const presentedSession = pending ? { ...target, agentId: session.agentId } : session;
  const safeActions = pending || identityMismatch ? {} : actions;
  const boundReceiver = useRef(onSessionBound); boundReceiver.current = onSessionBound;
  useEffect(() => {
    if (bound) boundReceiver.current?.(session, viewId, windowViewId);
  }, [session.hostId, session.providerId, session.nativeSessionId, session.agentId, viewId, windowViewId, bound]);
  useEffect(() => { onSessionReady?.(conversation); return () => onSessionReady?.(undefined); }, [onSessionReady, conversation.sendQueuedInput, actions.sendMessage]);
  const open = (destination: SessionEntry | AgentChildSessionView) => {
    if (pending) throw new Error('The session is still opening.');
    if (offline) throw new Error('The Host is offline. Reconnect it before opening a subagent.');
    return onNavigate(destination, childrenFor, presentedSession);
  };
  const navigationActions: SessionViewNavigationActions = {
    openChildSession: async child => open(child), openSession: async target => { await open(target); return true; },
  };
  const source = viewId ? { ...session, viewId } : session;
  const inherited = navigation?.(source, displayedState, navigationActions);
  const local = sessionViewNavigation({ source, state: displayedState, entries, ...navigationActions });
  const childrenFor = (id: string) => {
    const children = new Map((inherited?.childrenFor(id) ?? []).map(child => [child.nativeSessionId, child]));
    for (const child of local.childrenFor(id)) children.set(child.nativeSessionId, { ...children.get(child.nativeSessionId), ...child });
    return [...children.values()];
  };
  const key = JSON.stringify([target.hostId, target.providerId, target.nativeSessionId]);
  const presentationContext: FamilySessionPresentationContext = {
    ...conversation, session: presentedSession, viewId, windowViewId, conversation, pending, offline, controls, menuActions, isRoot: familyRoot,
    actions: safeActions,
    state: displayedState,
    imageRecipient: explicitImageRecipient ?? imageRecipient,
  };
  const presentation = sessionPresentation?.(presentationContext);
  const ready = useContext(WorkspaceReady), operations = useContext(SessionViewOperationsContext);
  const succession = explicitContext ?? operations?.successionContextFor?.(viewId);
  const matches = !operationBinding.historical && !session.parentNativeSessionId && succession?.target.providerId === session.providerId
    && succession.target.nativeSessionId === session.nativeSessionId;
  const localDirectory = useMemo(() => new SessionDirectoryClient(baseUrl, undefined, session.hostId), [baseUrl, session.hostId]);
  const [refreshKey, setRefreshKey] = useState(0);
  const context = useSuccessionContext({ directory: directoryFor?.(session.hostId ?? 'local') ?? localDirectory,
    operationId: matches ? succession.operationId : undefined, target: matches ? succession.target : undefined,
    enabled: ready && !offline, refreshKey });
  const contextKey = matches ? JSON.stringify([succession.operationId, viewId, session.hostId, session.providerId, session.nativeSessionId]) : undefined;
  const evidence = `${state?.timeline.epoch}:${state?.timeline.entries.at(-1)?.seqEnd}`;
  const observed = useRef({ contextKey, evidence });
  useEffect(() => {
    if (contextKey && observed.current.contextKey === contextKey && observed.current.evidence !== evidence) setRefreshKey(value => value + 1);
    observed.current = { contextKey, evidence };
  }, [contextKey, evidence]);
  const pendingInput = useRef<{ key: string; count: number }>();
  const reportPendingInput = (count: number) => {
    onPendingInputChange?.(count);
    presentation?.onPendingInputChange?.(count);
    if (!contextKey) return;
    const previous = pendingInput.current;
    pendingInput.current = { key: contextKey, count };
    if (previous?.key === contextKey && previous.count > 0 && count === 0) setRefreshKey(value => value + 1);
  };
  const firstInputPresentation = contextKey ? {
    pendingFirstInputContext: context && context.state !== 'materialized' ? { state: context.state, onRetry: context.onRetry } : undefined,
  } : undefined;
  return <CommunicationNavigationContext.Provider value={inherited?.communication}><LabWorkbench displayBinding={familyDisplayBinding({ displayBinding, target, entries, viewId, windowViewId })} headingMode={compact ? 'toolbar' : 'inline'} sessionManager={<>{controls}<SessionHeadingActions sessionKey={key} alwaysCollapsed={!!menuActions}><SessionLink session={target} />{menuActions}</SessionHeadingActions></>} defaultDisplayMode="content"
    sessionIdentity={presentedSession} consoleCommands={consoleCommands} onExecuteConsoleCommand={onExecuteConsoleCommand} nativeTakeover={nativeTakeover}
    childrenFor={childrenFor} onOpenChildSession={navigationActions.openChildSession}
    resolveSessionLink={id => inherited?.resolveSessionLink(id) ?? local.resolveSessionLink(id)} revealEntry={inherited?.revealEntry}
    state={displayedState} sessionState={pending ? undefined : sessionState} sessionStatus={pending ? 'connecting' : status} attachingAgentId={operationBinding.source.agentId} actions={safeActions} operationBinding={operationBinding}
    draftSessionKey={key} draftBinding={draftBinding ?? { store: draftStore, key: `session:${key}` }} imageDraftBinding={imageDraftBinding} imageRecipient={pending ? undefined : explicitImageRecipient ?? imageRecipient} questionDrafts={pending ? {} : questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title">{presentedSession.title}</strong>} {...presentation} {...firstInputPresentation}
    visible={visible && presentation?.visible !== false} fixedDisplayMode={fixedDisplayMode} mutationBlocked={mutationBlocked || presentation?.mutationBlocked}
    draftOnly={pending || !nativeIdentityMatches || !!presentation?.draftOnly}
    onPendingInputChange={reportPendingInput} headingStart={<>{familyRoot ? dockHeadingStart : null}{presentation?.headingStart}</>}
    composerNotice={<>{availabilityError ? <p role="alert">{availabilityError} <button type="button" onClick={onRetryAttachment} disabled={!onRetryAttachment}>Retry</button></p> : null}{presentation?.composerNotice}</>} />{renderSessionFooter?.(presentationContext)}</CommunicationNavigationContext.Provider>;
}

function familyDisplayBinding({ displayBinding, target, entries, viewId, windowViewId }: Pick<SessionConversationProps, 'displayBinding' | 'target' | 'entries' | 'viewId' | 'windowViewId'>) {
  return displayBinding && { ...displayBinding, key: target.nativeSessionId === entries[0]?.nativeSessionId
    ? displayBinding.key : (displayBinding.key === viewId || displayBinding.key === windowViewId) ? displayBinding.key : `${displayBinding.key}:${target.nativeSessionId}` };
}

