import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

export function ErrorItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'error' }> }) {
  return <article className="agent-timeline-item agent-error" role="alert">
    <strong>Agent error</strong><p>{item.message}</p>
  </article>;
}
