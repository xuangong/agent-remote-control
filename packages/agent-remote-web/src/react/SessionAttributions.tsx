import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SessionAttribution, SessionDescription } from '../session-description.js';

export interface SessionAttributionsProps {
  description?: SessionDescription;
  onNavigate?(attribution: SessionAttribution): void | Promise<void>;
  children(parts: { toggle: ReactNode; details: ReactNode }): ReactNode;
}

interface NavigationFeedback {
  scope: string;
  rowId: string;
  pending: boolean;
  error?: string;
}

/** Presents supplied relationships without owning their truth or destination layout. */
export function SessionAttributions({ description, onNavigate, children }: SessionAttributionsProps) {
  const [expanded, setExpanded] = useState(false);
  const [feedback, setFeedback] = useState<NavigationFeedback>();
  const detailsId = useId();
  const request = useRef(0);
  const scope = JSON.stringify([
    description?.identity.hostId, description?.identity.providerId, description?.identity.nativeSessionId,
    description?.attributions.map(({ id, target }) => [id, target]),
  ]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    request.current += 1;
    setFeedback(undefined);
    return () => { request.current += 1; };
  }, [scope]);

  async function navigate(attribution: SessionAttribution): Promise<void> {
    if (!onNavigate || !attribution.target) return;
    const currentRequest = ++request.current;
    setFeedback({ scope, rowId: attribution.id, pending: true });
    try {
      await onNavigate(attribution);
      if (currentScope.current === scope && request.current === currentRequest) setFeedback(undefined);
    } catch (error) {
      if (currentScope.current !== scope || request.current !== currentRequest) return;
      setFeedback({ scope, rowId: attribution.id, pending: false,
        error: error instanceof Error && error.message.trim() ? error.message : 'The related session could not be opened. Try again.' });
    }
  }

  if (!description?.attributions.length) return children({ toggle: null, details: null });
  const label = expanded ? 'Hide session attributions' : 'Show session attributions';
  const toggle = <button type="button" className="agent-session-attributions-toggle" title={label} aria-label={label}
    aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
  </button>;
  const details = expanded ? <div id={detailsId} className="agent-session-attributions">
    <table aria-label="Session attributions"><tbody>{description.attributions.map(attribution => {
      const rowFeedback = feedback?.scope === scope && feedback.rowId === attribution.id ? feedback : undefined;
      return <tr key={attribution.id}>
        <th scope="row">{attribution.label}</th>
        <td>
          {attribution.target && onNavigate ? <button type="button" className="agent-session-attribution-target"
            disabled={rowFeedback?.pending} aria-busy={rowFeedback?.pending || undefined} onClick={() => { void navigate(attribution); }}>
            {attribution.value}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M7 7h10v10" /></svg>
          </button> : <span>{attribution.value}</span>}
          {attribution.detail ? <small className="agent-session-attribution-detail">{attribution.detail}</small> : null}
          {rowFeedback?.pending ? <small className="agent-session-attribution-feedback" role="status">Opening…</small> : null}
          {rowFeedback?.error ? <small className="agent-session-attribution-feedback" role="alert">{rowFeedback.error}</small> : null}
        </td>
      </tr>;
    })}</tbody></table>
  </div> : null;
  return children({ toggle, details });
}
