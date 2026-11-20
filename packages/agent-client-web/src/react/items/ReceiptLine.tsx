import { useId, type ReactNode } from 'react';
import { useItemDisclosure } from '../TimelineDisplay.js';
import { TimelineTitle } from '../TimelineTitle.js';

/**
 * An answered interaction in the conversation: one line saying how it was answered ("Allowed once · Write"), and today's
 * receipt detail when the line is opened. A search or Trace target opens it.
 */
export function ReceiptLine({ result, subject, kind, className, children }: {
  result: string; subject?: string; kind: string; className?: string; children: ReactNode;
}) {
  const { expanded, toggle } = useItemDisclosure();
  const detailsId = useId();
  return <article className={`agent-item agent-interaction-completed agent-receipt${className ? ` ${className}` : ''}`} data-receipt={kind}>
    <button className="agent-receipt-toggle" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={toggle}>
      <span className="agent-tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <TimelineTitle disclose={toggle}><span className="agent-receipt-result">{result}</span></TimelineTitle>
      {subject ? <span className="agent-receipt-subject" title={subject}>{subject}</span> : null}
    </button>
    <div id={detailsId} className="agent-receipt-details" hidden={!expanded}>{expanded ? children : null}</div>
  </article>;
}
