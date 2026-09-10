import { useId, useState } from 'react';
import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

export function ErrorItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'error' }> }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const summary = item.message.replace(/\s+/g, ' ').trim();
  return <article className="agent-timeline-item agent-error" aria-label="Runtime notice">
    <button className="agent-notice-toggle" type="button" aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => setExpanded(current => !current)}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="agent-notice-label">Runtime notice</span>
      <span className="agent-notice-summary">{summary.length > 100 ? `${summary.slice(0, 100)}…` : summary}</span>
    </button>
    <p id={detailsId} className="agent-notice-details" hidden={!expanded}>{item.message}</p>
  </article>;
}
