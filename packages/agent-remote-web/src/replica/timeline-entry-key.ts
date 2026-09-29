import type { AgentTimelineItem, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

export function timelineEntryKey(epoch: string | null, entry: ProjectedTimelineEntry): string {
  return `${epoch ?? 'uninitialized'}:${entry.providerId}:${entry.seqStart}:${itemIdentity(entry.item)}`;
}

function itemIdentity(item: AgentTimelineItem): string {
  switch (item.type) {
    case 'agent_communication': return item.messageId;
    case 'user_message': return item.messageId ?? item.clientMessageId ?? 'user';
    case 'assistant_message': return item.messageId ?? 'assistant';
    case 'tool_call': return item.callId;
    case 'interaction': return item.request.requestId;
    case 'reasoning': return 'reasoning';
    case 'todo': return 'todo';
    case 'error': return 'error';
    case 'compaction': return 'compaction';
  }
}

