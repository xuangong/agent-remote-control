import { useEffect, useRef, useState } from 'react';
import { sessionForest, sessionKey, sessionStatusLabel, type SessionEntry, type SessionNode } from '../session-tree.js';
import { SessionTree } from './SessionTree.js';

export interface LocalSessionView { slotId: string; session: SessionEntry }

export function ChatSessionManager({ current, entries, busy, onOpen, localViews, activeSlot, onOpenView }: {
  current: SessionEntry; entries: readonly SessionEntry[]; busy: boolean; onOpen(item: SessionEntry): void;
  localViews?: readonly LocalSessionView[]; activeSlot?: string; onOpenView?(view: LocalSessionView): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const layer = useRef<HTMLElement>(null);
  const key = sessionKey(current);
  useEffect(() => { setExpanded(false); }, [key, activeSlot]);
  useEffect(() => {
    if (!expanded) return;
    const menu = layer.current;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !layer.current?.contains(event.target)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || layer.current?.closest('[hidden], [inert]')) return;
      event.preventDefault();
      setExpanded(false);
      layer.current?.querySelector<HTMLButtonElement>('.lab-chat-sessions-heading')?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    menu?.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); menu?.removeEventListener('keydown', escape); };
  }, [expanded]);
  const family = sessionForest(entries).find((root) => {
    const contains = (node: typeof root): boolean => node.key === key || node.children.some(contains);
    return contains(root);
  });
  const working = family ? workingSubagents(family) : 0;
  const represented = new Set(onOpenView ? localViews?.map(view => sessionKey(view.session)) : []);
  const nativeNodes = remainingFamily(family ? [family] : sessionForest([current]), represented);
  return <section ref={layer} className="lab-chat-sessions" aria-label="Chat sessions">
    <button type="button" className="lab-chat-sessions-heading" data-working={working > 0 || undefined} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span><strong>Sessions</strong>{' '}{working > 0 ? <span className="lab-session-working-count">{working} working</span> : null}
    </button>
    {expanded ? <>{onOpenView ? localViews?.map(view => <button key={view.slotId} type="button" className="lab-session-row lab-chat-session-row"
      aria-current={view.slotId === activeSlot ? 'page' : undefined} disabled={busy || view.slotId === activeSlot} onClick={() => onOpenView(view)}>
      <strong className="agent-session-title">{view.session.title}</strong><small>{view.slotId === activeSlot ? 'Current view' : 'Saved view'}</small>
    </button>) : null}<SessionTree defaultExpanded nodes={nativeNodes} activeKey={key} renderRow={(item, placeholder) => <button type="button" className="lab-session-row lab-chat-session-row" data-working={!!item.parentNativeSessionId && item.status === 'running' || undefined} aria-current={sessionKey(item) === key ? 'page' : undefined}
      disabled={busy || placeholder || sessionKey(item) === key} onClick={() => onOpen(item)}>
      <strong className="agent-session-title" data-session-status={item.status}>{item.title}</strong><small>{sessionKey(item) === key ? 'Current' : item.parentNativeSessionId ? item.role ?? 'Subagent' : 'Parent'}{sessionStatusLabel(item) ? ` · ${sessionStatusLabel(item)}` : ''}</small>
    </button>} /></> : null}
  </section>;
}

function workingSubagents(node: SessionNode): number {
  return (node.session.parentNativeSessionId && node.session.status === 'running' ? 1 : 0)
    + node.children.reduce((sum, child) => sum + workingSubagents(child), 0);
}

function remainingFamily(nodes: readonly SessionNode[], represented: Set<string>): SessionNode[] {
  return nodes.flatMap(node => {
    const children = remainingFamily(node.children, represented);
    return represented.has(node.key) ? children : [{ ...node, children }];
  });
}
