import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';
import { fileName, type Translate } from '@orchardworks/agent-client';
import { useId } from 'react';

import { Pill } from '../../primitives/Pill.js';
import { useTranslate } from '../locale.js';
import { ToolApprovalDetails } from './ToolApprovalDetails.js';
import { ApprovalChanges } from './ApprovalChanges.js';

export interface ToolApprovalCardProps {
  readonly request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
  readonly onResponse: (response: Extract<AgentInteractionResponse, { kind: 'tool_approval' }>) => Promise<void>;
  readonly pending: boolean;
  readonly failure?: string;
  /** Who asks, for the card's sentence ("Chief wants to write notes.md"). */
  readonly assistantName?: string;
}

/** What the assistant asks to do, in its voice: the command, file, page or tool of the request. */
export function toolApprovalPrompt(request: ToolApprovalCardProps['request'], name: string, t: Translate): string {
  const { detail } = request;
  switch (detail.type) {
    case 'shell': return t('approval.runCommand', { name });
    case 'read': return t('approval.readFile', { name, file: fileName(detail.filePath) });
    case 'edit': return t('approval.editFile', { name, file: fileName(detail.filePath) });
    case 'write': return t('approval.writeFile', { name, file: fileName(detail.filePath) });
    case 'search': return t('approval.search', { name });
    case 'fetch': return t('approval.fetch', { name, url: detail.url });
    case 'other': return t('approval.useTool', { name, tool: request.toolName });
  }
}

/**
 * A tool approval inline in the conversation (I3 plan, decision 5): plain choices, Allow (allow once, or the only scope
 * offered) and Not now (deny, or cancel), and Show what changes, which opens the command, its working directory and
 * context, the full set of decisions and the rules for future requests in the card.
 */
export function ToolApprovalCard({ request, onResponse, pending, failure, assistantName }: ToolApprovalCardProps) {
  const id = useId();
  const t = useTranslate();
  const allows = request.allowedDecisions.includes('allow');
  const scopes = allows ? request.allowScopes.filter(scope => scope !== 'policy') : [];
  const allowScope = scopes.includes('once') ? 'once' : scopes[0];
  const notNow = request.allowedDecisions.includes('deny') ? 'deny' : request.allowedDecisions.includes('cancel') ? 'cancel' : undefined;
  const policies = allows && request.allowScopes.includes('policy') ? request.policies : undefined;
  const name = assistantName || t('conversation.assistant');
  return <section className="agent-interaction agent-tool-approval orchard-approval" aria-labelledby={`${id}-title`} aria-busy={pending}>
    <p id={`${id}-title`} className="orchard-approval-prompt">{toolApprovalPrompt(request, name, t)}</p>
    <p className="agent-approval-caption"><span className="agent-approval-tool-name">{request.toolName}</span>{request.summary ? <> · {request.summary}</> : null}</p>
    <div className="orchard-approval-choices">
      {allowScope ? <Pill variant="primary" data-decision="allow" data-scope={allowScope} disabled={pending}
        onClick={() => void onResponse({ kind: 'tool_approval', decision: 'allow', scope: allowScope })}>{t('approval.allow')}</Pill> : null}
      {notNow ? <Pill data-decision={notNow} disabled={pending}
        onClick={() => void onResponse({ kind: 'tool_approval', decision: notNow })}>{t('approval.notNow')}</Pill> : null}
      <ApprovalChanges>
        <ToolApprovalDetails request={request} />
        <div className="agent-interaction-actions agent-approval-actions">
          {scopes.map(scope => <button key={scope} type="button" data-decision="allow" data-scope={scope} disabled={pending}
            onClick={() => void onResponse({ kind: 'tool_approval', decision: 'allow', scope })}>{`Allow ${scope === 'once' ? 'once' : 'for session'}`}</button>)}
          {request.allowedDecisions.includes('cancel') ? <button type="button" disabled={pending} data-decision="cancel" onClick={() => void onResponse({ kind: 'tool_approval', decision: 'cancel' })}>Cancel</button> : null}
          {request.allowedDecisions.includes('deny') ? <button type="button" data-decision="deny" disabled={pending} onClick={() => void onResponse({ kind: 'tool_approval', decision: 'deny' })}>Deny</button> : null}
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
      </ApprovalChanges>
    </div>
    {pending ? <p className="agent-approval-submitting" role="status">Submitting…</p> : null}
    {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
  </section>;
}
