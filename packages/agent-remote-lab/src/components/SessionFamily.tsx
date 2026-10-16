import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import { CommunicationNavigationContext, type AgentChildSessionView } from '@orchardworks/agent-remote-web/react';
import type { SessionWindowTarget } from '../hooks/useSessionWindows.js';
import { WorkspaceReady } from '../workspace-access.js';
import { ConversationConnectionScope } from '../conversation-connections.js';
import { useWindowSessionBridgeContext } from '../window-session-bridge-context.js';
import { useWindowLayout, WindowPresentationContext } from '../window-workspace-context.js';
import { DockResize } from './SessionDock.js';
import { SessionLink } from './SessionLink.js';
import { SessionControlNotice } from './SessionControlNotice.js';
import { AgentReplica, sessionHandoffScope, SessionHandoffRejectedError } from '@orchardworks/agent-remote-web';
import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';
import './session-family.css';
import { DirectoryError, SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { readWorkspaceSnapshot, workspaceDisplayState } from '../workspace-cache.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import type { ImageDraftBinding, ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding } from '../draft-store.js';
import { sessionViewNavigation, type SessionViewNavigationActions, type SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { LabWorkbench } from './LabWorkbench.js';
import type { DisplayPreferenceBinding } from '../hooks/useSessionDisplayPreferences.js';
import { SessionViewOperationsContext } from '../session-view-operations.js';

export type FamilySessionPresentationContext = ReturnType<typeof useConversationSession> & {
  session: OpenedSession; viewId?: string; windowViewId?: string;
  conversation: ReturnType<typeof useConversationSession>;
  pending: boolean; offline: boolean; isRoot: boolean; controls?: ReactNode;
};

type FamilyTarget = SessionWindowTarget;
interface Layout { children: FamilyTarget[]; focus: number }
interface Props extends Pick<ComponentProps<typeof LabWorkbench>, 'consoleCommands' | 'onExecuteConsoleCommand'> {
  attachmentManaged?: boolean; attachmentNotice?: ReactNode; sessionIntent?: 'history';
  directoryFor?(hostId: string): SessionDirectoryClient | undefined;
  replica?: import('@orchardworks/agent-remote-web').AgentReplica;
  replicaFor?(agentId: string): import('@orchardworks/agent-remote-web').AgentReplica;
  onSessionBound?(session: OpenedSession, viewId?: string, windowViewId?: string): void;
  onSessionReady?(session: ReturnType<typeof useConversationSession> | undefined): void;
  attachedSession?: OpenedSession; viewId?: string; windowViewId?: string; nativePrefixOnly?: boolean;
  sessionPresentation?(context: FamilySessionPresentationContext): Partial<ComponentProps<typeof LabWorkbench>>;
  renderSessionFooter?(context: FamilySessionPresentationContext): ReactNode;
  storageScope: string; baseUrl: string; target: SessionWindowTarget; hostLabel: string;
  compact: boolean; active: boolean; offline: boolean; controls?: ReactNode;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; draftBinding?: DraftBinding; imageDraftBinding?: ImageDraftBinding; imageRecipient?: ImageDraftRecipient; navigation?: SessionViewNavigationFactory;
  displayBinding?: DisplayPreferenceBinding;
  onAdditionalWidthChange?(width: number): void;
}
function restore(key: string, root: SessionWindowTarget): Layout {
  try {
    const value = JSON.parse(conversationSessionStorage.getItem(key) ?? 'null');
    if (!Array.isArray(value?.children)) return { children: [], focus: 0 };
    const children: FamilyTarget[] = [], seen = new Set([root.nativeSessionId]);
    for (const child of value.children.slice(0, 24)) {
      const parent = children.at(-1) ?? root;
      if (child?.hostId !== root.hostId || child?.providerId !== root.providerId || typeof child?.nativeSessionId !== 'string' || !child.nativeSessionId
        || typeof child.title !== 'string' || child.parentNativeSessionId !== parent.nativeSessionId || seen.has(child.nativeSessionId)) break;
      children.push({ hostId: root.hostId, providerId: root.providerId, nativeSessionId: child.nativeSessionId, title: child.title, parentNativeSessionId: parent.nativeSessionId });
      seen.add(child.nativeSessionId);
    }
    return { children, focus: Number.isInteger(value.focus) ? Math.max(0, Math.min(children.length, value.focus)) : 0 };
  } catch { return { children: [], focus: 0 }; }
}

/** Each session window owns its visible descendant chain, independently of other participants. */
export function SessionFamily(props: Props) {
  const { target, compact, active } = props;
  const storageKey = `agent-remote:recovery:${props.storageScope}:session-family:${props.displayBinding && !props.displayBinding.key.startsWith('session:') ? `${props.displayBinding.key}:` : ''}${sessionKey(target)}`;
  const [layoutKey, setLayoutKey] = useState(storageKey);
  const shared = useWindowLayout();
  const presentedViewId = useContext(WindowPresentationContext) ?? shared?.window.selectedViewId;
  const sessionBridge = useWindowSessionBridgeContext();
  const sharedRootId = shared?.window.views.some(view => view.id === props.viewId) ? props.viewId
    : shared?.resolveViewId?.(props.displayBinding?.key ?? props.viewId ?? '') ?? props.viewId;
  const rootView = shared?.window.views.find(view => view.id === sharedRootId);
  const attached = [] as NonNullable<typeof rootView>[];
  if (shared && rootView) {
    let parent = rootView.id;
    for (;;) { const child = shared.window.views.find(view => view.attachedTo === parent && view.binding); if (!child) break; attached.push(child); parent = child.id; }
  }
  const [localLayout, setLayout] = useState(() => restore(storageKey, target));
  const layout: Layout = shared && rootView ? { children: attached.map(view => view.binding!), focus: Math.max(0, [rootView, ...attached].findIndex(view => view.id === presentedViewId)) } : localLayout;
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(conversationSessionStorage.getItem(`${storageKey}:widths`) ?? '{}') ?? {}; } catch { return {}; }
  });
  if (layoutKey !== storageKey) {
    setLayoutKey(storageKey);
    setLayout(restore(storageKey, target));
    try { setWidths(JSON.parse(conversationSessionStorage.getItem(`${storageKey}:widths`) ?? '{}') ?? {}); } catch { setWidths({}); }
  }
  const childWidth = (item: FamilyTarget) => {
    const width = shared && rootView ? attached.find(view => view.binding?.nativeSessionId === item.nativeSessionId)?.width : widths[sessionKey(item)];
    return typeof width === 'number' && Number.isFinite(width) ? Math.max(shared ? 240 : 320, Math.min(1600, width)) : 440;
  };
  const additionalWidth = layout.children.reduce((total, item, index) => total + (attached[index]?.collapsed ? 0 : childWidth(item)), 0);
  // Commit the outer dock width before revealing a newly inserted descendant.
  useLayoutEffect(() => { props.onAdditionalWidthChange?.(compact ? 0 : additionalWidth); }, [props.onAdditionalWidthChange, compact, additionalWidth]);
  useEffect(() => { if (shared) return; try { conversationSessionStorage.setItem(`${storageKey}:widths`, JSON.stringify(widths)); } catch {} }, [storageKey, widths]);
  const [visited, setVisited] = useState(active || !compact);
  const [reveal, setReveal] = useState<{ index: number }>();
  const container = useRef<HTMLDivElement>(null);
  const path: FamilyTarget[] = [target, ...layout.children];
  const currentPath = useRef(path); currentPath.current = path;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const childRequests = useRef(new Set<{ retry(): void; cancel(): void }>());
  useEffect(() => { for (const request of childRequests.current) request.retry(); }, [props.transport]);
  useEffect(() => () => { for (const request of childRequests.current) request.cancel(); }, []);
  const [openedChildren, setOpenedChildren] = useState<Record<string, OpenedSession>>({});
  const focus = Math.min(layout.focus, path.length - 1);
  useEffect(() => { if (active || !compact) setVisited(true); }, [active, compact]);
  useEffect(() => {
    if (shared) return;
    try { conversationSessionStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* Navigation remains available without storage. */ }
  }, [storageKey, layout]);
  useEffect(() => {
    if (compact || !active || !reveal) return;
    const pane = container.current?.children[reveal.index];
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      if (pane instanceof HTMLElement) pane.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }); });
    return () => cancelAnimationFrame(frame);
  }, [reveal, compact, active]);
  function focusPane(index: number) {
    if (shared && rootView) {
      const view = [rootView, ...attached][index], window = shared.readWindow?.() ?? shared.window;
      if (view && window.selectedViewId !== view.id) shared.operate({ type: 'view.select', viewId: view.id });
      return;
    }
    setLayout(current => current.focus === index ? current : { ...current, focus: index });
  }
  function show(index: number) { if (shared && rootView) { focusPane(index); setReveal({ index }); return; } setLayout(current => ({ ...current, focus: index })); setReveal({ index }); }
  function close(index: number) {
    if (shared && rootView) { const view = attached[index - 1]; if (view) shared.operate({ type: 'view.close', viewId: view.id }); setReveal({ index: index - 1 }); return; }
    setLayout(current => ({ children: current.children.slice(0, index - 1), focus: Math.min(current.focus, index - 1) }));
    setReveal({ index: index - 1 });
  }
  async function open(index: number, destination: SessionEntry | AgentChildSessionView, childrenFor: (id: string) => readonly AgentChildSessionView[], source: OpenedSession) {
    const parentIdentity = sessionKey(source);
    const sourceCurrent = () => mounted.current && !!currentPath.current[index] && sessionKey(currentPath.current[index]!) === parentIdentity;
    if (!sourceCurrent()) throw new Error('The source session changed before its subagent could be opened.');
    if (('providerId' in destination && destination.providerId !== target.providerId)
      || ('hostId' in destination && (destination.hostId ?? 'local') !== target.hostId)) {
      throw new Error('This session belongs to a different Host or Provider.');
    }
    const existing = path.findIndex(item => item.nativeSessionId === destination.nativeSessionId);
    if (existing >= 0) { show(existing); return; }
    const seen = new Set<string>();
    function route(parent: string): FamilyTarget[] | undefined {
      if (seen.has(parent) || seen.size >= 256) return undefined;
      seen.add(parent);
      for (const child of childrenFor(parent)) {
        const entry = { ...target, nativeSessionId: child.nativeSessionId, title: child.title, parentNativeSessionId: parent };
        if (child.nativeSessionId === destination.nativeSessionId) return [entry];
        const rest = route(child.nativeSessionId);
        if (rest) return [entry, ...rest];
      }
      return undefined;
    }
    const descendants = route(source.nativeSessionId) ?? (!('providerId' in destination) ? [{ ...target, nativeSessionId: destination.nativeSessionId, title: destination.title, parentNativeSessionId: source.nativeSessionId }] : undefined);
    if (!descendants) throw new Error('This subagent is no longer in the session family. Refresh its parent session and retry.');
    const directory = props.directoryFor?.(source.hostId ?? 'local') ?? new SessionDirectoryClient(props.baseUrl, undefined, source.hostId);
    const destinationTarget = descendants.at(-1)!;
    const value = await new Promise<Awaited<ReturnType<SessionDirectoryClient['attachChild']>>>((resolve, reject) => {
      let generation = 0;
      const request = {
        retry() {
          const current = ++generation;
          void directory.attachChild(source.providerId, destinationTarget.parentNativeSessionId!, destinationTarget.nativeSessionId).then(value => {
            if (current !== generation) return;
            childRequests.current.delete(request); resolve(value);
          }, error => { if (current === generation) { childRequests.current.delete(request); reject(error); } });
        },
        cancel() { generation++; childRequests.current.delete(request); reject(new Error('The source session view was closed.')); },
      };
      childRequests.current.add(request); request.retry();
    });
    if (!sourceCurrent()) throw new Error('The source session changed while its subagent was opening.');
    if (value.nativeSessionId && value.nativeSessionId !== destinationTarget.nativeSessionId) throw new Error('The Host returned a different child session.');
    setOpenedChildren(current => ({ ...current, [sessionKey(destinationTarget)]: { ...destinationTarget, agentId: value.agentId } }));
    const children = [...path.slice(1, index + 1), ...descendants];
    if (shared && rootView) {
      const operations: import('@orchardworks/agent-remote-protocol').WindowEdit[] = [];
      if (attached[index]) operations.push({ type: 'view.close', viewId: attached[index]!.id });
      let parent = index === 0 ? rootView.id : attached[index - 1]!.id;
      for (const binding of descendants) {
        const id = `child-${crypto.randomUUID()}`;
        operations.push({ type: 'view.create', view: { id, binding, attachedTo: parent, placement: 'attached', width: 440, collapsed: false, display: { mode: 'content', lettersVisible: true } } });
        parent = id;
      }
      operations.push({ type: 'view.select', viewId: parent });
      shared.operate({ type: 'batch', operations }); setReveal({ index: children.length }); return;
    }
    setLayout({ children, focus: children.length }); setReveal({ index: children.length });
  }
  return <div className="lab-session-family" ref={container} hidden={!active} aria-label={`${target.title} session family`}>
    {path.map((item, index) => {
      const childSlot = index > 0 && attached[index - 1] ? sessionBridge?.slotForView(attached[index - 1]!.id) : undefined;
      const controls = index === 0 ? props.controls : <button type="button" aria-label={compact ? `Back to ${path[index - 1]!.title}` : 'Close subagent'} title={compact ? 'Back to parent session' : 'Close subagent view'} onClick={() => compact ? show(index - 1) : close(index)}>{compact ? '←' : '×'}</button>;
      return <section key={index === 0 ? "root" : sessionKey(item)} className={`lab-session-family-pane lab-session-composition${shared && rootView?.placement === 'primary' ? index === 0 ? ' lab-primary-conversation' : ' lab-side-conversation' : ''}`} aria-label={item.title} hidden={compact && focus !== index || index > 0 && attached[index - 1]?.collapsed}
        style={compact ? undefined : index === 0 ? rootView ? { width: rootView.placement === 'float' ? '100%' : rootView.width, minWidth: rootView.placement === 'float' ? 0 : 240, flex: 'none' } : undefined : { width: childWidth(item), minWidth: shared ? 240 : 320, flex: 'none' }}
        onPointerDownCapture={event => { if (!(event.target as Element).closest('[data-pane-selection-ignore],.lab-conversation-history,.lab-session-heading-actions-trigger,.lab-timeline-tools-toggle,.lab-session-main-minimize')) focusPane(index); }} onFocusCapture={event => { if (!(event.target as Element).closest('[data-pane-selection-ignore],.lab-conversation-history,.lab-session-heading-actions-trigger,.lab-timeline-tools-toggle,.lab-session-main-minimize')) focusPane(index); }}>
        {(visited || active || !compact) ? <FamilySession {...props} familyRoot={index === 0} controls={controls} target={item} entries={path}
          replica={index === 0 ? props.replica : undefined} onSessionReady={index === 0 ? props.onSessionReady : undefined}
          attachedSession={index === 0 ? props.attachedSession : openedChildren[sessionKey(item)]}
          attachmentManaged={index === 0 ? props.attachmentManaged : undefined} attachmentNotice={index === 0 ? props.attachmentNotice : undefined}
          imageRecipient={index === 0 ? props.imageRecipient : undefined}
          consoleCommands={index === 0 ? props.consoleCommands : undefined} onExecuteConsoleCommand={index === 0 ? props.onExecuteConsoleCommand : undefined}
          viewId={index === 0 ? (rootView && sessionBridge?.slotForView(rootView.id)?.id) ?? props.viewId : childSlot?.id}
          windowViewId={index === 0 ? rootView?.id ?? props.windowViewId : attached[index - 1]?.id}
          displayBinding={index > 0 && attached[index - 1] && props.displayBinding ? { ...props.displayBinding, key: attached[index - 1]!.id } : props.displayBinding}
          draftBinding={index === 0 ? props.draftBinding : childSlot ? { store: props.draftStore, key: childSlot.owners.text.key } : undefined} imageDraftBinding={index === 0 ? props.imageDraftBinding : childSlot?.owners.image}
          onNavigate={(destination, childrenFor, source) => open(index, destination, childrenFor, source)} /> : null}
        {!compact && index > 0 ? <DockResize title={item.title} width={childWidth(item)} onResize={width => { const view = attached[index - 1]; if (shared && view) shared.operate({ type: 'view.resize', viewId: view.id, width }); else setWidths(current => ({ ...current, [sessionKey(item)]: width })); }} /> : null}
      </section>;
    })}
  </div>;
}

interface SessionProps extends Props {
  familyRoot: boolean;
  target: FamilyTarget; entries: FamilyTarget[];
  onNavigate(destination: SessionEntry | AgentChildSessionView, childrenFor: (id: string) => readonly AgentChildSessionView[], source: OpenedSession): Promise<void>;
}
function FamilySession(props: SessionProps) {
  const { target, baseUrl } = props;
  const operations = useContext(SessionViewOperationsContext);
  let currentTarget = target, historyRoleId: string | undefined, resolutionError: string | undefined;
  try {
    const resolved = operations?.resolveTarget(target, { viewId: props.viewId, nativePrefixOnly: props.nativePrefixOnly });
    if (resolved) { currentTarget = { ...target, ...resolved.target, hostId: resolved.target.hostId ?? 'local' }; historyRoleId = resolved.historyRoleId; }
  } catch (error) { resolutionError = error instanceof Error ? error.message : 'The current session locator is unavailable.'; }
  const connections = useContext(ConversationConnectionScope);
  const enabled = useContext(WorkspaceReady);
  const preview = useMemo(() => readWorkspaceSnapshot(baseUrl, currentTarget), [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId]);
  const localDirectory = useMemo(() => new SessionDirectoryClient(baseUrl, undefined, currentTarget.hostId), [baseUrl, currentTarget.hostId]);
  const directory = props.directoryFor?.(currentTarget.hostId) ?? localDirectory;
  const [session, setSession] = useState<OpenedSession | undefined>(props.attachedSession), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  const targetKey = sessionKey(currentTarget);
  const [nativeOwner, setNativeOwner] = useState<{ targetKey: string; owner: NativeSessionOwner }>();
  const owner = nativeOwner?.targetKey === targetKey ? nativeOwner.owner : undefined;
  const handoff = sessionHandoffScope(props.transport).forTarget(targetKey);
  const [, refreshHandoff] = useState(0);
  useEffect(() => handoff.subscribe(() => refreshHandoff(value => value + 1)), [handoff]);
  const availability = useRef({ targetKey, enabled, offline: props.offline });
  availability.current = { targetKey, enabled, offline: props.offline };
  const nativeTakeover = props.attachmentManaged ? props.attachmentNotice : owner ? <><SessionControlNotice control={{ access: 'read_only', available: false, nativeOwner: owner }}
    connected={enabled && !props.offline} handoff={handoff.getState(owner.generation)} onTakeControl={async options => {
      try { await handoff.run(owner.generation, async progress => {
        if (!availability.current.enabled || availability.current.offline || availability.current.targetKey !== targetKey)
          throw new SessionHandoffRejectedError('Workspace access is restoring or the session changed.');
        const value = await directory.attach(currentTarget.providerId, currentTarget.nativeSessionId, undefined, progress.checkOnly ? undefined : owner.generation);
        progress.onRestoring();
        if (availability.current.targetKey !== targetKey) throw new Error('Session navigation changed before native restoration was confirmed.');
        if (value.nativeSessionId && value.nativeSessionId !== currentTarget.nativeSessionId) throw new Error('The Host returned a different session.');
        const restored = { ...currentTarget, agentId: value.agentId };
        const lease = connections?.acquire(value.agentId, props.replicaFor?.(value.agentId) ?? new AgentReplica(), restored);
        setSession(restored); setError('');
        try { await lease?.client.takeControlAfterNativeResume(); } finally { lease?.release(); }
      }, options); } catch (failure) { setError(failure instanceof Error ? failure.message : 'The session could not be restored.'); throw failure; }
      setNativeOwner(current => current?.targetKey === targetKey && current.owner.generation === owner.generation ? undefined : current);
    }} />{error ? <p role="alert">{error}</p> : null}</> : undefined;
  useEffect(() => {
    if (props.attachmentManaged) {
      setError(''); setNativeOwner(undefined);
      if (props.attachedSession && sessionKey(props.attachedSession) === targetKey) setSession(props.attachedSession);
      return;
    }
    if (!enabled) return;
    let stopped = false; const abort = new AbortController(); setError('');
    if (resolutionError) { setError(resolutionError); return; }
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
      if (stopped) return;
      if (value.nativeSessionId && value.nativeSessionId !== currentTarget.nativeSessionId) throw new Error('The Host returned a different session. Reopen this subagent from its parent.');
      setSession({ ...currentTarget, agentId: value.agentId }); setNativeOwner(undefined);
    }).catch(error => { if (!stopped) { setError(error instanceof DirectoryError && error.nativeOwner ? '' : error instanceof Error ? error.message : 'The session could not be opened.'); setNativeOwner(error instanceof DirectoryError && error.nativeOwner ? { targetKey, owner: error.nativeOwner } : undefined); } });
    return () => { stopped = true; abort.abort(); };
  }, [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId, currentTarget.parentNativeSessionId, historyRoleId, resolutionError, attempt, connections, enabled, directory, props.attachedSession?.agentId, props.attachmentManaged]);
  const displayedSession = session && sessionKey(session) === targetKey ? session : undefined;
  const pending = !!resolutionError || !displayedSession;
  return <FamilyChat {...props} session={session ?? { ...currentTarget, agentId: '' }} attachmentAvailable={!!session} target={currentTarget} pending={pending} preview={preview} availabilityError={owner ? undefined : resolutionError ?? error} nativeTakeover={nativeTakeover} />;
}
function FamilyChat({ session, pending, transport, navigation, draftStore, draftBinding, imageDraftBinding, imageRecipient: explicitImageRecipient, controls, offline, entries, onNavigate, displayBinding, baseUrl, target, preview, viewId, nativePrefixOnly, availabilityError, consoleCommands, onExecuteConsoleCommand, replica, replicaFor, onSessionReady, onSessionBound, windowViewId, sessionPresentation, renderSessionFooter, familyRoot, nativeTakeover, sessionIntent, attachmentAvailable }: SessionProps & { nativeTakeover?: ReactNode; attachmentAvailable: boolean; session: OpenedSession; pending: boolean; preview?: AgentReplicaState; availabilityError?: string }) {
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
    ...conversation, session: presentedSession, viewId, windowViewId, conversation, pending, offline, controls, isRoot: familyRoot,
    actions: safeActions,
    state: displayedState,
    imageRecipient: explicitImageRecipient ?? imageRecipient,
  };
  const presentation = sessionPresentation?.(presentationContext);
  return <CommunicationNavigationContext.Provider value={inherited?.communication}><LabWorkbench displayBinding={familyDisplayBinding({ displayBinding, target, entries, viewId, windowViewId })} headingMode="inline" sessionManager={<><SessionLink session={target} />{controls}</>} defaultDisplayMode="content"
    sessionIdentity={presentedSession} consoleCommands={consoleCommands} onExecuteConsoleCommand={onExecuteConsoleCommand} nativeTakeover={nativeTakeover}
    childrenFor={childrenFor} onOpenChildSession={navigationActions.openChildSession}
    resolveSessionLink={id => inherited?.resolveSessionLink(id) ?? local.resolveSessionLink(id)} revealEntry={inherited?.revealEntry}
    composerNotice={availabilityError ? <p role="alert">{availabilityError}</p> : undefined}
    state={displayedState} sessionState={pending ? undefined : sessionState} sessionStatus={pending ? 'connecting' : status} attachingAgentId={operationBinding.source.agentId} actions={safeActions} draftOnly={pending || !nativeIdentityMatches} operationBinding={operationBinding}
    draftSessionKey={key} draftBinding={draftBinding ?? { store: draftStore, key: `session:${key}` }} imageDraftBinding={imageDraftBinding} imageRecipient={pending ? undefined : explicitImageRecipient ?? imageRecipient} questionDrafts={pending ? {} : questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title">{presentedSession.title}</strong>} {...presentation} />{renderSessionFooter?.(presentationContext)}</CommunicationNavigationContext.Provider>;
}

function familyDisplayBinding({ displayBinding, target, entries, viewId, windowViewId }: Pick<SessionProps, 'displayBinding' | 'target' | 'entries' | 'viewId' | 'windowViewId'>) {
  return displayBinding && { ...displayBinding, key: target.nativeSessionId === entries[0]?.nativeSessionId
    ? displayBinding.key : (displayBinding.key === viewId || displayBinding.key === windowViewId) ? displayBinding.key : `${displayBinding.key}:${target.nativeSessionId}` };
}
