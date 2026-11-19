import type { ReactNode } from 'react';
import { rootClass } from './classes.js';

/** What an assistant is doing, in one sentence ("Chief 在想例子怎么写"), with a quieter detail and typing dots while live. */
export function StatusLine({ avatar, sentence, detail, live = false, className }: {
  avatar?: ReactNode; sentence: string; detail?: string; live?: boolean; className?: string;
}) {
  const dots = live ? <span className="orchard-typing" aria-hidden="true"><i /><i /><i /></span> : null;
  return <div className={rootClass('orchard-status-line', className)} data-live={live ? 'true' : 'false'}>
    {avatar ? <span className="orchard-status-avatar">{avatar}</span> : null}
    <div className="orchard-status-text">
      <p className="orchard-status-sentence" role="status" aria-live="polite">{sentence}</p>
      {detail || dots ? <p className="orchard-status-detail">{detail}{dots}</p> : null}
    </div>
  </div>;
}
