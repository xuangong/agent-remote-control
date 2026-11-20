import type { AgentTimelineItem, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { MessageKey, Translate } from '@orchardworks/agent-client';

export interface TraceEntryRequest { readonly key: string; readonly requestId: number; readonly align?: 'start' | 'center' }

const traceItemLabelKeys: Record<AgentTimelineItem['type'], MessageKey> = {
  agent_communication: 'diagnostics.event.agentCommunication', user_message: 'diagnostics.event.userMessage', assistant_message: 'diagnostics.event.assistantMessage',
  reasoning: 'diagnostics.event.reasoning', tool_call: 'diagnostics.event.toolCall', todo: 'diagnostics.event.todo', interaction: 'diagnostics.event.interaction',
  error: 'diagnostics.event.error', compaction: 'diagnostics.event.compaction',
};

/** Each event type's label, in the page's language, by the type's identifier. */
export function traceItemLabels(t: Translate): Record<AgentTimelineItem['type'], string> {
  return Object.fromEntries(Object.entries(traceItemLabelKeys).map(([type, key]) => [type, t(key)])) as Record<AgentTimelineItem['type'], string>;
}

export function traceItemLabel(item: AgentTimelineItem, t: Translate): string {
  return item.type === 'tool_call' ? item.name : t(traceItemLabelKeys[item.type]);
}

export function traceItemSummary(item: AgentTimelineItem): string {
  switch (item.type) {
    case 'assistant_message': case 'user_message': case 'reasoning': return item.text;
    case 'agent_communication': return `${item.sender} → ${item.recipient}: ${item.text}`;
    case 'error': return item.message;
    case 'todo': return item.items.map(task => task.text).join(' · ');
    case 'compaction': return item.status;
    case 'interaction': return item.request.kind;
    case 'tool_call': {
      const detail = item.detail;
      switch (detail.type) {
        case 'read': case 'edit': case 'write': return detail.filePath;
        case 'shell': return detail.command;
        case 'search': return detail.query;
        case 'fetch': return detail.url;
        case 'other': return detail.description;
      }
    }
  }
}

export function traceItemStatus(item: AgentTimelineItem): string | undefined {
  return item.type === 'error' ? 'failed' : item.type === 'tool_call' || item.type === 'compaction' ? item.status : undefined;
}

export function traceSequence(start: number, end: number): string { return start === end ? `#${start}` : `#${start}–${end}`; }

export function traceSourceRanges(entry: ProjectedTimelineEntry, t: Translate): string {
  return entry.sourceSeqRanges.map(range => range.startSeq === range.endSeq ? `${range.startSeq}` : `${range.startSeq}–${range.endSeq}`).join(', ') || t('diagnostics.notRecorded');
}

export function traceSessionReferences(item: AgentTimelineItem) {
  if (item.type !== 'tool_call' || item.detail.type !== 'other') return [];
  return [...new Map([...(item.detail.sessionReference ? [item.detail.sessionReference] : []),
    ...(item.detail.sessionReferences ?? [])].map(reference => [reference.nativeSessionId, reference])).values()];
}
