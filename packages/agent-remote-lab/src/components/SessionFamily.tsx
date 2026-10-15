import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type ComponentProps } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import { CommunicationNavigationContext, type AgentChildSessionView } from '@orchardworks/agent-remote-web/react';
import type { SessionWindowTarget } from '../hooks/useSessionWindows.js';
import { WorkspaceReady } from '../workspace-access.js';
import { ConversationConnectionScope } from '../conversation-connections.js';
import { useWindowSessionBridgeContext } from '../window-session-bridge-context.js';
import { useWindowLayout } from '../window-workspace-context.js';
import { DockResize } from './SessionDock.js';
import './session-family.css';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { useWorkspaceDisplayCache } from '../hooks/useWorkspaceDisplayCache.js';
import { readWorkspaceSnapshot } from '../workspace-cache.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import type { ImageDraftBinding, ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding } from '../draft-store.js';
import { sessionViewNavigation, type SessionViewNavigationActions, type SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { LabWorkbench } from './LabWorkbench.js';
import type { DisplayPreferenceBinding } from '../hooks/useSessionDisplayPreferences.js';
import { SessionViewOperationsContext } from '../session-view-operations.js';

type FamilyTarget = SessionWindowTarget;
interface Layout { children: FamilyTarget[]; focus: number }
interface Props extends Pick<ComponentProps<typeof LabWorkbench>, 'consoleCommands' | 'onExecuteConsoleCommand'> {
  replica?: import('@orchardworks/agent-remote-web').AgentReplica;
  onSessionReady?(session: ReturnType<typeof useConversationSession> | undefined): void;
  attachedSession?: OpenedSession; viewId?: string; nativePrefixOnly?: boolean;
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
  const layout: Layout = shared && rootView ? { children: attached.map(view => view.binding!), focus: Math.max(0, [rootView, ...attached].findIndex(view => view.id === shared.window.selectedViewId)) } : localLayout;
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
    if (shared && rootView) { const view = [rootView, ...attached][index]; if (view && shared.window.selectedViewId !== view.id) shared.operate({ type: 'view.select', viewId: view.id }); return; }
    setLayout(current => current.focus === index ? current : { ...current, focus: index }); }
  function show(index: number) { if (shared && rootView) { focusPane(index); setReveal({ index }); return; } setLayout(current => ({ ...current, focus: index })); setReveal({ index }); }
  function close(index: number) {
    if (shared && rootView) { const view = attached[index - 1]; if (view) shared.operate({ type: 'view.close', viewId: view.id }); setReveal({ index: index - 1 }); return; }
    setLayout(current => ({ children: current.children.slice(0, index - 1), focus: Math.min(current.focus, index - 1) }));
    setReveal({ index: index - 1 });
  }
  function open(index: number, destination: SessionEntry | AgentChildSessionView, childrenFor: (id: string) => readonly AgentChildSessionView[]) {
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
    const descendants = route(path[index]!.nativeSessionId);
    if (!descendants) throw new Error('This subagent is no longer in the session family. Refresh its parent session and retry.');
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
      return <section key={index === 0 ? "root" : sessionKey(item)} className="lab-session-family-pane" aria-label={item.title} hidden={compact && focus !== index || index > 0 && attached[index - 1]?.collapsed}
        style={compact || index === 0 ? undefined : { width: childWidth(item), flex: 'none' }}
        onPointerDownCapture={() => focusPane(index)} onFocusCapture={() => focusPane(index)}>
        {(visited || active || !compact) ? <FamilySession {...props} controls={controls} target={item} entries={path}
          replica={index === 0 ? props.replica : undefined} onSessionReady={index === 0 ? props.onSessionReady : undefined}
          attachedSession={index === 0 ? props.attachedSession : undefined}
          imageRecipient={index === 0 ? props.imageRecipient : undefined}
          consoleCommands={index === 0 ? props.consoleCommands : undefined} onExecuteConsoleCommand={index === 0 ? props.onExecuteConsoleCommand : undefined}
          viewId={index === 0 ? (rootView && sessionBridge?.slotForView(rootView.id)?.id) ?? props.viewId : childSlot?.id}
          displayBinding={index > 0 && attached[index - 1] && props.displayBinding ? { ...props.displayBinding, key: attached[index - 1]!.id } : props.displayBinding}
          draftBinding={index === 0 ? props.draftBinding : childSlot ? { store: props.draftStore, key: childSlot.owners.text.key } : undefined} imageDraftBinding={index === 0 ? props.imageDraftBinding : childSlot?.owners.image}
          onNavigate={(destination, childrenFor) => open(index, destination, childrenFor)} /> : null}
        {!compact && index > 0 ? <DockResize title={item.title} width={childWidth(item)} onResize={width => { const view = attached[index - 1]; if (shared && view) shared.operate({ type: 'view.resize', viewId: view.id, width }); else setWidths(current => ({ ...current, [sessionKey(item)]: width })); }} /> : null}
      </section>;
    })}
  </div>;
}

interface SessionProps extends Props {
  target: FamilyTarget; entries: FamilyTarget[];
  onNavigate(destination: SessionEntry | AgentChildSessionView, childrenFor: (id: string) => readonly AgentChildSessionView[]): void;
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
  const [preview] = useState(() => readWorkspaceSnapshot(baseUrl, target));
  const [session, setSession] = useState<OpenedSession | undefined>(props.attachedSession), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false; const abort = new AbortController(); setError('');
    if (resolutionError) { setError(resolutionError); return; }
    if (props.attachedSession && sessionKey(props.attachedSession) === sessionKey(currentTarget) && !historyRoleId) { setSession(props.attachedSession); return; }
    const cached = connections?.find(currentTarget);
    if (cached && !historyRoleId) { setSession({ ...currentTarget, agentId: cached.agentId }); return () => { stopped = true; abort.abort(); }; }
    const client = new SessionDirectoryClient(baseUrl, undefined, currentTarget.hostId);
    const attachment = currentTarget.parentNativeSessionId
      ? client.attachChild(currentTarget.providerId, currentTarget.parentNativeSessionId, currentTarget.nativeSessionId, abort.signal)
      : historyRoleId ? client.attachHistorical(currentTarget.providerId, currentTarget.nativeSessionId, historyRoleId, abort.signal)
      : client.attach(currentTarget.providerId, currentTarget.nativeSessionId, abort.signal);
    void attachment.then(value => {
      if (stopped) return;
      if (value.nativeSessionId && value.nativeSessionId !== currentTarget.nativeSessionId) throw new Error('The Host returned a different session. Reopen this subagent from its parent.');
      setSession({ ...currentTarget, agentId: value.agentId });
    }).catch(error => { if (!stopped) setError(error instanceof Error ? error.message : 'The session could not be opened.'); });
    return () => { stopped = true; abort.abort(); };
  }, [baseUrl, currentTarget.hostId, currentTarget.providerId, currentTarget.nativeSessionId, currentTarget.parentNativeSessionId, historyRoleId, resolutionError, attempt, connections, enabled, props.attachedSession?.agentId]);
  if (!session && preview) {
    const key = JSON.stringify([target.hostId, target.providerId, target.nativeSessionId]);
    return <LabWorkbench state={preview} sessionStatus="connecting" actions={{}} draftOnly
      conversationPath={<strong className="agent-session-title">{target.title}</strong>} sessionManager={props.controls}
      headingContext={error ? <p role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : undefined}
      draftSessionKey={key} draftBinding={props.draftBinding ?? { store: props.draftStore, key: `session:${key}` }} imageDraftBinding={props.imageDraftBinding}
      displayBinding={familyDisplayBinding(props)} defaultDisplayMode="content" />;
  }
  if (!session) return <div className="lab-session-opening"><header><strong>{target.title}</strong>{props.controls}</header>{error ? <p role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : <p role="status">Opening session…</p>}</div>;
  const pending = !!resolutionError || sessionKey(session) !== sessionKey(currentTarget);
  return <FamilyChat {...props} session={session} pending={pending} preview={preview} availabilityError={resolutionError ?? error} />;
}
function FamilyChat({ session, pending, transport, navigation, draftStore, draftBinding, imageDraftBinding, imageRecipient: explicitImageRecipient, controls, offline, entries, onNavigate, displayBinding, baseUrl, target, preview, viewId, nativePrefixOnly, availabilityError, consoleCommands, onExecuteConsoleCommand, replica, onSessionReady }: SessionProps & { session: OpenedSession; pending: boolean; preview?: AgentReplicaState; availabilityError?: string }) {
  const conversation = useConversationSession(session, transport, replica, pending, { viewId, nativePrefixOnly, externalAttachment: true });
  const { state, sessionState, status, actions, questions, setQuestions, imageRecipient, operationBinding } = conversation;
  useEffect(() => { onSessionReady?.(conversation); return () => onSessionReady?.(undefined); }, [onSessionReady, conversation.sendQueuedInput, actions.sendMessage]);
  const enabled = useContext(WorkspaceReady);
  useWorkspaceDisplayCache(baseUrl, session, state, enabled && status === 'ready');
  const open = (destination: SessionEntry | AgentChildSessionView) => {
    if (offline) throw new Error('The Host is offline. Reconnect it before opening a subagent.');
    onNavigate(destination, childrenFor);
  };
  const navigationActions: SessionViewNavigationActions = {
    openChildSession: async child => open(child), openSession: async target => { open(target); return true; },
  };
  const inherited = navigation?.(session, state, navigationActions);
  const local = sessionViewNavigation({ source: session, state, entries, ...navigationActions });
  const childrenFor = (id: string) => {
    const children = new Map((inherited?.childrenFor(id) ?? []).map(child => [child.nativeSessionId, child]));
    for (const child of local.childrenFor(id)) children.set(child.nativeSessionId, { ...children.get(child.nativeSessionId), ...child });
    return [...children.values()];
  };
  const key = JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);
  return <CommunicationNavigationContext.Provider value={inherited?.communication}><LabWorkbench displayBinding={familyDisplayBinding({ displayBinding, target, entries, viewId })} headingMode="inline" sessionManager={controls} defaultDisplayMode="content"
    consoleCommands={consoleCommands} onExecuteConsoleCommand={onExecuteConsoleCommand}
    childrenFor={childrenFor} onOpenChildSession={navigationActions.openChildSession}
    resolveSessionLink={id => inherited?.resolveSessionLink(id) ?? local.resolveSessionLink(id)} revealEntry={inherited?.revealEntry}
    composerNotice={availabilityError ? <p role="alert">{availabilityError}</p> : undefined}
    state={state?.timeline.initialized ? state : preview ?? state} sessionState={sessionState} sessionStatus={status} attachingAgentId={operationBinding.source.agentId} actions={actions} operationBinding={operationBinding}
    draftSessionKey={key} draftBinding={draftBinding ?? { store: draftStore, key: `session:${key}` }} imageDraftBinding={imageDraftBinding} imageRecipient={explicitImageRecipient ?? imageRecipient} questionDrafts={questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title">{session.title}</strong>} /></CommunicationNavigationContext.Provider>;
}

function familyDisplayBinding({ displayBinding, target, entries, viewId }: Pick<SessionProps, 'displayBinding' | 'target' | 'entries' | 'viewId'>) {
  return displayBinding && { ...displayBinding, key: target.nativeSessionId === entries[0]?.nativeSessionId
    ? displayBinding.key : displayBinding.key === viewId ? displayBinding.key : `${displayBinding.key}:${target.nativeSessionId}` };
}
