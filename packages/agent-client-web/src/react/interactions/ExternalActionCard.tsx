import { useTranslate } from '../locale.js';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

interface Props {
  request: Extract<AgentInteractionRequest, { kind: 'external_action' }>;
  onResponse: (response: Extract<AgentInteractionResponse, { kind: 'external_action' }>) => Promise<void>;
  pending: boolean;
  readOnly?: boolean;
  failure?: string;
}

export function safeExternalUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}

export function ExternalActionCard({ request, onResponse, pending, failure, readOnly = false }: Props) {
  const t = useTranslate();
  const url = safeExternalUrl(request.url);
  return <section className="agent-interaction agent-external-action" aria-busy={pending}>
    <header><span className="agent-item-kicker">{t('timeline.external.kicker')}</span><h3>{request.title}</h3></header>
    <p>{request.message}</p>
    {url && readOnly ? <p>{t('timeline.external.recorded', { url })}</p> : url ? <a className="agent-external-link" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('timeline.external.open', { host: new URL(url).host })}<span aria-hidden="true"> ↗</span></a> : <p role="alert">{t('timeline.external.cannotOpen')}</p>}
    {url && !readOnly ? <small>{t('timeline.external.return')}</small> : null}
    <div className="agent-interaction-actions">
      {url ? <button type="button" disabled={pending} data-action="completed" onClick={() => void onResponse({ kind: 'external_action', action: 'completed' })}>{t('timeline.external.completed')}</button> : null}
      <button type="button" disabled={pending} data-action="decline" onClick={() => void onResponse({ kind: 'external_action', action: 'decline' })}>{t('timeline.interaction.decline')}</button>
      <button type="button" disabled={pending} data-action="cancel" onClick={() => void onResponse({ kind: 'external_action', action: 'cancel' })}>{t('common.cancel')}</button>
    </div>
    {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
  </section>;
}
