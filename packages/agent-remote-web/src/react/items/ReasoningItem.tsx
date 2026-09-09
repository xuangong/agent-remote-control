import { useId, useState } from 'react';
import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';
import { MarkdownContent } from '../MarkdownContent.js';

export function ReasoningItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'reasoning' }> }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  return <article className="agent-timeline-item agent-reasoning">
    <button
      type="button"
      className="agent-reasoning-toggle"
      aria-expanded={expanded}
      aria-controls={contentId}
      onClick={() => setExpanded((current) => !current)}
    >
      <span>Reasoning trace</span><span aria-hidden="true">{expanded ? '−' : '+'}</span>
    </button>
    {expanded ? <MarkdownContent markdown={item.text} className="agent-reasoning-content" /> : null}
  </article>;
}
