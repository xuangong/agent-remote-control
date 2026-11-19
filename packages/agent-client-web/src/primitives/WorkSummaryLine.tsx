import { useId, type ReactNode } from 'react';
import { rootClass } from './classes.js';

/** A turn's work folded into one grey line ("翻了 3 个文件，写好了 notes.md"); opening it shows the steps (L2) in place. */
export function WorkSummaryLine({ summary, open, onToggle, children, className }: {
  summary: string; open: boolean; onToggle(): void; children?: ReactNode; className?: string;
}) {
  const region = useId();
  return <div className={rootClass('orchard-work-summary', className)} data-open={open ? 'true' : 'false'}>
    <button type="button" className="orchard-work-summary-button" aria-expanded={open} aria-controls={region} onClick={() => onToggle()}>
      <span className="orchard-work-summary-text">{summary}</span>
      <svg className="orchard-work-summary-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M4 2.5 7.5 6 4 9.5" /></svg>
    </button>
    {open ? <div id={region} role="region" aria-label={summary} className="orchard-work-summary-detail">{children}</div> : null}
  </div>;
}
