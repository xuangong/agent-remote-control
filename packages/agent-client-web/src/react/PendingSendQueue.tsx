import { useState } from 'react';
import type { WaitingSend } from './usePendingSend.js';
import { useTranslate } from './locale.js';

export function PendingSendQueue({ items, onCancel, onRetry }: {
  items: readonly WaitingSend[]; onCancel(id: string): void; onRetry(id: string): void;
}) {
  const t = useTranslate();
  const [copied, setCopied] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  // A dispatched message is the conversation's own outgoing row from then on: one Sending, never two.
  items = items.filter(item => item.phase !== 'sending');
  if (!items.length) return null;
  return <div className="agent-pending-queue" role="region" aria-label={t('composer.pending.region')}>
    <div className="agent-pending-messages">
      {items.map(item => <span className="agent-pending-message" key={item.id} data-testid="pending-send" data-state={item.phase}>
        <button type="button" className="agent-pending-copy" aria-label={t('composer.pending.copy')} title={`${item.reason ? `${item.reason}\n` : ''}${item.text}\n${t('composer.pending.copyHint')}`}
          onBlur={() => { setCopied(undefined); setCopyError(undefined); }}
          onClick={() => {
            void (navigator.clipboard?.writeText(item.text) ?? Promise.reject(new Error('Clipboard unavailable'))).then(() => { setCopied(item.id); setCopyError(undefined); })
              .catch(() => { setCopyError(item.id); });
          }}>
          <span className="agent-pending-text">{item.text}</span>
          {/* A message waiting for its session says Sending from the key press on, as one that is on its way does. */}
          <span className="agent-pending-state">{item.phase === 'error' ? item.dispatched ? t('composer.pending.checkDelivery') : t('composer.pending.notSent') : copyError === item.id ? t('common.copyFailed') : copied === item.id ? t('common.copied') : t('conversation.sending')}</span>
        </button>
        {item.phase === 'error' && !item.dispatched ? <button type="button" aria-label={t('composer.pending.retry')} onClick={() => onRetry(item.id)}>{t('common.retry')}</button> : null}
        <button type="button" className="agent-pending-dismiss" aria-label={item.dispatched ? t('composer.pending.dismissChecked') : t('composer.pending.cancel')} disabled={item.phase === 'sending'}
          title={item.dispatched ? t('composer.pending.dismissTitle') : t('composer.pending.removeTitle')} onClick={() => onCancel(item.id)}><span aria-hidden="true">×</span></button>
      </span>)}
    </div>
    <span className="agent-visually-hidden" role="status">{t('composer.pending.count', { count: items.length })}</span>
  </div>;
}
