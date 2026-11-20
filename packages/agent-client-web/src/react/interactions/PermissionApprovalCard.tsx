import { useId } from 'react';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';
import { Pill } from '../../primitives/Pill.js';
import { useTranslate } from '../locale.js';
import { ApprovalChanges } from './ApprovalChanges.js';

interface Props {
  request: Extract<AgentInteractionRequest, { kind: 'permission_approval' }>;
  onResponse: (response: Extract<AgentInteractionResponse, { kind: 'permission_approval' }>) => Promise<void>;
  pending: boolean;
  failure?: string;
  assistantName?: string;
}

/** A permission request inline: Allow (for this turn, or the only scope offered) and Not now; the access asked for and every scope under Show what changes. */
export function PermissionApprovalCard({ request, onResponse, pending, failure, assistantName }: Props) {
  const id = useId();
  const t = useTranslate();
  const scope = request.allowScopes.includes('turn') ? 'turn' : request.allowScopes[0];
  return <section className="agent-interaction agent-permission orchard-approval" aria-labelledby={`${id}-title`} aria-busy={pending}>
    <p id={`${id}-title`} className="orchard-approval-prompt">{t('approval.permission', { name: assistantName || t('conversation.assistant') })}</p>
    <p className="agent-approval-caption">{request.summary}</p>
    <div className="orchard-approval-choices">
      {scope ? <Pill variant="primary" data-scope={scope} disabled={pending} onClick={() => void onResponse({ kind: 'permission_approval', decision: 'allow', scope })}>{t('approval.allow')}</Pill> : null}
      <Pill data-decision="deny" disabled={pending} onClick={() => void onResponse({ kind: 'permission_approval', decision: 'deny' })}>{t('approval.notNow')}</Pill>
      <ApprovalChanges>
        <ul className="agent-permission-list">{request.permissions.map((permission, index) => <li key={index}><strong>{permission.access} · {permission.resource}</strong><code>{permission.target}</code></li>)}</ul>
        <div className="agent-interaction-actions">
          {request.allowScopes.map(option => <button key={option} type="button" disabled={pending} data-scope={option} onClick={() => void onResponse({ kind: 'permission_approval', decision: 'allow', scope: option })}>{t(option === 'turn' ? 'timeline.approval.allowTurn' : 'timeline.approval.allowSession')}</button>)}
          <button type="button" disabled={pending} data-decision="deny" onClick={() => void onResponse({ kind: 'permission_approval', decision: 'deny' })}>{t('timeline.approval.deny')}</button>
        </div>
      </ApprovalChanges>
    </div>
    {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
  </section>;
}
