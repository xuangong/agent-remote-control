import { useState } from 'react';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

import { MarkdownContent } from '../MarkdownContent.js';

export interface PlanApprovalCardProps {
  readonly request: Extract<AgentInteractionRequest, { kind: 'plan_approval' }>;
  readonly onResponse: (response: Extract<AgentInteractionResponse, { kind: 'plan_approval' }>) => Promise<void>;
  readonly pending: boolean;
  readonly failure?: string;
}

export function PlanApprovalCard({ request, onResponse, pending, failure }: PlanApprovalCardProps) {
  const [feedback, setFeedback] = useState('');
  return <section className="agent-interaction agent-plan" aria-labelledby={`${request.requestId}-title`} aria-busy={pending}>
    <header><span className="agent-item-kicker">PLAN REVIEW</span><h3 id={`${request.requestId}-title`}>Review proposed plan</h3></header>
    <MarkdownContent markdown={request.plan} />
    {request.allowedActions.includes('reject') ? <label className="agent-plan-feedback">
      <span>Revision feedback</span>
      <textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={pending} placeholder="What should the Agent change?" rows={3} />
      <small>Add feedback to request a revised plan.</small>
    </label> : null}
    <div className="agent-interaction-actions">
      {request.allowedActions.map((action) => <button
        key={action}
        type="button"
        data-action={action}
        disabled={pending}
        onClick={async () => {
          await onResponse(action === 'reject'
            ? { kind: 'plan_approval', action, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) }
            : { kind: 'plan_approval', action });
        }}
      >{pending ? 'Submitting…' : planActionLabel(action, feedback.trim().length > 0)}</button>)}
      {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
    </div>
  </section>;
}

function planActionLabel(action: Extract<AgentInteractionRequest, { kind: 'plan_approval' }>['allowedActions'][number], hasFeedback: boolean): string {
  switch (action) {
    case 'approve': return 'Approve';
    case 'approve_and_resume': return 'Approve and execute';
    case 'reject': return hasFeedback ? 'Request changes' : 'Request revision';
  }
}
