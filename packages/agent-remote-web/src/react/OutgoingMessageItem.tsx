import { useState } from 'react';
import type { OutgoingMessage } from '../replica/types.js';
import { UserMessageItem } from './items/MessageItem.js';

export function OutgoingMessageItem({ message, onRetry, onDelete }: {
  readonly message: OutgoingMessage;
  readonly onRetry?: (id: string) => Promise<void>;
  readonly onDelete?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string>();
  const settled = message.status === 'failed' || message.status === 'unconfirmed';
  const label = message.status === 'failed' ? 'Send failed'
    : message.status === 'unconfirmed' ? 'Delivery not confirmed'
    : message.status === 'sending' ? 'Sending…'
    : message.delivery === 'next_turn' ? 'Queued — waiting for conversation…' : 'Sent — waiting for conversation…';
  async function retry(): Promise<void> {
    if (!onRetry || busy) return;
    setBusy(true); setError(undefined);
    try { await onRetry(message.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Retry failed.'); }
    finally { setBusy(false); }
  }
  return <div className="agent-timeline-entry agent-outgoing-message" data-entry-key={message.id}
    data-delivery-state={settled ? message.status : 'pending'} aria-busy={!settled}>
    <UserMessageItem item={{ type: 'user_message', text: message.text }} />
    <div className="agent-message-delivery" role={settled ? 'alert' : 'status'}>
      {settled ? <button type="button" className="agent-delivery-error-toggle" aria-label="Delivery error" aria-expanded={details} title={error || message.error || label} onClick={() => setDetails(value => !value)}><svg aria-hidden="true" width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10" cy="10" r="8" /><path d="M10 5v6m0 3v1" /></svg></button>
        : <span className="agent-delivery-dot" aria-hidden="true" />}
      <span className={settled ? 'agent-visually-hidden' : undefined}>{label}</span>
      {settled ? <span className="agent-delivery-actions">
        <button type="button" aria-label="Retry message" disabled={!onRetry || busy} title="Retry message" onClick={() => void retry()}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8a7 7 0 1 1 1 7M3 3v5h5" /></svg></button>
        <button type="button" aria-label="Delete message" disabled={!onDelete || busy} title="Delete local message" onClick={() => onDelete?.(message.id)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h14M7 5V2h6v3M5 5l1 13h8l1-13M8 8v7m4-7v7" /></svg></button>
      </span> : null}
      {settled && details && (error || message.error) ? <span className="agent-delivery-error">{error || message.error}</span> : null}
    </div>
  </div>;
}
