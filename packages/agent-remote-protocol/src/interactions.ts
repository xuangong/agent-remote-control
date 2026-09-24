import { type Static, Type } from '@sinclair/typebox';

import { ProtocolVersionSchema } from './version.js';
import { OperationId } from './operations.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

const SessionReference = Strict({ nativeSessionId: NonEmptyString, title: NonEmptyString });

export const AgentToolDetail = Type.Union([
  Strict({ type: Type.Literal('shell'), command: NonEmptyString, cwd: Type.Optional(NonEmptyString) }),
  Strict({ type: Type.Literal('read'), filePath: NonEmptyString }),
  Strict({ type: Type.Literal('edit'), filePath: NonEmptyString }),
  Strict({ type: Type.Literal('write'), filePath: NonEmptyString }),
  Strict({ type: Type.Literal('search'), query: NonEmptyString }),
  Strict({ type: Type.Literal('fetch'), url: NonEmptyString }),
  Strict({ type: Type.Literal('other'), description: NonEmptyString, sessionReference: Type.Optional(SessionReference), sessionReferences: Type.Optional(Type.Array(SessionReference)) }),
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
  sensitive: Type.Optional(Type.Boolean()),
});
export type AgentQuestion = Static<typeof AgentQuestion>;

export const AgentPlanAction = Type.Union([
  Type.Literal('approve'),
  Type.Literal('approve_and_resume'),
  Type.Literal('reject'),
]);
export type AgentPlanAction = Static<typeof AgentPlanAction>;

export const AgentToolDecision = Type.Union([Type.Literal('allow'), Type.Literal('deny'), Type.Literal('cancel')]);
export type AgentToolDecision = Static<typeof AgentToolDecision>;

export const AgentToolApprovalScope = Type.Union([Type.Literal('once'), Type.Literal('session'), Type.Literal('policy')]);
export type AgentToolApprovalScope = Static<typeof AgentToolApprovalScope>;

export const AgentFormOption = Strict({ value: NonEmptyString, label: NonEmptyString });
export type AgentFormOption = Static<typeof AgentFormOption>;
const FormFieldBase = {
  fieldId: NonEmptyString, label: NonEmptyString, required: Type.Boolean(),
  description: Type.Optional(Type.String()), sensitive: Type.Optional(Type.Boolean()),
};
const NonNegativeInteger = Type.Integer({ minimum: 0 });
export const AgentFormField = Type.Union([
  Strict({ ...FormFieldBase, type: Type.Literal('text'), minLength: Type.Optional(NonNegativeInteger), maxLength: Type.Optional(NonNegativeInteger), format: Type.Optional(Type.Union([Type.Literal('email'), Type.Literal('uri'), Type.Literal('date'), Type.Literal('date-time')])), defaultValue: Type.Optional(Type.String()) }),
  Strict({ ...FormFieldBase, type: Type.Literal('number'), integer: Type.Optional(Type.Boolean()), minimum: Type.Optional(Type.Number()), maximum: Type.Optional(Type.Number()), defaultValue: Type.Optional(Type.Number()) }),
  Strict({ ...FormFieldBase, type: Type.Literal('boolean'), defaultValue: Type.Optional(Type.Boolean()) }),
  Strict({ ...FormFieldBase, type: Type.Literal('select'), options: Type.Array(AgentFormOption, { minItems: 1 }), defaultValue: Type.Optional(Type.String()) }),
  Strict({ ...FormFieldBase, type: Type.Literal('multiselect'), options: Type.Array(AgentFormOption, { minItems: 1 }), minItems: Type.Optional(NonNegativeInteger), maxItems: Type.Optional(NonNegativeInteger), defaultValue: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })) }),
]);
export type AgentFormField = Static<typeof AgentFormField>;
export const AgentFormValue = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String(), { uniqueItems: true })]);
export type AgentFormValue = Static<typeof AgentFormValue>;
export const AgentFormValues = Type.Record(Type.String(), AgentFormValue);
export type AgentFormValues = Static<typeof AgentFormValues>;
export const AgentPermissionScope = Type.Union([Type.Literal('turn'), Type.Literal('session')]);
export type AgentPermissionScope = Static<typeof AgentPermissionScope>;
export const AgentPermission = Strict({
  resource: Type.Union([Type.Literal('filesystem'), Type.Literal('network')]),
  access: Type.Union([Type.Literal('read'), Type.Literal('write'), Type.Literal('deny'), Type.Literal('connect')]),
  target: NonEmptyString,
});
export type AgentPermission = Static<typeof AgentPermission>;

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
    policies: Type.Optional(Type.Array(Strict({ policyId: NonEmptyString, description: Type.String() }))),
    context: Type.Optional(Type.Array(Strict({ label: NonEmptyString, value: Type.String() }))),
  }),
  Strict({ kind: Type.Literal('form'), requestId: NonEmptyString, title: NonEmptyString, message: Type.String(), fields: Type.Array(AgentFormField) }),
  Strict({ kind: Type.Literal('permission_approval'), requestId: NonEmptyString, summary: Type.String(), permissions: Type.Array(AgentPermission, { minItems: 1 }), allowScopes: Type.Array(AgentPermissionScope, { minItems: 1, uniqueItems: true }) }),
  Strict({ kind: Type.Literal('external_action'), requestId: NonEmptyString, title: NonEmptyString, message: Type.String(), url: Type.String({ pattern: '^[Hh][Tt][Tt][Pp][Ss]?://[^\\s/?#]+[^\\s]*$' }) }),
]);
export type AgentInteractionRequest = Static<typeof AgentInteractionRequest>;

export const AgentQuestionAnswer = Strict({
  questionId: NonEmptyString,
  selectedValues: Type.Array(NonEmptyString, { uniqueItems: true }),
  customText: Type.Optional(Type.String()),
  redacted: Type.Optional(Type.Boolean()),
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
    scope: Type.Union([Type.Literal('once'), Type.Literal('session')]),
  }),
  Strict({ kind: Type.Literal('tool_approval'), decision: Type.Literal('allow'), scope: Type.Literal('policy'), policyId: NonEmptyString }),
  Strict({
    kind: Type.Literal('tool_approval'),
    decision: Type.Union([Type.Literal('deny'), Type.Literal('cancel')]),
    message: Type.Optional(Type.String()),
  }),
  Strict({ kind: Type.Literal('form'), action: Type.Literal('submit'), values: AgentFormValues, redactedFields: Type.Optional(Type.Array(NonEmptyString, { uniqueItems: true })) }),
  Strict({ kind: Type.Literal('form'), action: Type.Union([Type.Literal('decline'), Type.Literal('cancel')]) }),
  Strict({ kind: Type.Literal('permission_approval'), decision: Type.Literal('allow'), scope: AgentPermissionScope }),
  Strict({ kind: Type.Literal('permission_approval'), decision: Type.Literal('deny') }),
  Strict({ kind: Type.Literal('external_action'), action: Type.Union([Type.Literal('completed'), Type.Literal('decline'), Type.Literal('cancel')]) }),
]);
export type AgentInteractionResponse = Static<typeof AgentInteractionResponse>;

export const InteractionResponseMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('interaction_response'), controlToken: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  payload: Strict({
    agentId: NonEmptyString,
    requestId: NonEmptyString,
    submissionId: NonEmptyString,
    operationId: OperationId,
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

export const InteractionInvalidatedMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('interaction_invalidated'),
  payload: Strict({
    agentId: NonEmptyString,
    requestId: NonEmptyString,
    reason: NonEmptyString,
    turnId: Type.Optional(NonEmptyString),
  }),
});
export type InteractionInvalidatedMessage = Static<typeof InteractionInvalidatedMessage>;
