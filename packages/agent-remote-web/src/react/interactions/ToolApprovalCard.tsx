import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';
import { useId } from 'react';

import { ToolApprovalDetails } from './ToolApprovalDetails.js';

export interface ToolApprovalCardProps {
  readonly request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
  readonly onResponse: (response: Extract<AgentInteractionResponse, { kind: 'tool_approval' }>) => Promise<void>;
  readonly pending: boolean;
  readonly failure?: string;
}

export function ToolApprovalCard({ request, onResponse, pending, failure }: ToolApprovalCardProps) {
  const id = useId();
  const policies = request.allowedDecisions.includes('allow') && request.allowScopes.includes('policy') ? request.policies : undefined;
  return <section className="agent-interaction agent-tool-approval" aria-labelledby={`${id}-title`} aria-busy={pending}>
    <header className="agent-approval-heading">
      <h3 id={`${id}-title`}>Approval required</h3>
      <span className="agent-approval-tool-name">{request.toolName}</span>
    </header>
    <ToolApprovalDetails request={request} />
    <div className="agent-interaction-actions agent-approval-actions">
      {request.allowedDecisions.includes('allow')
        ? request.allowScopes.filter((scope) => scope !== 'policy').map((scope) => <button
            key={scope}
            type="button"
            data-decision="allow"
            data-scope={scope}
            disabled={pending}
            onClick={async () => { await onResponse({ kind: 'tool_approval', decision: 'allow', scope }); }}
          >{`Allow ${scope === 'once' ? 'once' : 'for session'}`}</button>)
        : null}
      {request.allowedDecisions.includes('cancel') ? <button type="button" disabled={pending} data-decision="cancel" onClick={() => void onResponse({ kind: 'tool_approval', decision: 'cancel' })}>Cancel</button> : null}
      {request.allowedDecisions.includes('deny') ? <button
        type="button"
        data-decision="deny"
        disabled={pending}
        onClick={async () => { await onResponse({ kind: 'tool_approval', decision: 'deny' }); }}
      >Deny</button> : null}
    </div>
    {policies?.length ? <details className="agent-approval-rules">
      <summary>Rules for future requests <span className="agent-approval-rule-count">{policies.length}</span></summary>
      <ul>{policies.map((policy, index) => <li key={policy.policyId}>
        <p id={`${id}-rule-${index}`}>{policy.description}</p>
        <div className="agent-interaction-actions"><button type="button" disabled={pending}
          aria-describedby={`${id}-rule-${index}`} data-policy-id={policy.policyId}
          onClick={() => void onResponse({ kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: policy.policyId })}>Apply rule</button></div>
      </li>)}</ul>
    </details> : null}
    {pending ? <p className="agent-approval-submitting" role="status">Submitting…</p> : null}
    {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
  </section>;
}
