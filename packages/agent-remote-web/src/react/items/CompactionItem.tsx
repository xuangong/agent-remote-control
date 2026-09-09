import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

export function CompactionItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'compaction' }> }) {
  return <article className="agent-timeline-item agent-compaction" aria-label="Context compaction">
    <strong>Context compaction</strong>
    <span>{item.status === 'loading' ? 'In progress' : 'Completed'}</span>
    {item.trigger ? <span>Trigger: {item.trigger}</span> : null}
  </article>;
}
