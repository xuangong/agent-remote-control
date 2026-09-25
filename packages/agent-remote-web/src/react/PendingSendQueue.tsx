import { useState } from 'react';
import type { WaitingSend } from './usePendingSend.js';

export function PendingSendQueue({ items, onCancel, onRetry }: {
  items: readonly WaitingSend[]; onCancel(id: string): void; onRetry(id: string): void;
}) {
  const [copied, setCopied] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  if (!items.length) return null;
  return <div className="agent-pending-queue" role="region" aria-label="Pending messages on this device">
    <div className="agent-pending-messages">
      {items.map(item => <span className="agent-pending-message" key={item.id} data-testid="pending-send" data-state={item.phase}>
        <button type="button" className="agent-pending-copy" aria-label="Copy pending message" title={`${item.reason ? `${item.reason}\n` : ''}${item.text}\nClick to copy · Kept in this page until sent`}
          onBlur={() => { setCopied(undefined); setCopyError(undefined); }}
          onClick={() => {
            void (navigator.clipboard?.writeText(item.text) ?? Promise.reject(new Error('Clipboard unavailable'))).then(() => { setCopied(item.id); setCopyError(undefined); })
              .catch(() => { setCopyError(item.id); });
          }}>
          <span className="agent-pending-text">{item.text}</span>
          {item.phase === 'error' || item.phase === 'sending' || copyError === item.id || copied === item.id ? <span className="agent-pending-state">{item.phase === 'error' ? item.dispatched ? 'Check delivery' : 'Not sent' : copyError === item.id ? 'Copy failed' : copied === item.id ? 'Copied' : 'Sending'}</span> : null}
        </button>
        {item.phase === 'error' && !item.dispatched ? <button type="button" aria-label="Retry pending send" onClick={() => onRetry(item.id)}>Retry</button> : null}
        <button type="button" className="agent-pending-dismiss" aria-label={item.dispatched ? 'Dismiss message after checking delivery' : 'Cancel pending send'} disabled={item.phase === 'sending'}
          title={item.dispatched ? 'Check delivery before dismissing. This does not recall the message.' : 'Remove from pending queue'} onClick={() => onCancel(item.id)}><span aria-hidden="true">×</span></button>
      </span>)}
    </div>
    <span className="agent-visually-hidden" role="status">{items.length} pending messages. Kept in this page until sent.</span>
  </div>;
}
