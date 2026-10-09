import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SessionTodoList, SessionTodoDecision } from './session-todo.js';

const object = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, maxLength: 128 });
const text = Type.String({ maxLength: 65536 });
const short = Type.String({ maxLength: 2048 });
const revision = Type.Integer({ minimum: 1 });
const utf8 = new (globalThis as unknown as { TextEncoder: new () => { encode(value: string): Uint8Array } }).TextEncoder();
export const TpmIntent = Type.Object({
  id, target: Type.Union([Type.Literal('main'), Type.Literal('tpm')]),
  status: Type.Union((['prepared', 'dispatching', 'accepted', 'rejected', 'unknown'] as const).map(value => Type.Literal(value))),
  acceptance: Type.Optional(Type.Union([Type.Literal('started'), Type.Literal('queued'), Type.Literal('handled')])),
  purpose: short, text, createdAt: id, error: Type.Optional(short),
  todoStepId: Type.Optional(id), todoPlanRevision: Type.Optional(revision),
}, object);
export type TpmIntent = Static<typeof TpmIntent>;
export const TpmWork = Type.Object({
  todo: Type.Optional(SessionTodoList), todoRevision: Type.Optional(revision),
  detailsOmitted: Type.Optional(Type.Literal(true)), documentRevision: Type.Optional(revision),
  creationStatus: Type.Optional(Type.Union((['prepared', 'dispatching', 'accepted', 'unknown', 'abandoned'] as const).map(value => Type.Literal(value)))),
  id, revision, title: Type.String({ minLength: 1, maxLength: 256 }), providerId: id,
  mainNativeSessionId: id, tpmNativeSessionId: Type.Optional(id),
  phase: Type.Union((['clarifying', 'ready', 'implementing', 'validating', 'completed'] as const).map(value => Type.Literal(value))),
  waiting: Type.Union((['none', 'user', 'main_session'] as const).map(value => Type.Literal(value))),
  paused: Type.Boolean(), summary: short, nextAction: short, document: text, acceptance: text,
  evidence: Type.Array(short, { maxItems: 100 }), createdAt: id, updatedAt: id,
  nextCheckAt: Type.Number({ minimum: 0 }), health: Type.Optional(short),
  outbox: Type.Optional(Type.Array(TpmIntent, { maxItems: 200 })),
}, object);
export type TpmWork = Static<typeof TpmWork>;
export const TpmList = Type.Object({ supported: Type.Boolean(), works: Type.Array(TpmWork), supportedProviders: Type.Optional(Type.Array(id)), nextCursor: Type.Optional(id) }, object);
export type TpmList = Static<typeof TpmList>;
export const TpmCreate = Type.Object({ providerId: id, mainNativeSessionId: id, title: Type.String({ minLength: 1, maxLength: 256 }), requirement: Type.String({ minLength: 1, maxLength: 16000 }), operationId: id }, object);
export type TpmCreate = Static<typeof TpmCreate>;
export const TpmAction = Type.Union([
  Type.Object({ id, revision, operationId: id, action: Type.Literal('confirm_todo'), confirmation: SessionTodoDecision }, object),
  Type.Object({ id, revision, operationId: id, action: Type.Union((['pause', 'resume', 'reopen', 'check'] as const).map(value => Type.Literal(value))) }, object),
  Type.Object({ id, revision, operationId: id, action: Type.Literal('resolve'), intentId: id, resolution: Type.Union([Type.Literal('accepted'), Type.Literal('rejected')]), nativeSessionId: Type.Optional(id) }, object),
]);
export type TpmAction = Static<typeof TpmAction>;
export const isTpmWork = (value: unknown): value is TpmWork => Value.Check(TpmWork, value);
export const isTpmList = (value: unknown): value is TpmList => Value.Check(TpmList, value);
export const isTpmCreate = (value: unknown): value is TpmCreate => Value.Check(TpmCreate, value) && utf8.encode(JSON.stringify(value)).byteLength <= 60 * 1024;
export const isTpmAction = (value: unknown): value is TpmAction => Value.Check(TpmAction, value);
