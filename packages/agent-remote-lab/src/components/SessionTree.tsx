import { useState, type ReactNode } from 'react';
import { sessionKey, type SessionEntry, type SessionNode } from '../session-tree.js';

export function SessionTree({ nodes, activeKey, renderRow, defaultExpanded = false }: { defaultExpanded?: boolean; nodes: readonly SessionNode[]; activeKey?: string; renderRow(item: SessionEntry, placeholder: boolean): ReactNode }) {
  return <ul className="lab-session-list lab-session-tree">{nodes.map((node) => <SessionBranch key={node.key} node={node} activeKey={activeKey} renderRow={renderRow} defaultExpanded={defaultExpanded} />)}</ul>;
}
function SessionBranch({ node, activeKey, renderRow, defaultExpanded }: { defaultExpanded: boolean; node: SessionNode; activeKey?: string; renderRow(item: SessionEntry, placeholder: boolean): ReactNode }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return <li data-session-key={sessionKey(node.session)}>
    <div className="lab-session-branch">
      {node.children.length ? <button type="button" className="lab-session-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.session.title}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'}</button> : <span className="lab-session-toggle-space" />}
      {renderRow(node.session, node.placeholder ?? false)}
    </div>
    {node.children.length && expanded ? <SessionTree nodes={node.children} defaultExpanded={defaultExpanded} activeKey={activeKey} renderRow={renderRow} /> : null}
  </li>;
}
