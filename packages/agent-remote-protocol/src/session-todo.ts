import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ minLength: 1, maxLength: 2048 });
const revision = Type.Integer({ minimum: 1 });
export const SessionTodoDefinition = Type.Object({
  id, title: Type.String({ minLength: 1, maxLength: 256 }), acceptance: text,
  kind: Type.Union([Type.Literal('task'), Type.Literal('confirmation')]),
}, object);
export type SessionTodoDefinition = Static<typeof SessionTodoDefinition>;
export const SessionTodoStep = Type.Object({
  ...SessionTodoDefinition.properties,
  status: Type.Union((['pending', 'in_progress', 'waiting', 'completed'] as const).map(value => Type.Literal(value))),
  note: Type.Optional(text), evidence: Type.Optional(Type.Array(text, { minItems: 1, maxItems: 20 })),
  confirmation: Type.Optional(Type.Object({ id, content: Type.String({ minLength: 1, maxLength: 16000 }), decision: Type.Optional(Type.Union([Type.Literal('approve'), Type.Literal('revise')])) }, object)),
}, object);
export type SessionTodoStep = Static<typeof SessionTodoStep>;
export const SessionTodoList = Type.Object({
  revision, planRevision: revision, approvedPlanRevision: Type.Optional(revision),
  steps: Type.Array(SessionTodoStep, { minItems: 1, maxItems: 100 }),
  changes: Type.Array(Type.Object({ revision, reason: text, previous: Type.Array(SessionTodoDefinition, { maxItems: 100 }) }, object), { maxItems: 20 }),
}, object);
export type SessionTodoList = Static<typeof SessionTodoList>;
export const SessionTodoChange = Type.Union([
  Type.Object({ revision, action: Type.Literal('revise_remaining'), reason: text, steps: Type.Array(SessionTodoDefinition, { minItems: 1, maxItems: 100 }) }, object),
  Type.Object({ revision, stepId: id, action: Type.Literal('progress'), status: Type.Union([Type.Literal('in_progress'), Type.Literal('waiting')]), note: text }, object),
  Type.Object({ revision, stepId: id, action: Type.Literal('complete'), evidence: Type.Array(text, { minItems: 1, maxItems: 20 }) }, object),
  Type.Object({ revision, stepId: id, action: Type.Literal('request_confirmation'), content: Type.String({ minLength: 1, maxLength: 16000 }) }, object),
]);
export type SessionTodoChange = Static<typeof SessionTodoChange>;
export const SessionTodoDecision = Type.Object({ revision, stepId: id, requestId: id, decision: Type.Union([Type.Literal('approve'), Type.Literal('revise')]) }, object);
export type SessionTodoDecision = Static<typeof SessionTodoDecision>;
export const isSessionTodoList = (value: unknown): value is SessionTodoList => Value.Check(SessionTodoList, value);
export const isSessionTodoChange = (value: unknown): value is SessionTodoChange => Value.Check(SessionTodoChange, value);
export const isSessionTodoDecision = (value: unknown): value is SessionTodoDecision => Value.Check(SessionTodoDecision, value);
