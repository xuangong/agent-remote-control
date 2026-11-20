import type { ReactNode } from 'react';
import { TimelineEntry } from './TimelineEntry.js';
import { useTranslate } from './locale.js';
import type { TimelineRenderEntry } from './timeline-render-model.js';

export function BackgroundActivityGroup({ entries, count, expanded, toggle, renderEntry }: {
  entries: readonly TimelineRenderEntry[]; count: number; expanded: boolean; toggle(): void;
  renderEntry(entry: TimelineRenderEntry): ReactNode;
}) {
  const t = useTranslate();
  const first = entries[0]!;
  const summary = <div className="agent-background-group">
    <button type="button" className="agent-background-summary" aria-expanded={expanded} onClick={toggle}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {t('timeline.background.checks')} <span className="agent-background-count">{count}</span>
    </button>
  </div>;
  return expanded ? <>{summary}{entries.map(renderEntry)}</> : <TimelineEntry entryKey={first.key} timestamp={first.entry.timestamp}
    sent={false} inspected={false}>{summary}</TimelineEntry>;
}
