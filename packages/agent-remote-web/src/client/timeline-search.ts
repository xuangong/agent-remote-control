import type { AgentTimelineItem, HistoryPage, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { timelineEntryKey } from '../replica/timeline-entry-key.js';

export interface TimelineSearchMatch {
  readonly key: string;
  readonly epoch: string;
  readonly seq: number;
  readonly label: string;
  readonly snippet: string;
  readonly timestamp: string;
}
export interface TimelineSearchProgress {
  readonly matches: readonly TimelineSearchMatch[];
  readonly scanned: number;
}
export type TimelineSearchScope = 'all' | 'messages' | 'tools' | 'reasoning';
export interface TimelineSearchOptions {
  readonly scope?: TimelineSearchScope;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TimelineSearchProgress) => void;
}

const labels: Record<AgentTimelineItem['type'], string> = {
  agent_communication: 'Agent communication', user_message: 'You', assistant_message: 'Assistant', reasoning: 'Reasoning', tool_call: 'Tool',
  todo: 'Tasks', interaction: 'Interaction', error: 'Error', compaction: 'Compaction',
};

/** Search normalized, readable content rather than serialized protocol identities. */
export function timelineSearchText(item: AgentTimelineItem): string {
  switch (item.type) {
    case 'agent_communication': return `${item.sender} ${item.recipient} ${item.text}`;
    case 'user_message': case 'assistant_message': case 'reasoning': return item.text;
    case 'error': return item.message;
    case 'todo': return item.items.map(task => task.text).join('\n');
    case 'compaction': return `Context compaction ${item.status}`;
    case 'interaction': return readableValues([item.request, item.response]);
    case 'tool_call': return [item.name, readableValues(item.detail), item.error,
      ...(item.result?.content.map(block => block.type === 'text' ? block.text : JSON.stringify(block.value)) ?? [])].filter(Boolean).join('\n');
  }
}

function readableValues(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(readableValues).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value).filter(([key]) => !['type', 'kind', 'sensitive'].includes(key) && !/Id$|Ids$/.test(key))
    .map(([, part]) => readableValues(part)).filter(Boolean).join('\n');
}

export function findTimelineMatches(epoch: string, entries: readonly ProjectedTimelineEntry[], query: string, scope: TimelineSearchScope = 'messages'): TimelineSearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: TimelineSearchMatch[] = [];
  for (const entry of entries) {
    if (scope === 'messages' && entry.item.type !== 'user_message' && entry.item.type !== 'assistant_message') continue;
    if (scope === 'tools' && entry.item.type !== 'tool_call') continue;
    if (scope === 'reasoning' && entry.item.type !== 'reasoning') continue;
    const text = timelineSearchText(entry.item).replace(/\s+/g, ' ');
    const offset = text.toLowerCase().indexOf(needle.replace(/\s+/g, ' '));
    if (offset < 0) continue;
    const start = Math.max(0, offset - 55);
    const end = Math.min(text.length, offset + needle.length + 100);
    matches.push({ key: timelineEntryKey(epoch, entry), epoch, seq: entry.seqStart,
      label: entry.item.type === 'tool_call' ? entry.item.name : labels[entry.item.type], timestamp: entry.timestamp,
      snippet: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}` });
  }
  return matches.sort((a, b) => b.seq - a.seq);
}

/** History scanning does not expand the rendered replica or retain nonmatching pages. */
export async function scanTimelineHistory({ epoch, entries, hasOlder, query, fetchBefore, assertCurrent, signal, onProgress, scope }: {
  epoch: string; entries: readonly ProjectedTimelineEntry[]; hasOlder: boolean; query: string;
  fetchBefore(seq: number): Promise<HistoryPage>; assertCurrent(): void;
} & TimelineSearchOptions): Promise<TimelineSearchProgress> {
  const check = () => { signal?.throwIfAborted(); assertCurrent(); };
  check();
  let matches = findTimelineMatches(epoch, entries, query, scope);
  let scanned = entries.length;
  onProgress?.({ matches, scanned });
  if (!query.trim()) return { matches, scanned };
  let before = entries[0]?.seqStart;
  while (hasOlder) {
    check();
    if (!before) throw new Error('History has no search cursor. Reconnect and retry.');
    const page = (await fetchBefore(before)).payload;
    check();
    if (page.epoch !== epoch || page.reset || page.staleCursor || page.gap) throw new Error('Conversation history changed. Search again.');
    if (page.error) throw new Error(page.error);
    const next = page.entries[0]?.seqStart;
    if ((next !== undefined && next >= before) || (page.hasOlder && next === undefined)) throw new Error('History search did not advance. Retry when the session is ready.');
    const known = new Set(matches.map(match => match.key));
    matches = [...matches, ...findTimelineMatches(epoch, page.entries, query, scope).filter(match => !known.has(match.key))];
    scanned += page.entries.length;
    onProgress?.({ matches, scanned });
    before = next;
    hasOlder = page.hasOlder;
    // Let input, cancellation, and rendering run between cached history pages too.
    if (hasOlder) await new Promise(resolve => setTimeout(resolve, 0));
  }
  check();
  return { matches, scanned };
}
