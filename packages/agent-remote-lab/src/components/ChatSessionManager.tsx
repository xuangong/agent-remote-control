import { useEffect, useRef, useState } from 'react';
import { sessionForest, sessionKey, sessionStatusLabel, type SessionEntry } from '../session-tree.js';
import { SessionTree } from './SessionTree.js';

export function ChatSessionManager({ current, entries, busy, onOpen }: { current: SessionEntry; entries: readonly SessionEntry[]; busy: boolean; onOpen(item: SessionEntry): void }) {
  const [expanded, setExpanded] = useState(false);
  const layer = useRef<HTMLElement>(null);
  const key = sessionKey(current);
  useEffect(() => { setExpanded(false); }, [key]);
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !layer.current?.contains(event.target)) setExpanded(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || layer.current?.closest('[hidden], [inert]')) return;
      setExpanded(false);
      layer.current?.querySelector<HTMLButtonElement>('.lab-chat-sessions-heading')?.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [expanded]);
  const family = sessionForest(entries).find((root) => {
    const contains = (node: typeof root): boolean => node.key === key || node.children.some(contains);
    return contains(root);
  });
  return <section ref={layer} className="lab-chat-sessions" aria-label="Chat sessions">
    <button type="button" className="lab-chat-sessions-heading" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span><strong>Sessions</strong>
    </button>
    {expanded ? <SessionTree defaultExpanded nodes={family ? [family] : sessionForest([current])} activeKey={key} renderRow={(item, placeholder) => <button type="button" className="lab-session-row lab-chat-session-row" aria-current={sessionKey(item) === key ? 'page' : undefined}
      disabled={busy || placeholder || sessionKey(item) === key} onClick={() => onOpen(item)}>
      <strong>{item.title}</strong><small>{sessionKey(item) === key ? 'Current' : item.parentNativeSessionId ? item.role ?? 'Subagent' : 'Parent'}{sessionStatusLabel(item) ? ` · ${sessionStatusLabel(item)}` : ''}</small>
    </button>} /> : null}
  </section>;
}
