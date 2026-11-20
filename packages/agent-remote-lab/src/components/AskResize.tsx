import { useId } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';

export function AskResize({ label = 'Ask' }: { label?: string } = {}) {
  const t = useTranslate();
  const hint = useId();
  return <div className="lab-ask-resize-footer">
    <span id={hint} className="agent-visually-hidden">{t('team.resize.hint')}</span>
    <button type="button" className="lab-ask-resize" aria-label={t('team.resize.label', { label })} aria-describedby={hint}
      aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown" title={t('team.resize.title', { label })}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
        <path d="M5 13 13 5M9 13l4-4" />
      </svg>
    </button>
  </div>;
}
