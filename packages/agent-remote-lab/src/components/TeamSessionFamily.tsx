import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web/headless';
import { CommunicationNavigationContext, type AgentChildSessionView } from '@orchardworks/agent-remote-web/react';
import type { TeamSource } from '@orchardworks/agent-remote-protocol';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import type { DraftBinding } from '../draft-store.js';
import { sessionViewNavigation, type SessionViewNavigationActions, type SessionViewNavigationFactory } from '../session-view-navigation.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { LabWorkbench } from './LabWorkbench.js';

interface FamilyTarget extends TeamSource { parentNativeSessionId?: string }
interface Layout { children: FamilyTarget[]; focus: number }
interface Props {
  id: string; storageScope: string; baseUrl: string; target: TeamSource; label: string; hostLabel: string;
  compact: boolean; active: boolean; readOnly: boolean; offline: boolean; ready: boolean;
  header?: ReactNode; unavailable?: ReactNode;
  transport: RemoteAgentTransport; draftStore: DraftBinding['store']; navigation?: SessionViewNavigationFactory;
  widths: Record<string, number>; resize(id: string, width: number): void; saveWidths(): void;
}
function restore(key: string, root: TeamSource): Layout {
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

/** Each Team participant owns its visible descendant chain, independently of other participants. */
export function TeamSessionFamily(props: Props) {
  const { target, compact, active, label } = props;
  const storageKey = `agent-remote:team-family:${props.storageScope}:${props.id}:${sessionKey(target)}`;
  const [layout, setLayout] = useState(() => restore(storageKey, target));
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
    if (pane instanceof HTMLElement) pane.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
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
  return <div className="lab-team-family" ref={container} hidden={!active} aria-label={`${label} session family`}>
    {path.map((item, index) => {
      const title = index === 0 ? label : item.title;
      const widthKey = index === 0 ? props.id : `${props.id}:${sessionKey(item)}`;
      const preferredWidth = props.widths[widthKey];
      const width = typeof preferredWidth === 'number' && Number.isFinite(preferredWidth) ? Math.max(320, Math.min(1400, preferredWidth)) : 480;
      return <section key={sessionKey(item)} className="lab-team-pane" aria-label={title} hidden={compact && focus !== index} style={compact ? undefined : { width }}
        onPointerDownCapture={() => focusPane(index)} onFocusCapture={() => focusPane(index)}>
        <header className="lab-team-pane-heading"><strong>{title}</strong><small>{props.hostLabel}{props.offline ? ' · Offline' : ''}</small>
          {index > 0 ? <button type="button" className="lab-team-child-close" aria-label={compact ? `Back to ${index === 1 ? label : path[index - 1]!.title}` : 'Close subagent'} title={compact ? 'Back to parent session' : 'Close subagent view'} onClick={() => compact ? show(index - 1) : close(index)}>{compact ? '←' : '×'}</button> : null}
        </header>
        {index === 0 ? props.header : null}
        {!props.ready ? (index === 0 ? props.unavailable : null) : (visited || active || !compact) ? <FamilySession {...props} target={item} entries={path}
          onNavigate={(destination, childrenFor) => open(index, destination, childrenFor)} /> : null}
        {!compact ? <div className="lab-session-dock-resize" role="separator" aria-label={`Resize ${title}`} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={320} aria-valuemax={1400} tabIndex={0}
          onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.dataset.origin = `${event.clientX}:${width}`; }}
          onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const [start, size] = event.currentTarget.dataset.origin!.split(':').map(Number); props.resize(widthKey, size! + event.clientX - start!); }}
          onPointerUp={event => { event.currentTarget.releasePointerCapture(event.pointerId); props.saveWidths(); }}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); props.resize(widthKey, width + (event.key === 'ArrowLeft' ? -32 : 32)); } }} onBlur={props.saveWidths} /> : null}
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
  const [session, setSession] = useState<OpenedSession>(), [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false; const abort = new AbortController(); setError(''); setSession(undefined);
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
  }, [baseUrl, target.hostId, target.providerId, target.nativeSessionId, target.parentNativeSessionId, attempt]);
  if (!session) return <div className="lab-team-opening">{error ? <p role="alert">{error}<button onClick={() => setAttempt(value => value + 1)}>Retry</button></p> : <p role="status">Opening session…</p>}</div>;
  return <FamilyChat {...props} session={session} />;
}
function FamilyChat({ session, transport, navigation, draftStore, readOnly, offline, entries, onNavigate }: SessionProps & { session: OpenedSession }) {
  const { state, sessionState, status, actions, questions, setQuestions } = useConversationSession(session, transport);
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
  return <CommunicationNavigationContext.Provider value={inherited?.communication}><LabWorkbench readOnly={readOnly} headingMode="toolbar" defaultDisplayMode="content"
    childrenFor={childrenFor} onOpenChildSession={navigationActions.openChildSession}
    resolveSessionLink={id => inherited?.resolveSessionLink(id) ?? local.resolveSessionLink(id)} revealEntry={inherited?.revealEntry}
    state={state} sessionState={sessionState} sessionStatus={status} attachingAgentId={session.agentId} actions={actions}
    draftSessionKey={key} draftBinding={{ store: draftStore, key: `team:${key}` }} questionDrafts={questions}
    onQuestionDraftChange={(id, value) => setQuestions(current => ({ ...current, [id]: value }))}
    conversationPath={<strong className="agent-session-title">{session.title}</strong>} /></CommunicationNavigationContext.Provider>;
}
