import { mergeBackgroundActivity, type BackgroundActivity } from '@orchardworks/agent-remote-protocol';
import type { ReactNode } from 'react';
import { TimelineEntry } from './TimelineEntry.js';
import type { TimelineRenderEntry } from './timeline-render-model.js';

export type BackgroundRow = { type: 'entry'; key: string; value: TimelineRenderEntry }
  | { type: 'background'; key: string; entries: TimelineRenderEntry[]; count: number };

/** Only explicit Host annotations can reduce prominence. Human input and failures remain visible. */
export function groupBackgroundActivity(model: readonly TimelineRenderEntry[], all = model): BackgroundRow[] {
  const states = new Map<string, BackgroundActivity>();
  for (const { entry } of all) if (entry.item.background) states.set(entry.item.background.id, mergeBackgroundActivity(states.get(entry.item.background.id), entry.item.background));
  const rows: BackgroundRow[] = [];
  let groupIds = new Set<string>();
  for (const value of model) {
    const item = value.entry.item, background = item.background;
    const status = background && states.get(background.id)?.status;
    const grouped = background && (item.type === 'user_message' || status !== 'failed' && (
      item.type === 'reasoning' || item.type === 'tool_call' && item.status !== 'failed' && item.status !== 'canceled'
      || status === 'silent' && item.type === 'assistant_message'));
    if (!grouped) { rows.push({ type: 'entry', key: value.key, value }); continue; }
    const previous = rows.at(-1);
    if (previous?.type === 'background') {
      if (!groupIds.has(background.id)) { previous.count++; groupIds.add(background.id); }
      previous.entries.push(value);
    } else { groupIds = new Set([background.id]); rows.push({ type: 'background', key: value.key, entries: [value], count: 1 }); }
  }
  return rows;
}

export function BackgroundActivityGroup({ entries, count, expanded, toggle, renderEntry }: {
  entries: readonly TimelineRenderEntry[]; count: number; expanded: boolean; toggle(): void;
  renderEntry(entry: TimelineRenderEntry): ReactNode;
}) {
  const first = entries[0]!;
  const summary = <div className="agent-background-group">
    <button type="button" className="agent-background-summary" aria-expanded={expanded} onClick={toggle}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> Background checks <span className="agent-background-count">{count}</span>
    </button>
  </div>;
  return expanded ? <>{summary}{entries.map(renderEntry)}</> : <TimelineEntry entryKey={first.key} timestamp={first.entry.timestamp}
    sequence={first.entry.seqStart} sent={false} inspected={false}>{summary}</TimelineEntry>;
}
