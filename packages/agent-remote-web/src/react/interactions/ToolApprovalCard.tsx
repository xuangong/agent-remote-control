import type { AgentInteractionRequest, AgentInteractionResponse } from '@agent-remote-controller/agent-remote-protocol';

import { ToolCallDetails } from '../items/ToolCallItem.js';

export interface ToolApprovalCardProps {
  readonly request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
  readonly onResponse: (response: Extract<AgentInteractionResponse, { kind: 'tool_approval' }>) => Promise<void>;
  readonly pending: boolean;
  readonly failure?: string;
}

export function ToolApprovalCard({ request, onResponse, pending, failure }: ToolApprovalCardProps) {
  return <section className="agent-interaction agent-tool-approval" aria-labelledby={`${request.requestId}-title`} aria-busy={pending}>
    <header><span className="agent-item-kicker">TOOL AUTHORIZATION</span><h3 id={`${request.requestId}-title`}>{request.toolName}</h3></header>
    <p>{request.summary}</p>
    <ToolCallDetails detail={request.detail} />
    {request.context?.length ? <dl className="agent-approval-context">{request.context.map(({ label, value }, index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : null}
    <div className="agent-interaction-actions">
      {request.allowedDecisions.includes('allow')
        ? request.allowScopes.filter((scope) => scope !== 'policy').map((scope) => <button
            key={scope}
            type="button"
            data-decision="allow"
            data-scope={scope}
            disabled={pending}
            onClick={async () => { await onResponse({ kind: 'tool_approval', decision: 'allow', scope }); }}
          >{pending ? 'Submitting…' : `Allow ${scope === 'once' ? 'once' : 'for session'}`}</button>)
        : null}
      {request.allowedDecisions.includes('allow') && request.allowScopes.includes('policy') ? request.policies?.map((policy) => <button key={policy.policyId} type="button" disabled={pending} data-policy-id={policy.policyId} onClick={() => void onResponse({ kind: 'tool_approval', decision: 'allow', scope: 'policy', policyId: policy.policyId })}>{policy.description}</button>) : null}
      {request.allowedDecisions.includes('cancel') ? <button type="button" disabled={pending} data-decision="cancel" onClick={() => void onResponse({ kind: 'tool_approval', decision: 'cancel' })}>Cancel</button> : null}
      {request.allowedDecisions.includes('deny') ? <button
        type="button"
        data-decision="deny"
        disabled={pending}
        onClick={async () => { await onResponse({ kind: 'tool_approval', decision: 'deny' }); }}
      >{pending ? 'Submitting…' : 'Deny'}</button> : null}
      {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
    </div>
  </section>;
}
