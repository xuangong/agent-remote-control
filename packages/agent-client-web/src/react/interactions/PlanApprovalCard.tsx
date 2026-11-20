import { useId, useState } from 'react';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';
import type { Translate } from '@orchardworks/agent-client';

import { Pill } from '../../primitives/Pill.js';
import { MarkdownContent } from '../MarkdownContent.js';
import { useTranslate } from '../locale.js';
import { ApprovalChanges } from './ApprovalChanges.js';

export interface PlanApprovalCardProps {
  readonly request: Extract<AgentInteractionRequest, { kind: 'plan_approval' }>;
  readonly onResponse: (response: Extract<AgentInteractionResponse, { kind: 'plan_approval' }>) => Promise<void>;
  readonly pending: boolean;
  readonly failure?: string;
  readonly assistantName?: string;
}

/**
 * A plan review inline: Allow approves it, Not now asks for changes without words; the plan, revision feedback and every
 * action (Approve, Approve and execute, Request changes) are under Show what changes.
 */
export function PlanApprovalCard({ request, onResponse, pending, failure, assistantName }: PlanApprovalCardProps) {
  const id = useId();
  const t = useTranslate();
  const [feedback, setFeedback] = useState('');
  const approve = request.allowedActions.includes('approve') ? 'approve' : request.allowedActions.includes('approve_and_resume') ? 'approve_and_resume' : undefined;
  const respond = (action: PlanApprovalCardProps['request']['allowedActions'][number]) => onResponse(action === 'reject'
    ? { kind: 'plan_approval', action, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }
    : { kind: 'plan_approval', action });
  return <section className="agent-interaction agent-plan orchard-approval" aria-labelledby={`${id}-title`} aria-busy={pending}>
    <p id={`${id}-title`} className="orchard-approval-prompt">{t('approval.plan', { name: assistantName || t('conversation.assistant') })}</p>
    <div className="orchard-approval-choices">
      {approve ? <Pill variant="primary" data-choice="allow" disabled={pending} onClick={() => void respond(approve)}>{t('approval.allow')}</Pill> : null}
      {request.allowedActions.includes('reject') ? <Pill data-choice="not-now" disabled={pending} onClick={() => void onResponse({ kind: 'plan_approval', action: 'reject' })}>{t('approval.notNow')}</Pill> : null}
      <ApprovalChanges>
        <MarkdownContent markdown={request.plan} />
        {request.allowedActions.includes('reject') ? <label className="agent-plan-feedback">
          <span>{t('timeline.receipt.revisionFeedback')}</span>
          <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={pending} placeholder={t('timeline.plan.feedbackPlaceholder')} rows={3} />
          <small>{t('timeline.plan.feedbackHint')}</small>
        </label> : null}
        <div className="agent-interaction-actions">
          {request.allowedActions.map((action) => <button key={action} type="button" data-action={action} disabled={pending}
            onClick={() => void respond(action)}>{pending ? t('timeline.interaction.submitting') : planActionLabel(action, feedback.trim().length > 0, t)}</button>)}
        </div>
      </ApprovalChanges>
    </div>
    {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
  </section>;
}

function planActionLabel(action: Extract<AgentInteractionRequest, { kind: 'plan_approval' }>['allowedActions'][number], hasFeedback: boolean, t: Translate): string {
  switch (action) {
    case 'approve': return t('timeline.plan.approve');
    case 'approve_and_resume': return t('timeline.plan.approveAndExecute');
    case 'reject': return t(hasFeedback ? 'timeline.plan.requestChanges' : 'timeline.plan.requestRevision');
  }
}
