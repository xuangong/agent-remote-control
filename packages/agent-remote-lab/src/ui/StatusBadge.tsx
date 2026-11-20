import { useTranslate } from '@orchardworks/agent-client-web/react';

export type RowStatus = { kind: 'attention'; count: number } | { kind: 'failed' } | { kind: 'working' } | { kind: 'unread' };

const NAMES = { failed: 'navigation.status.failed', working: 'navigation.status.working', unread: 'navigation.status.unread' } as const;

/** Whole, non-negative count; NaN counts as zero and fractions are truncated. */
function countOf(count: number): number {
  const whole = Math.trunc(count);
  return Number.isNaN(whole) ? 0 : Math.max(0, whole);
}

/** One trailing status of a row: a count of requests that need you, a failure, work in progress or a new result. */
export function StatusBadge({ status }: { status: RowStatus }) {
  const t = useTranslate();
  let name: string;
  let text = '';
  switch (status.kind) {
    case 'attention': {
      const count = countOf(status.count);
      if (count === 0) return null;
      name = t('navigation.status.needsYou', { count });
      text = count > 99 ? '99+' : String(count);
      break;
    }
    case 'failed':
      name = t(NAMES.failed);
      text = '!';
      break;
    case 'working':
    case 'unread':
      name = t(NAMES[status.kind]);
      break;
  }
  return <span className="ui-status" data-kind={status.kind} role="img" aria-label={name}>{text}</span>;
}
