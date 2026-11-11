import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { AgentChildSessionView } from '@orchardworks/agent-remote-web/react';
import { isBotView } from '@orchardworks/agent-remote-protocol';
import type { SessionWindowTarget } from '../hooks/useSessionWindows.js';
import { useWindowSessionBridgeContext } from '../window-session-bridge-context.js';
import { useWindowLayout, WindowPresentationContext } from '../window-workspace-context.js';
import { DockResize, useSessionDockHeadingStart } from './SessionDock.js';
import { SessionTitleInteractionContext } from './SessionTitleInteraction.js';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { conversationSessionStorage } from '../conversation-storage.js';
import { windowSessionBinding } from '../window-workspace.js';
import { sessionKey, type SessionEntry } from '../session-tree.js';
import { SessionConversation, type SessionConversationProps } from './SessionConversation.js';
import { allowsWindowPaneSelection, SessionConversationMount } from './SessionConversationSurfaces.js';
import './session-family.css';
export type { FamilySessionPresentationContext } from './SessionConversation.js';

type FamilyTarget = SessionWindowTarget;
interface Layout { children: FamilyTarget[]; focus: number }
interface Props extends Omit<SessionConversationProps, 'familyRoot' | 'entries' | 'onNavigate'> {
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

/** Each session window owns its visible descendants, independently of other participants. */
export function SessionFamily(props: Props) {
  const { target, compact, active } = props;
  const titleInteraction = useContext(SessionTitleInteractionContext);
  const dockHeadingStart = useSessionDockHeadingStart();
  const storageKey = `agent-remote:recovery:${props.storageScope}:session-family:${props.displayBinding && !props.displayBinding.key.startsWith('session:') ? `${props.displayBinding.key}:` : ''}${sessionKey(target)}`;
  const [layoutKey, setLayoutKey] = useState(storageKey);
  const shared = useWindowLayout();
  const presentedViewId = useContext(WindowPresentationContext) ?? shared?.window.selectedViewId;
  const sessionBridge = useWindowSessionBridgeContext();
  const sharedRootId = shared?.window.views.some(view => view.id === props.viewId) ? props.viewId
    : shared?.resolveViewId?.(props.displayBinding?.key ?? props.viewId ?? '') ?? props.viewId;
  const rootView = shared?.window.views.find(view => view.id === sharedRootId);
  // Attached views follow their source in Window order, so one pass finds every descendant, including several per source.
  const attached = [] as NonNullable<typeof rootView>[];
  if (shared && rootView) {
    const family = new Set([rootView.id]);
    for (const view of shared.window.views) if (view.attachedTo && family.has(view.attachedTo) && view.binding) { family.add(view.id); attached.push(view); }
  }
  const panes = rootView ? [rootView, ...attached] : [];
  const currentPanes = useRef(panes); currentPanes.current = panes;
  const [localLayout, setLayout] = useState(() => restore(storageKey, target));
  const layout: Layout = shared && rootView ? { children: attached.map(view => view.binding!), focus: Math.max(0, panes.findIndex(view => view.id === presentedViewId)) } : localLayout;
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(conversationSessionStorage.getItem(`${storageKey}:widths`) ?? '{}') ?? {}; } catch { return {}; }
  });
  if (layoutKey !== storageKey) {
    setLayoutKey(storageKey);
    setLayout(restore(storageKey, target));
    try { setWidths(JSON.parse(conversationSessionStorage.getItem(`${storageKey}:widths`) ?? '{}') ?? {}); } catch { setWidths({}); }
  }
  const childWidth = (item: FamilyTarget, index: number) => {
    const width = shared && rootView ? attached[index - 1]?.width : widths[sessionKey(item)];
    return typeof width === 'number' && Number.isFinite(width) ? Math.max(shared ? 240 : 320, Math.min(1600, width)) : 440;
  };
  const additionalWidth = layout.children.reduce((total, item, index) => total + (attached[index]?.collapsed ? 0 : childWidth(item, index + 1)), 0);
  // Commit the outer dock width before revealing a newly inserted descendant.
  useLayoutEffect(() => { props.onAdditionalWidthChange?.(compact ? 0 : additionalWidth); }, [props.onAdditionalWidthChange, compact, additionalWidth]);
  useEffect(() => { if (shared) return; try { conversationSessionStorage.setItem(`${storageKey}:widths`, JSON.stringify(widths)); } catch {} }, [storageKey, widths]);
  const [visited, setVisited] = useState(active || !compact);
  const [reveal, setReveal] = useState<{ index: number } | { viewId: string }>();
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
  // A view revealed by its identity may render after the request; reveal it once it is shown.
  const revealIndex = !reveal ? -1 : 'viewId' in reveal ? panes.findIndex(view => view.id === reveal.viewId) : reveal.index;
  const revealShown = revealIndex >= 0;
  useEffect(() => {
    if (compact || !active || !revealShown) return;
    const pane = container.current?.children[revealIndex];
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      if (pane instanceof HTMLElement) pane.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }); });
    return () => cancelAnimationFrame(frame);
  }, [reveal, revealShown, compact, active]);
  /** The pane of an attached view's own source; a local family is one chain. */
  function parentIndex(index: number) {
    const source = attached[index - 1]?.attachedTo;
    const found = source ? panes.findIndex(view => view.id === source) : -1;
    return found >= 0 ? found : index - 1;
  }
  function focusPane(index: number) {
    if (shared && rootView) {
      const view = panes[index], window = shared.readWindow?.() ?? shared.window;
      if (view && window.selectedViewId !== view.id) shared.operate({ type: 'view.select', viewId: view.id });
      return;
    }
    setLayout(current => current.focus === index ? current : { ...current, focus: index });
  }
  function show(index: number) { if (shared && rootView) { focusPane(index); setReveal({ index }); return; } setLayout(current => ({ ...current, focus: index })); setReveal({ index }); }
  function close(index: number) {
    if (shared && rootView) { const view = attached[index - 1]; if (view) shared.operate({ type: 'view.close', viewId: view.id }); setReveal({ index: parentIndex(index) }); return; }
    setLayout(current => ({ children: current.children.slice(0, index - 1), focus: Math.min(current.focus, index - 1) }));
    setReveal({ index: index - 1 });
  }
  async function open(index: number, destination: SessionEntry | AgentChildSessionView, childrenFor: (id: string) => readonly AgentChildSessionView[], source: OpenedSession) {
    const parentIdentity = sessionKey(source);
    // A shared source is its pane, which keeps its identity while sibling panes open or close.
    const sourceViewId = panes[index]?.id;
    const sourceCurrent = () => mounted.current && (sourceViewId
      ? currentPanes.current.some(view => view.id === sourceViewId && !!view.binding && sessionKey(view.binding) === parentIdentity)
      : !!currentPath.current[index] && sessionKey(currentPath.current[index]!) === parentIdentity);
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
    const opened = (current: Record<string, OpenedSession>) => ({ ...current, [sessionKey(destinationTarget)]: { ...destinationTarget, agentId: value.agentId } });
    if (shared && sourceViewId) {
      // The Window store renders the new pane synchronously; it must already see the attached session, or it attaches again.
      flushSync(() => setOpenedChildren(opened));
      // The source keeps the views it already shows; panes showing the start of the route are reused.
      const window = shared.readWindow?.() ?? shared.window;
      const operations: import('@orchardworks/agent-remote-protocol').WindowEdit[] = [];
      let parent = sourceViewId, remaining = descendants;
      for (;;) {
        const next = remaining[0];
        const shown = next && window.views.find(view => view.attachedTo === parent && !!view.binding && sessionKey(view.binding) === sessionKey(next));
        if (!shown) break;
        parent = shown.id; remaining = remaining.slice(1);
      }
      for (const binding of remaining) {
        const id = `child-${crypto.randomUUID()}`;
        // A Team family's targets carry Team fields that a Window binding does not accept.
        operations.push({ type: 'view.create', view: { id, binding: windowSessionBinding(binding), attachedTo: parent, placement: 'attached', width: 440, collapsed: false, display: { mode: 'content', lettersVisible: true } } });
        parent = id;
      }
      operations.push({ type: 'view.select', viewId: parent });
      shared.operate({ type: 'batch', operations }); setReveal({ viewId: parent }); return;
    }
    setOpenedChildren(opened);
    const children = [...path.slice(1, index + 1), ...descendants];
    setLayout({ children, focus: children.length }); setReveal({ index: children.length });
  }
  return <div className="lab-session-family" ref={container} data-compact={compact || undefined} hidden={!active} aria-label={`${target.title} session family`}>
    {path.map((item, index) => {
      const paneView = index === 0 ? rootView : attached[index - 1];
      const selected = !!paneView && paneView.id === presentedViewId;
      const childSlot = index > 0 && attached[index - 1] ? sessionBridge?.slotForView(attached[index - 1]!.id) : undefined;
      const parent = index > 0 ? parentIndex(index) : 0;
      const controls = index === 0 ? props.controls : <button type="button" aria-label={compact ? `Back to ${path[parent]!.title}` : 'Close subagent'} title={compact ? 'Back to parent session' : 'Close subagent view'} onClick={() => compact ? show(parent) : close(index)}>{compact ? '←' : '×'}</button>;
      return <section key={index === 0 ? "root" : `${paneView?.id ?? ''}:${sessionKey(item)}`} className={`lab-session-family-pane lab-session-pane-selection lab-session-composition${shared && rootView?.placement === 'primary' ? index === 0 ? ' lab-primary-conversation' : ' lab-side-conversation' : ''}`} aria-label={item.title} hidden={compact && focus !== index || index > 0 && attached[index - 1]?.collapsed}
        data-view-id={paneView?.id} data-selected={selected || undefined} aria-current={selected ? 'true' : undefined}
        style={compact ? undefined : index === 0 ? rootView ? { width: rootView.placement === 'float' ? '100%' : rootView.width, minWidth: rootView.placement === 'float' ? 0 : 240,
          flex: rootView.placement === 'float' ? 'none' : '0 0 var(--lab-session-family-root-width, auto)' } : undefined : { width: childWidth(item, index), minWidth: shared ? 240 : 320, flex: 'none' }}
        onPointerDownCapture={event => { if (allowsWindowPaneSelection(event.target)) focusPane(index); }} onFocusCapture={event => { if (allowsWindowPaneSelection(event.target)) focusPane(index); }}>
        {(visited || active || !compact) ? <SessionTitleInteractionContext.Provider value={index === 0 ? titleInteraction : undefined}><FamilyConversation {...props}
          // A conversation with a slot renders into the movable conversation host, so it stays mounted when its view moves
          // between families: a root shown in Bot mode, or an attached pane that becomes an independent dock when unlinked.
          slotId={index === 0 ? rootView && isBotView(rootView) ? sessionBridge?.slotForView(rootView.id)?.id : undefined : childSlot?.id}
          onSelectWindowPane={() => focusPane(index)} familyActive={active} retainHidden={index > 0}
          visible={active && (!compact || focus === index) && !(index > 0 && attached[index - 1]?.collapsed)}
          dockHeadingStart={index === 0 ? dockHeadingStart : undefined} familyRoot={index === 0} controls={controls} menuActions={index === 0 ? props.menuActions : undefined} target={item} entries={path}
          replica={index === 0 ? props.replica : undefined} onSessionReady={index === 0 ? props.onSessionReady : undefined}
          attachedSession={index === 0 ? props.attachedSession : openedChildren[sessionKey(item)]}
          attachmentManaged={index === 0 ? props.attachmentManaged : undefined} attachmentNotice={index === 0 ? props.attachmentNotice : undefined}
          imageRecipient={index === 0 ? props.imageRecipient : undefined}
          consoleCommands={index === 0 ? props.consoleCommands : undefined} onExecuteConsoleCommand={index === 0 ? props.onExecuteConsoleCommand : undefined}
          successionContext={index === 0 ? props.successionContext : undefined}
          viewId={index === 0 ? (rootView && sessionBridge?.slotForView(rootView.id)?.id) ?? props.viewId : childSlot?.id}
          windowViewId={index === 0 ? rootView?.id ?? props.windowViewId : attached[index - 1]?.id}
          displayBinding={index > 0 && attached[index - 1] && props.displayBinding ? { ...props.displayBinding, key: attached[index - 1]!.id } : props.displayBinding}
          draftBinding={index === 0 ? props.draftBinding : childSlot ? { store: props.draftStore, key: childSlot.owners.text.key } : undefined} imageDraftBinding={index === 0 ? props.imageDraftBinding : childSlot?.owners.image}
          onNavigate={(destination, childrenFor, source) => open(index, destination, childrenFor, source)} /></SessionTitleInteractionContext.Provider> : null}
        {!compact && index > 0 ? <DockResize title={item.title} width={childWidth(item, index)} onResize={width => { const view = attached[index - 1]; if (shared && view) shared.operate({ type: 'view.resize', viewId: view.id, width }); else setWidths(current => ({ ...current, [sessionKey(item)]: width })); }} /> : null}
      </section>;
    })}
  </div>;
}

function FamilyConversation({ slotId, onSelectWindowPane, familyActive, retainHidden, ...props }: SessionConversationProps & { slotId?: string; onSelectWindowPane(): void; familyActive: boolean; retainHidden: boolean }) {
  // An attached pane hidden in its active family (another pane focused on a narrow screen, or collapsed) stays in place
  // and attached, as it did when rendered inline.
  return slotId ? <SessionConversationMount mode="window" active={retainHidden ? familyActive : props.visible !== false}
    descriptor={{ slotId, titleInteraction: undefined, onSelectWindowPane, retainHidden, props: { ...props, visible: props.visible !== false } }} /> : <SessionConversation {...props} />;
}
