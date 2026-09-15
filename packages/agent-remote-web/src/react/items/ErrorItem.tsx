import { useId } from 'react';
import { useItemDisclosure } from '../TimelineDisplay.js';
import { ContentPreview } from './ContentPreview.js';
import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

export function ErrorItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'error' }> }) {
  const { expanded, preview, toggle } = useItemDisclosure();
  const detailsId = useId();
  const summary = item.message.replace(/\s+/g, ' ').trim();
  return <article className="agent-timeline-item agent-error" aria-label="Runtime notice">
    <button className="agent-notice-toggle" type="button" aria-expanded={expanded} aria-controls={detailsId}
      onClick={toggle}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <span className="agent-notice-label">Runtime notice</span>
      {!preview ? <span className="agent-notice-summary">{summary.length > 100 ? `${summary.slice(0, 100)}…` : summary}</span> : null}
    </button>
    {preview ? <ContentPreview text={item.message} /> : null}
    <p id={detailsId} className="agent-notice-details" hidden={!expanded}>{item.message}</p>
  </article>;
}
