import type { ReactNode } from 'react';
import { rootClass } from './classes.js';

/**
 * One message. The user's is on the right in the `mine` colours; the assistant's is on the left on the neutral fill with
 * its avatar at the bubble's foot. A message still being sent says so beside it, and is busy.
 */
export function Bubble({ from, avatar, delivery, sendingLabel, children, className }: {
  from: 'mine' | 'theirs'; avatar?: ReactNode; delivery?: 'sending' | 'sent'; sendingLabel?: string; children: ReactNode; className?: string;
}) {
  const sending = delivery === 'sending';
  return <div className={rootClass('orchard-bubble-row', className)} data-from={from}>
    {from === 'theirs' && avatar ? <span className="orchard-bubble-avatar">{avatar}</span> : null}
    <div className="orchard-bubble" {...(sending ? { 'aria-busy': true, 'data-delivery': 'sending' } : {})}>{children}</div>
    {sending && sendingLabel ? <span className="orchard-bubble-status">{sendingLabel}</span> : null}
  </div>;
}
