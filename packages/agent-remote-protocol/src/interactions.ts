import { type Static, Type } from '@sinclair/typebox';

import { ProtocolVersionSchema } from './version.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

export const AgentToolDetail = Type.Union([
  Strict({ type: Type.Literal('shell'), command: NonEmptyString, cwd: Type.Optional(NonEmptyString) }),
  Strict({ type: Type.Literal('read'), filePath: NonEmptyString }),
  Strict({ type: Type.Literal('edit'), filePath: NonEmptyString }),
  Strict({ type: Type.Literal('write'), filePath: NonEmptyString }),
  Strict({ type: Type.Literal('search'), query: NonEmptyString }),
  Strict({ type: Type.Literal('fetch'), url: NonEmptyString }),
  Strict({ type: Type.Literal('other'), description: NonEmptyString }),
]);
export type AgentToolDetail = Static<typeof AgentToolDetail>;

export const AgentQuestionOption = Strict({
  value: NonEmptyString,
  label: NonEmptyString,
  description: Type.Optional(Type.String()),
});
export type AgentQuestionOption = Static<typeof AgentQuestionOption>;

export const AgentQuestion = Strict({
  questionId: NonEmptyString,
  header: NonEmptyString,
  prompt: NonEmptyString,
  description: Type.Optional(Type.String()),
  required: Type.Boolean(),
  selection: Type.Union([Type.Literal('single'), Type.Literal('multiple')]),
  options: Type.Array(AgentQuestionOption),
  allowCustomText: Type.Boolean(),
  allowDismiss: Type.Boolean(),
});
export type AgentQuestion = Static<typeof AgentQuestion>;

export const AgentPlanAction = Type.Union([
  Type.Literal('approve'),
  Type.Literal('approve_and_resume'),
  Type.Literal('reject'),
]);
export type AgentPlanAction = Static<typeof AgentPlanAction>;

export const AgentToolDecision = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);
export type AgentToolDecision = Static<typeof AgentToolDecision>;

export const AgentToolApprovalScope = Type.Union([Type.Literal('once'), Type.Literal('session')]);
export type AgentToolApprovalScope = Static<typeof AgentToolApprovalScope>;

export const AgentInteractionRequest = Type.Union([
  Strict({
    kind: Type.Literal('question'),
    requestId: NonEmptyString,
    questions: Type.Array(AgentQuestion, { minItems: 1 }),
  }),
  Strict({
    kind: Type.Literal('plan_approval'),
    requestId: NonEmptyString,
    plan: Type.String(),
    allowedActions: Type.Array(AgentPlanAction, { minItems: 1, uniqueItems: true }),
  }),
  Strict({
    kind: Type.Literal('tool_approval'),
    requestId: NonEmptyString,
    toolCallId: NonEmptyString,
    toolName: NonEmptyString,
    summary: Type.String(),
    detail: AgentToolDetail,
    allowedDecisions: Type.Array(AgentToolDecision, { minItems: 1, uniqueItems: true }),
    allowScopes: Type.Array(AgentToolApprovalScope, { uniqueItems: true }),
  }),
]);
export type AgentInteractionRequest = Static<typeof AgentInteractionRequest>;

export const AgentQuestionAnswer = Strict({
  questionId: NonEmptyString,
  selectedValues: Type.Array(NonEmptyString, { uniqueItems: true }),
  customText: Type.Optional(Type.String()),
});
export type AgentQuestionAnswer = Static<typeof AgentQuestionAnswer>;

export const AgentInteractionResponse = Type.Union([
  Strict({
    kind: Type.Literal('question'),
    answers: Type.Array(AgentQuestionAnswer),
    dismissed: Type.Optional(Type.Boolean()),
  }),
  Strict({
    kind: Type.Literal('plan_approval'),
    action: Type.Union([Type.Literal('approve'), Type.Literal('approve_and_resume')]),
  }),
  Strict({ kind: Type.Literal('plan_approval'), action: Type.Literal('reject'), feedback: Type.Optional(Type.String()) }),
  Strict({
    kind: Type.Literal('tool_approval'),
    decision: Type.Literal('allow'),
    scope: AgentToolApprovalScope,
  }),
  Strict({
    kind: Type.Literal('tool_approval'),
    decision: Type.Literal('deny'),
    message: Type.Optional(Type.String()),
  }),
]);
export type AgentInteractionResponse = Static<typeof AgentInteractionResponse>;

export const InteractionResponseMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('interaction_response'),
  payload: Strict({
    agentId: NonEmptyString,
    requestId: NonEmptyString,
    response: AgentInteractionResponse,
  }),
});
export type InteractionResponseMessage = Static<typeof InteractionResponseMessage>;

export const InteractionRequestedMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('interaction_requested'),
  payload: Strict({ agentId: NonEmptyString, request: AgentInteractionRequest }),
});
export type InteractionRequestedMessage = Static<typeof InteractionRequestedMessage>;

export const InteractionResolvedMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('interaction_resolved'),
  payload: Strict({
    agentId: NonEmptyString,
    requestId: NonEmptyString,
    response: AgentInteractionResponse,
  }),
});
export type InteractionResolvedMessage = Static<typeof InteractionResolvedMessage>;
