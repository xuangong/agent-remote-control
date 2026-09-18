import { TimelineTitle } from '../TimelineTitle.js';
import { useId } from 'react';
import { useItemDisclosure } from '../TimelineDisplay.js';
import { ContentPreview } from './ContentPreview.js';
import type { AgentTimelineItem } from '@agent-remote-controller/agent-remote-protocol';
import { MarkdownContent } from '../MarkdownContent.js';

export function ReasoningItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'reasoning' }> }) {
  const { expanded, preview, toggle } = useItemDisclosure();
  const contentId = useId();
  return <article className="agent-timeline-item agent-reasoning">
    <button
      type="button"
      className="agent-reasoning-toggle"
      aria-expanded={expanded}
      aria-controls={contentId}
      onClick={toggle}
    >
      <TimelineTitle disclose={toggle}>Reasoning trace</TimelineTitle><span aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {preview ? <ContentPreview text={item.text} /> : null}
    <div id={contentId} className="agent-reasoning-details" hidden={!expanded}>{expanded ? <MarkdownContent markdown={item.text} className="agent-reasoning-content" /> : null}</div>
  </article>;
}
