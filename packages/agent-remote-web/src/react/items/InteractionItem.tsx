import type { AgentTimelineItem } from '@borgee/agent-remote-protocol';

import { InteractionReceipt } from './InteractionReceipt.js';
import { MarkdownContent } from '../MarkdownContent.js';
import { CompletedQuestionItem } from './CompletedQuestionItem.js';
import { ToolDetail } from './ToolCallItem.js';

export interface InteractionItemProps {
  readonly item: Extract<AgentTimelineItem, { type: 'interaction' }>;
}

export function InteractionItem({ item: { request, response } }: InteractionItemProps) {
  if (request.kind === 'question' && response.kind === 'question') {
    return <CompletedQuestionItem request={request} response={response} />;
  }
  if (request.kind === 'plan_approval' && response.kind === 'plan_approval') {
    return <article className="agent-item agent-interaction-completed agent-plan-completed">
      <header><span className="agent-item-kicker">PLAN REVIEW</span><span className="agent-state-label">{response.action === 'reject' ? 'Rejected' : response.action === 'approve_and_resume' ? 'Approved and resumed' : 'Approved'}</span></header>
      <MarkdownContent markdown={request.plan} />
      {response.action === 'reject' && response.feedback ? <section className="agent-plan-revision"><h3>Revision feedback</h3><p>{response.feedback}</p></section> : null}
    </article>;
  }
  if (request.kind === 'tool_approval' && response.kind === 'tool_approval') {
    return <article className="agent-item agent-interaction-completed agent-tool-approval-completed">
      <header><span className="agent-item-kicker">TOOL APPROVAL</span><span className="agent-state-label">{response.decision === 'allow' ? `Allowed · ${response.scope}` : response.decision === 'cancel' ? 'Canceled' : 'Denied'}</span></header>
      <h3>{request.toolName}</h3><p>{request.summary}</p><ToolDetail detail={request.detail} />
      {response.decision === 'deny' && response.message ? <p>{response.message}</p> : null}
    </article>;
  }
  return <InteractionReceipt request={request} response={response} />;
}
