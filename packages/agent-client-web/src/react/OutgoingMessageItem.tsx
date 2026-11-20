import type { MarkdownResourceContext } from './markdown-resources.js';
import { useState } from 'react';
import { useTranslate } from './locale.js';
import { errorWordsOr } from './localized-error.js';
import { UserMessageItem } from './items/MessageItem.js';
import { type OutgoingMessage, isUncertainSend, sendState, storedWords } from '@orchardworks/agent-client';

export function OutgoingMessageItem({ message, onRetry, onDelete, resourceContext }: {
  readonly message: OutgoingMessage;
  readonly resourceContext?: MarkdownResourceContext;
  readonly onRetry?: (id: string) => Promise<void>;
  readonly onDelete?: (id: string) => void;
}) {
  const t = useTranslate();
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string>();
  const { label, settled, deliveryState } = sendState.describe(message.status, message.delivery, t);
  const recorded = message.error ? storedWords(message.error, t) : undefined;
  async function retry(): Promise<void> {
    if (!onRetry || busy) return;
    setBusy(true); setError(undefined);
    try { await onRetry(message.id); }
    catch (reason) {
      // An uncertain delivery is recorded on the message in plain words (what to check, what Retry does next); the Host's
      // own reply, written for operators, would only hide them.
      if (!isUncertainSend(reason)) setError(errorWordsOr(reason, t, 'timeline.outgoing.retryFailed'));
    }
    finally { setBusy(false); }
  }
  return <div className="agent-timeline-entry agent-outgoing-message" data-entry-key={message.id}
    data-delivery-state={deliveryState} aria-busy={!settled}>
    <UserMessageItem item={{ type: 'user_message', text: message.text, ...(message.content ? { content: message.content.map(part => part.type === 'text' ? part : part.type === 'resource' ? { type: 'text' as const, text: `[${part.label}]` } : { type: 'image' as const, locator: `input-image:${part.attachmentId}`, label: part.label }) } : {}) }} resourceContext={resourceContext} />
    <div className="agent-message-delivery" role={settled ? 'alert' : 'status'}>
      {settled ? <button type="button" className="agent-delivery-error-toggle" aria-label={t('timeline.outgoing.error')} aria-expanded={details} title={error || recorded || label} onClick={() => setDetails(value => !value)}><svg aria-hidden="true" width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10" cy="10" r="8" /><path d="M10 5v6m0 3v1" /></svg></button>
        : <span className="agent-delivery-dot" aria-hidden="true" />}
      <span className={settled ? 'agent-visually-hidden' : undefined}>{label}</span>
      {settled ? <span className="agent-delivery-actions">
        <button type="button" aria-label={t('timeline.outgoing.retry')} disabled={!onRetry || busy} title={t('timeline.outgoing.retry')} onClick={() => void retry()}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 8a7 7 0 1 1 1 7M3 3v5h5" /></svg></button>
        <button type="button" aria-label={t('timeline.outgoing.delete')} disabled={!onDelete || busy} title={t('timeline.outgoing.deleteLocal')} onClick={() => onDelete?.(message.id)}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 5h14M7 5V2h6v3M5 5l1 13h8l1-13M8 8v7m4-7v7" /></svg></button>
      </span> : null}
      {settled && details && (error || recorded) ? <span className="agent-delivery-error">{error || recorded}</span> : null}
    </div>
  </div>;
}
