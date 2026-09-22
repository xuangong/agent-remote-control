import { useId } from 'react';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

import { useItemDisclosure } from '../TimelineDisplay.js';
import { TimelineTitle } from '../TimelineTitle.js';
import { ToolApprovalDetails } from '../interactions/ToolApprovalDetails.js';

export function CompletedToolApprovalItem({ request, response }: {
  readonly request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
  readonly response: Extract<AgentInteractionResponse, { kind: 'tool_approval' }>;
}) {
  const { expanded, toggle } = useItemDisclosure();
  const detailsId = useId();
  const policy = response.decision === 'allow' && response.scope === 'policy'
    ? request.policies?.find(policy => policy.policyId === response.policyId) : undefined;
  const result = response.decision === 'allow'
    ? response.scope === 'policy' ? 'Rule applied' : response.scope === 'session' ? 'Allowed for session' : 'Allowed once'
    : response.decision === 'cancel' ? 'Canceled' : 'Denied';
  return <article className="agent-item agent-interaction-completed agent-tool-approval-completed">
    <button className="agent-approval-receipt-toggle" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={toggle}>
      <span className="agent-tool-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      <TimelineTitle disclose={toggle}>Tool approval</TimelineTitle>
      <span className="agent-approval-tool-name" title={request.toolName}>{request.toolName}</span>
      <span className="agent-approval-result">{result}</span>
    </button>
    <div id={detailsId} className="agent-approval-receipt-details" hidden={!expanded}>
      {expanded ? <>
        <ToolApprovalDetails request={request} />
        {policy ? <div className="agent-approval-applied-rule"><span className="agent-approval-label">Applied rule</span><p>{policy.description}</p></div> : null}
        {response.decision === 'deny' && response.message ? <p>{response.message}</p> : null}
      </> : null}
    </div>
  </article>;
}
