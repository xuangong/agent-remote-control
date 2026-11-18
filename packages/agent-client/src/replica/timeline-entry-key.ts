import type { AgentTimelineItem, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

/**
 * A row's identity: its item key when the stream carries them, otherwise the position and native identity of its first row. The epoch is
 * not part of it, so a replacement that brings the same rows (a Controller restart) leaves every row and the reader's place where they were;
 * a row whose content differs under the same identity is replaced by content, not by key.
 */
export function timelineEntryKey(entry: ProjectedTimelineEntry): string {
  return entry.itemKey ?? `${entry.providerId}:${entry.seqStart}:${itemIdentity(entry.item)}`;
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

