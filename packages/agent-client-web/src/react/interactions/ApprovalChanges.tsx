import { useState, type ReactNode } from 'react';
import { useTranslate } from '../locale.js';

/**
 * "Show what changes" on an approval card: a disclosure of the request's detail and every decision (L2). It is a details
 * element, so a reader can look while the card's decisions are locked, for example while the session reconnects.
 */
export function ApprovalChanges({ children }: { children: ReactNode }) {
  const t = useTranslate();
  const [open, setOpen] = useState(false);
  // The state drives the element, so its words follow at once; the toggle event comes a task later.
  return <details className="agent-approval-changes" open={open}>
    <summary className="orchard-pill agent-approval-changes-toggle" data-variant="plain"
      onClick={event => { event.preventDefault(); setOpen(value => !value); }}>{open ? t('approval.hideChanges') : t('approval.showChanges')}</summary>
    <div className="agent-approval-changes-body">{children}</div>
  </details>;
}
