import { useState, type ReactNode } from 'react';
import { sessionKey, type SessionEntry, type SessionNode } from '../session-tree.js';

interface Props {
  defaultExpanded?: boolean;
  nodes: readonly SessionNode[];
  activeKey?: string;
  renderRow(item: SessionEntry, placeholder: boolean): ReactNode;
  renderRelated?(node: SessionNode): ReactNode;
}
export function SessionTree({ nodes, activeKey, renderRow, renderRelated, defaultExpanded = false }: Props) {
  return <ul className="lab-session-list lab-session-tree">{nodes.map((node) => <SessionBranch key={node.key} node={node} activeKey={activeKey} renderRow={renderRow} renderRelated={renderRelated} defaultExpanded={defaultExpanded} />)}</ul>;
}
function SessionBranch({ node, activeKey, renderRow, renderRelated, defaultExpanded }: Omit<Props, 'nodes'> & { defaultExpanded: boolean; node: SessionNode }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const related = renderRelated?.(node);
  const expandable = node.children.length > 0 || !!related;
  return <li data-session-key={sessionKey(node.session)}>
    <div className="lab-session-branch">
      {expandable ? <button type="button" className="lab-session-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.session.title}`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '▾' : '▸'}</button> : <span className="lab-session-toggle-space" />}
      {renderRow(node.session, node.placeholder ?? false)}
    </div>
    {node.children.length && expanded ? <SessionTree nodes={node.children} defaultExpanded={defaultExpanded} activeKey={activeKey} renderRow={renderRow} renderRelated={renderRelated} /> : null}
    {expanded ? related : null}
  </li>;
}
