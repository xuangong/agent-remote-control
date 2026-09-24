import { useRef, useState } from 'react';
import type {
  AgentInteractionRequest,
  AgentInteractionResponse,
} from '@orchardworks/agent-remote-protocol';

import { FormCard } from './interactions/FormCard.js';
import { PermissionApprovalCard } from './interactions/PermissionApprovalCard.js';
import { ExternalActionCard } from './interactions/ExternalActionCard.js';
import { PlanApprovalCard } from './interactions/PlanApprovalCard.js';
import { QuestionCard, type QuestionDraft } from './interactions/QuestionCard.js';
import { ToolApprovalCard } from './interactions/ToolApprovalCard.js';

export interface InteractionPanelProps {
  readonly request: AgentInteractionRequest;
  readonly readOnly?: boolean;
  readonly waitingForConnection?: boolean;
  readonly onResponse?: (requestId: string, response: AgentInteractionResponse) => Promise<void>;
  readonly questionDraft?: QuestionDraft;
  readonly onQuestionDraftChange?: (draft: QuestionDraft) => void;
}

export function InteractionPanel(props: InteractionPanelProps) {
  return <fieldset className="agent-interaction-lock" disabled={props.readOnly || props.waitingForConnection || !props.onResponse}><InteractionContent {...props} />{props.waitingForConnection && !props.readOnly ? <p role="status">Waiting for connection to respond.</p> : null}</fieldset>;
}

function InteractionContent({ request, onResponse, questionDraft, onQuestionDraftChange, readOnly = false, waitingForConnection = false }: InteractionPanelProps) {
  const [failure, setFailure] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function respond(response: AgentInteractionResponse): Promise<void> {
    if (readOnly || waitingForConnection || !onResponse || inFlight.current) return;
    inFlight.current = true;
    setFailure(undefined);
    setPending(true);
    try {
      await onResponse(request.requestId, response);
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : 'Interaction response failed.');
      inFlight.current = false;
      setPending(false);
    }
  }

  if (request.kind === 'form') {
    return <FormCard request={request} onResponse={respond} pending={pending} disabled={readOnly || !onResponse} failure={readOnly || waitingForConnection ? undefined : onResponse ? failure : 'Interaction unavailable. Reconnect to respond.'} />;
  }

  if (!onResponse && !readOnly && !waitingForConnection) {
    return <section className="agent-interaction agent-interaction-unavailable" role="status">
      <strong>Interaction unavailable</strong>
      <p>The host cannot respond to this {interactionKindLabel(request.kind)} request.</p>
    </section>;
  }

  if (
    request.kind === 'tool_approval'
    && request.allowedDecisions.includes('allow')
    && request.allowScopes.length === 0
  ) {
    return <section className="agent-interaction agent-interaction-invalid" role="alert">
      <strong>Invalid interaction request</strong>
      <p>Allow was offered with no approval scope.</p>
    </section>;
  }

  switch (request.kind) {
    case 'permission_approval':
      return <PermissionApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} />;
    case 'external_action':
      return <ExternalActionCard readOnly={readOnly} request={request} onResponse={respond} pending={pending} failure={failure} />;
    case 'question':
      return <QuestionCard readOnly={readOnly} request={request} onResponse={respond} pending={pending} failure={failure} draft={questionDraft} onDraftChange={onQuestionDraftChange} />;
    case 'plan_approval':
      return <PlanApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} />;
    case 'tool_approval':
      return <ToolApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} />;
    default: {
      const unsupported = request as { kind?: unknown };
      return <section className="agent-interaction agent-interaction-unsupported" role="status">
        <strong>Unsupported interaction</strong>
        <p>{typeof unsupported.kind === 'string' ? unsupported.kind : 'unknown'}</p>
      </section>;
    }
  }
}

function interactionKindLabel(kind: AgentInteractionRequest['kind']): string {
  switch (kind) {
    case 'form': return 'form';
    case 'permission_approval': return 'permission approval';
    case 'external_action': return 'external action';
    case 'question': return 'question';
    case 'plan_approval': return 'plan approval';
    case 'tool_approval': return 'tool approval';
  }
}
