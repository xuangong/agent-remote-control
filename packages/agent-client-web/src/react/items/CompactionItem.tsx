import { TimelineTitle } from '../TimelineTitle.js';
import { useTranslate } from '../locale.js';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

export function CompactionItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'compaction' }> }) {
  const t = useTranslate();
  return <article className="agent-timeline-item agent-compaction" aria-label={t('timeline.compaction.title')}>
    <TimelineTitle><strong>{t('timeline.compaction.title')}</strong></TimelineTitle>
    <span>{t(item.status === 'loading' ? 'timeline.state.inProgress' : item.status === 'failed' ? 'timeline.state.failed' : 'timeline.state.completed')}</span>
    {item.trigger ? <span>{t('timeline.compaction.trigger', { trigger: item.trigger })}</span> : null}
  </article>;
}
