import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentReplicaState, RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import { CommunicationNavigationContext, type AgentChildSessionView } from '@orchardworks/agent-remote-web/react';
import type { SessionWindowTarget } from '../hooks/useSessionWindows.js';
import { WorkspaceReady } from '../workspace-access.js';
import { ConversationConnectionScope } from '../conversation-connections.js';
import { DockResize } from './SessionDock.js';
import './session-family.css';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { useWorkspaceDisplayCache } from '../hooks/useWorkspaceDisplayCache.js';
import { readWorkspaceSnapshot } from '../workspace-cache.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import type { ImageDraftBinding } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding } from '../draft-store.js';
import { sessionViewNavigation, type SessionViewNavigationActions, type SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { LabWorkbench } from './LabWorkbench.js';
import type { DisplayPreferenceBinding } from '../hooks/useSessionDisplayPreferences.js';

type FamilyTarget = SessionWindowTarget;
interface Layout { children: FamilyTarget[]; focus: number }
interface Props {
  storageScope: string; baseUrl: string; target: SessionWindowTarget; hostLabel: string;
  compact: boolean; active: boolean; offline: boolean; controls?: ReactNode;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; draftBinding?: DraftBinding; imageDraftBinding?: ImageDraftBinding; navigation?: SessionViewNavigationFactory;
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
  const [layout, setLayout] = useState(() => restore(storageKey, target));
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(conversationSessionStorage.getItem(`${storageKey}:widths`) ?? '{}') ?? {}; } catch { return {}; }
  });
  const childWidth = (item: FamilyTarget) => {
    const width = widths[sessionKey(item)];
    return typeof width === 'number' && Number.isFinite(width) ? Math.max(320, Math.min(1600, width)) : 440;
  };
  const additionalWidth = layout.children.reduce((total, item) => total + childWidth(item), 0);
  // Commit the outer dock width before revealing a newly inserted descendant.
  useLayoutEffect(() => { props.onAdditionalWidthChange?.(compact ? 0 : additionalWidth); }, [props.onAdditionalWidthChange, compact, additionalWidth]);
  useEffect(() => { try { conversationSessionStorage.setItem(`${storageKey}:widths`, JSON.stringify(widths)); } catch {} }, [storageKey, widths]);
  const [visited, setVisited] = useState(active || !compact);
  const [reveal, setReveal] = useState<{ index: number }>();
  const container = useRef<HTMLDivElement>(null);
  const path: FamilyTarget[] = [target, ...layout.children];
  const focus = Math.min(layout.focus, path.length - 1);
  useEffect(() => { if (active || !compact) setVisited(true); }, [active, compact]);
  useEffect(() => {
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
  function focusPane(index: number) { setLayout(current => current.focus === index ? current : { ...current, focus: index }); }
  function show(index: number) { setLayout(current => ({ ...current, focus: index })); setReveal({ index }); }
  function close(index: number) {
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
    setLayout({ children, focus: children.length }); setReveal({ index: children.length });
  }
  return <div className="lab-session-family" ref={container} hidden={!active} aria-label={`${target.title} session family`}>
    {path.map((item, index) => {
      const controls = index === 0 ? props.controls : <button type="button" aria-label={compact ? `Back to ${path[index - 1]!.title}` : 'Close subagent'} title={compact ? 'Back to parent session' : 'Close subagent view'} onClick={() => compact ? show(index - 1) : close(index)}>{compact ? '←' : '×'}</button>;
      return <section key={sessionKey(item)} className="lab-session-family-pane" aria-label={item.title} hidden={compact && focus !== index}
        style={compact || index === 0 ? undefined : { width: childWidth(item), flex: 'none' }}
        onPointerDownCapture={() => focusPane(index)} onFocusCapture={() => focusPane(index)}>
        {(visited || active || !compact) ? <FamilySession {...props} controls={controls} target={item} entries={path}
          draftBinding={index === 0 ? props.draftBinding : undefined} imageDraftBinding={index === 0 ? props.imageDraftBinding : undefined}
          onNavigate={(destination, childrenFor) => open(index, destination, childrenFor)} /> : null}
        {!compact && index > 0 ? <DockResize title={item.title} width={childWidth(item)} onResize={width => setWidths(current => ({ ...current, [sessionKey(item)]: width }))} /> : null}
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
  const connections = useContext(ConversationConnectionScope);
  const enabled = useContext(WorkspaceReady);
  const [preview] = useState(() => readWorkspaceSnapshot(baseUrl, target));
  const [session, setSession] = useState<OpenedSession>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false; const abort = new AbortController(); setError('');
    const cached = connections?.find(target);
    if (cached) { setSession({ ...target, agentId: cached.agentId }); return () => { stopped = true; abort.abort(); }; }
    setSession(undefined);
    const client = new SessionDirectoryClient(baseUrl, undefined, target.hostId);
    const attachment = target.parentNativeSessionId
      ? client.attachChild(target.providerId, target.parentNativeSessionId, target.nativeSessionId, abort.signal)
      : client.attach(target.providerId, target.nativeSessionId, abort.signal);
    void attachment.then(value => {
      if (stopped) return;
      if (value.nativeSessionId && value.nativeSessionId !== target.nativeSessionId) throw new Error('The Host returned a different session. Reopen this subagent from its parent.');
      setSession({ ...target, agentId: value.agentId });
    }).catch(error => { if (!stopped) setError(error instanceof Error ? error.message : 'The session could not be opened.'); });
    return () => { stopped = true; abort.abort(); };
  }, [baseUrl, target.hostId, target.providerId, target.nativeSessionId, target.parentNativeSessionId, attempt, connections, enabled]);
  if (!session && preview) {
    const key = JSON.stringify([target.hostId, target.providerId, target.nativeSessionId]);
    return <LabWorkbench state={preview} sessionStatus="connecting" actions={{}} draftOnly
      conversationPath={<strong className="agent-session-title">{target.title}</strong>} sessionManager={props.controls}
      headingContext={error ? <p role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : undefined}
      draftSessionKey={key} draftBinding={props.draftBinding ?? { store: props.draftStore, key: `session:${key}` }} imageDraftBinding={props.imageDraftBinding}
      displayBinding={familyDisplayBinding(props)} defaultDisplayMode="content" />;
  }
  if (!session) return <div className="lab-session-opening"><header><strong>{target.title}</strong>{props.controls}</header>{error ? <p role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : <p role="status">Opening session…</p>}</div>;
  return <FamilyChat {...props} session={session} preview={preview} />;
}
function FamilyChat({ session, transport, navigation, draftStore, draftBinding, imageDraftBinding, controls, offline, entries, onNavigate, displayBinding, baseUrl, target, preview }: SessionProps & { session: OpenedSession; preview?: AgentReplicaState }) {
  const { state, sessionState, status, actions, questions, setQuestions, imageRecipient } = useConversationSession(session, transport);
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
  return <CommunicationNavigationContext.Provider value={inherited?.communication}><LabWorkbench displayBinding={familyDisplayBinding({ displayBinding, target, entries })} headingMode="inline" sessionManager={controls} defaultDisplayMode="content"
    childrenFor={childrenFor} onOpenChildSession={navigationActions.openChildSession}
    resolveSessionLink={id => inherited?.resolveSessionLink(id) ?? local.resolveSessionLink(id)} revealEntry={inherited?.revealEntry}
    state={state?.timeline.initialized ? state : preview ?? state} sessionState={sessionState} sessionStatus={status} attachingAgentId={session.agentId} actions={actions}
    draftSessionKey={key} draftBinding={draftBinding ?? { store: draftStore, key: `session:${key}` }} imageDraftBinding={imageDraftBinding} imageRecipient={imageRecipient} questionDrafts={questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title">{session.title}</strong>} /></CommunicationNavigationContext.Provider>;
}

function familyDisplayBinding({ displayBinding, target, entries }: Pick<SessionProps, 'displayBinding' | 'target' | 'entries'>) {
  return displayBinding && { ...displayBinding, key: target.nativeSessionId === entries[0]?.nativeSessionId
    ? displayBinding.key : `${displayBinding.key}:${target.nativeSessionId}` };
}
