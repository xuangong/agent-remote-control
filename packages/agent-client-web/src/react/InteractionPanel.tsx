import { errorWords } from '@orchardworks/agent-client';
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
  const t = useTranslate();
  return <fieldset className="agent-interaction-lock" disabled={props.readOnly || props.waitingForConnection || !props.onResponse}><InteractionContent {...props} />{props.waitingForConnection && !props.readOnly ? <p role="status">{t('timeline.interaction.waiting')}</p> : null}</fieldset>;
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
      setFailure(errorWords(error, t, 'timeline.interaction.failed'));
      inFlight.current = false;
      setPending(false);
    }
  }

  if (request.kind === 'form') {
    return <Voiced sentence={t('approval.form', { name })}><FormCard request={request} onResponse={respond} pending={pending} disabled={readOnly || !onResponse} failure={readOnly || waitingForConnection ? undefined : onResponse ? failure : t('timeline.interaction.notReady')} draft={questionDraft} onDraftChange={onQuestionDraftChange} /></Voiced>;
  }

  if (!onResponse && !readOnly && !waitingForConnection) {
    return <section className="agent-interaction agent-interaction-unavailable" role="status">
      <strong>{t('timeline.interaction.unavailable')}</strong>
      <p>{t('timeline.interaction.cannotRespond', { kind: t(interactionKindKey(request.kind)) })}</p>
    </section>;
  }

  if (
    request.kind === 'tool_approval'
    && request.allowedDecisions.includes('allow')
    && request.allowScopes.length === 0
  ) {
    return <section className="agent-interaction agent-interaction-invalid" role="alert">
      <strong>{t('timeline.interaction.invalid')}</strong>
      <p>{t('timeline.interaction.noScope')}</p>
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
      return <PlanApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} assistantName={name} draft={questionDraft} onDraftChange={onQuestionDraftChange} />;
    case 'tool_approval':
      return <ToolApprovalCard request={request} onResponse={respond} pending={pending} failure={failure} assistantName={name} />;
    default: {
      const unsupported = request as { kind?: unknown };
      return <section className="agent-interaction agent-interaction-unsupported" role="status">
        <strong>{t('timeline.interaction.unsupported')}</strong>
        <p>{typeof unsupported.kind === 'string' ? unsupported.kind : t('common.unknown').toLowerCase()}</p>
      </section>;
    }
  }
}

function interactionKindKey(kind: AgentInteractionRequest['kind']) {
  switch (kind) {
    case 'form': return 'timeline.interaction.kind.form' as const;
    case 'permission_approval': return 'timeline.interaction.kind.permission' as const;
    case 'external_action': return 'timeline.interaction.kind.external' as const;
    case 'question': return 'timeline.interaction.kind.question' as const;
    case 'plan_approval': return 'timeline.interaction.kind.plan' as const;
    case 'tool_approval': return 'timeline.interaction.kind.tool' as const;
  }
}
