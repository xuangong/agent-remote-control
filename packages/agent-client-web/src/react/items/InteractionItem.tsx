import type { AgentInteractionRequest, AgentInteractionResponse, AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import type { Translate } from '@orchardworks/agent-client';

import { MarkdownContent } from '../MarkdownContent.js';
import { useTranslate } from '../locale.js';
import { ToolApprovalDetails } from '../interactions/ToolApprovalDetails.js';
import { CompletedQuestionItem, questionReceipt } from './CompletedQuestionItem.js';
import { ReceiptLine } from './ReceiptLine.js';

export interface InteractionItemProps {
  readonly item: Extract<AgentTimelineItem, { type: 'interaction' }>;
}

/** An answered interaction: one line saying how it was answered, today's receipt detail when it is opened. */
export function InteractionItem({ item: { request, response } }: InteractionItemProps) {
  const t = useTranslate();
  if (request.kind === 'question' && response.kind === 'question') {
    const receipt = questionReceipt(request, response);
    const subject = !response.dismissed && receipt.answered < receipt.total ? t('receipt.answeredOf', receipt) : t('receipt.questions', { count: receipt.total });
    return <ReceiptLine kind="question" className="agent-question-completed" result={t(receipt.status)} subject={subject}>
      <CompletedQuestionItem request={request} response={response} />
    </ReceiptLine>;
  }
  if (request.kind === 'plan_approval' && response.kind === 'plan_approval') {
    return <ReceiptLine kind="plan_approval" className="agent-plan-completed"
      result={t(response.action === 'reject' ? 'receipt.planRejected' : response.action === 'approve_and_resume' ? 'receipt.planResumed' : 'receipt.planApproved')}>
      <MarkdownContent markdown={request.plan} />
      {response.action === 'reject' && response.feedback ? <section className="agent-plan-revision"><h3>{t('timeline.receipt.revisionFeedback')}</h3><p>{response.feedback}</p></section> : null}
    </ReceiptLine>;
  }
  if (request.kind === 'tool_approval' && response.kind === 'tool_approval') {
    const policy = response.decision === 'allow' && response.scope === 'policy' ? request.policies?.find(candidate => candidate.policyId === response.policyId) : undefined;
    return <ReceiptLine kind="tool_approval" className="agent-tool-approval-completed" result={toolReceipt(response, t)} subject={request.toolName}>
      <ToolApprovalDetails request={request} />
      {policy ? <div className="agent-approval-applied-rule"><span className="agent-approval-label">{t('timeline.receipt.appliedRule')}</span><p>{policy.description}</p></div> : null}
      {response.decision === 'deny' && response.message ? <p>{response.message}</p> : null}
    </ReceiptLine>;
  }
  return <OtherReceipt request={request} response={response} t={t} />;
}

function toolReceipt(response: Extract<AgentInteractionResponse, { kind: 'tool_approval' }>, t: Translate): string {
  if (response.decision === 'allow') return t(response.scope === 'policy' ? 'receipt.ruleApplied' : response.scope === 'session' ? 'receipt.allowedSession' : 'receipt.allowedOnce');
  return t(response.decision === 'cancel' ? 'receipt.canceled' : 'receipt.denied');
}

function OtherReceipt({ request, response, t }: { request: AgentInteractionRequest; response: AgentInteractionResponse; t: Translate }) {
  if (request.kind === 'form' && response.kind === 'form') {
    return <ReceiptLine kind="form" result={t(response.action === 'submit' ? 'receipt.submitted' : response.action === 'cancel' ? 'receipt.canceled' : 'receipt.declined')} subject={request.title}>
      {response.action === 'submit' ? <dl className="agent-form-receipt">{request.fields.map((field) => {
        const value = response.values[field.fieldId];
        const hidden = field.sensitive || response.redactedFields?.includes(field.fieldId);
        const shown = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? t(value ? 'common.yes' : 'common.no') : value === undefined || value === null ? t('timeline.receipt.notProvided') : String(value);
        return <div key={field.fieldId}><dt>{field.label}</dt><dd>{hidden ? t('timeline.question.hidden') : shown}</dd></div>;
      })}</dl> : <p>{request.message}</p>}
    </ReceiptLine>;
  }
  if (request.kind === 'permission_approval' && response.kind === 'permission_approval') {
    return <ReceiptLine kind="permission_approval" result={t(response.decision === 'deny' ? 'receipt.denied' : response.scope === 'session' ? 'receipt.permissionSession' : 'receipt.permissionTurn')} subject={request.summary}>
      <ul className="agent-permission-list">{request.permissions.map((permission, index) => <li key={index}><strong>{permission.access} · {permission.resource}</strong><code>{permission.target}</code></li>)}</ul>
    </ReceiptLine>;
  }
  if (request.kind === 'external_action' && response.kind === 'external_action') {
    return <ReceiptLine kind="external_action" result={t(response.action === 'completed' ? 'receipt.completed' : response.action === 'cancel' ? 'receipt.canceled' : 'receipt.declined')} subject={request.title}>
      <p>{request.message}</p><p><code>{request.url}</code></p>
    </ReceiptLine>;
  }
  return <article className="agent-item agent-interaction-completed" role="status">{t('receipt.mismatch')}</article>;
}
