import { useRef, useState, type ReactNode } from 'react';
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
import { Card } from '../primitives/Card.js';
import { useTranslate } from './locale.js';

export interface InteractionPanelProps {
  readonly request: AgentInteractionRequest;
  readonly readOnly?: boolean;
  readonly waitingForConnection?: boolean;
  readonly onResponse?: (requestId: string, response: AgentInteractionResponse) => Promise<void>;
  readonly questionDraft?: QuestionDraft;
  readonly onQuestionDraftChange?: (draft: QuestionDraft) => void;
  /** Who asks, for the card's sentence; "Assistant" without one. */
  readonly assistantName?: string;
}

/**
 * A request waiting for the person, inline in its turn: approvals as cards with plain choices, questions, forms and external
 * actions in a tinted card that keeps their inputs. Responding, pending and failure words are the same for every kind.
 */
export function InteractionPanel(props: InteractionPanelProps) {
  return <fieldset className="agent-interaction-lock" disabled={props.readOnly || props.waitingForConnection || !props.onResponse}><InteractionContent {...props} />{props.waitingForConnection && !props.readOnly ? <p role="status">Waiting for connection to respond.</p> : null}</fieldset>;
}

function Voiced({ sentence, children }: { sentence: string; children: ReactNode }) {
  return <Card tone="tint" className="agent-interaction-card"><p className="agent-interaction-voice">{sentence}</p>{children}</Card>;
}

function InteractionContent({ request, onResponse, questionDraft, onQuestionDraftChange, readOnly = false, waitingForConnection = false, assistantName }: InteractionPanelProps) {
  const t = useTranslate();
  const name = assistantName || t('conversation.assistant');
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
    return <Voiced sentence={t('approval.form', { name })}><FormCard request={request} onResponse={respond} pending={pending} disabled={readOnly || !onResponse} failure={readOnly || waitingForConnection ? undefined : onResponse ? failure : 'Interaction unavailable. It can be answered when the session is ready.'} /></Voiced>;
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
      return <PermissionApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} assistantName={name} />;
    case 'external_action':
      return <Voiced sentence={t('approval.external', { name })}><ExternalActionCard readOnly={readOnly} request={request} onResponse={respond} pending={pending} failure={failure} /></Voiced>;
    case 'question':
      return <Voiced sentence={t('approval.question', { name })}><QuestionCard readOnly={readOnly} request={request} onResponse={respond} pending={pending} failure={failure} draft={questionDraft} onDraftChange={onQuestionDraftChange} /></Voiced>;
    case 'plan_approval':
      return <PlanApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} assistantName={name} />;
    case 'tool_approval':
      return <ToolApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} assistantName={name} />;
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
