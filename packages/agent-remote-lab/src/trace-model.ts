import type { AgentTimelineItem, ProjectedTimelineEntry } from '@agent-remote-controller/agent-remote-protocol';

export interface TraceEntryRequest { readonly key: string; readonly requestId: number }

export const traceItemLabels: Record<AgentTimelineItem['type'], string> = {
  user_message: 'User message', assistant_message: 'Assistant message', reasoning: 'Reasoning update',
  tool_call: 'Tool call', todo: 'Task list', interaction: 'Completed interaction', error: 'Agent error', compaction: 'Context compacted',
};

export function traceItemLabel(item: AgentTimelineItem): string {
  return item.type === 'tool_call' ? item.name : traceItemLabels[item.type];
}

export function traceItemSummary(item: AgentTimelineItem): string {
  switch (item.type) {
    case 'assistant_message': case 'user_message': case 'reasoning': return item.text;
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

export function traceSourceRanges(entry: ProjectedTimelineEntry): string {
  return entry.sourceSeqRanges.map(range => range.startSeq === range.endSeq ? `${range.startSeq}` : `${range.startSeq}–${range.endSeq}`).join(', ') || 'Not recorded';
}

export function traceSessionReferences(item: AgentTimelineItem) {
  if (item.type !== 'tool_call' || item.detail.type !== 'other') return [];
  return [...new Map([...(item.detail.sessionReference ? [item.detail.sessionReference] : []),
    ...(item.detail.sessionReferences ?? [])].map(reference => [reference.nativeSessionId, reference])).values()];
}
