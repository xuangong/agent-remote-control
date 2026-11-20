import { TimelineTitle } from '../TimelineTitle.js';
import { useId } from 'react';
import { useTranslate } from '../locale.js';
import { useItemDisclosure } from '../TimelineDisplay.js';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';

export function ErrorItem({ item }: { readonly item: Extract<AgentTimelineItem, { type: 'error' }> }) {
  const { expanded, toggle } = useItemDisclosure();
  const detailsId = useId();
  return <RuntimeNoticeItem item={item} expanded={expanded} toggle={toggle} detailsId={detailsId} />;
}

export function RuntimeNoticeItem({ item, expanded, toggle, count = 1, detailsId, controls = detailsId }: {
  readonly item: Extract<AgentTimelineItem, { type: 'error' }>;
  readonly expanded: boolean;
  readonly toggle?: () => void;
  readonly count?: number;
  readonly detailsId: string;
  readonly controls?: string;
}) {
  const t = useTranslate();
  return <article className="agent-timeline-item agent-error" aria-label={t('timeline.runtimeNotice')}>
    {toggle ? <button className="agent-notice-toggle" type="button" aria-expanded={expanded} aria-controls={controls}
      onClick={toggle}>
      <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <TimelineTitle className="agent-notice-label" disclose={toggle}>{t('timeline.runtimeNotice')}</TimelineTitle>
      <span className="agent-notice-count">{count}</span>
    </button> : null}
    <p id={detailsId} className="agent-notice-details" hidden={!expanded}>{item.message}</p>
  </article>;
}
