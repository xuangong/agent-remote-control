import { type Static, Type } from '@sinclair/typebox';

import { AgentInteractionRequest } from './interactions.js';
import { AgentUsage } from './timeline.js';
import { ProtocolVersionSchema } from './version.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

export const AgentStatus = Type.Union([
  Type.Literal('starting'), Type.Literal('idle'), Type.Literal('running'), Type.Literal('waiting'),
  Type.Literal('failed'), Type.Literal('closed'),
]);
export type AgentStatus = Static<typeof AgentStatus>;

export const AgentCapabilities = Strict({
  history: Type.Boolean(),
  sendMessage: Type.Boolean(),
  steer: Type.Boolean(),
  cancel: Type.Boolean(),
  readResource: Type.Boolean(),
  planning: Type.Optional(Type.Boolean()),
  interactions: Strict({
    question: Type.Boolean(),
    planApproval: Type.Boolean(),
    toolApproval: Type.Boolean(),
    form: Type.Optional(Type.Boolean()),
    permissionApproval: Type.Optional(Type.Boolean()),
    externalAction: Type.Optional(Type.Boolean()),
  }),
});
export type AgentCapabilities = Static<typeof AgentCapabilities>;

export const AgentPersistenceHandle = Strict({
  providerId: NonEmptyString,
  sessionId: NonEmptyString,
  opaque: NonEmptyString,
});
export type AgentPersistenceHandle = Static<typeof AgentPersistenceHandle>;

export const AgentPlanningState = Strict({
  active: Type.Boolean(),
  requested: Type.Optional(Type.Boolean()),
});
export type AgentPlanningState = Static<typeof AgentPlanningState>;

export const AgentRuntimeInfo = Strict({
  providerId: NonEmptyString,
  sessionId: Type.Union([NonEmptyString, Type.Null()]),
  status: AgentStatus,
  cwd: Type.Optional(NonEmptyString),
  model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  mode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  planning: Type.Optional(AgentPlanningState),
  persistence: Type.Optional(AgentPersistenceHandle),
});
export type AgentRuntimeInfo = Static<typeof AgentRuntimeInfo>;

export const AgentSnapshotPayload = Strict({
  id: NonEmptyString,
  providerId: NonEmptyString,
  cwd: Type.Optional(NonEmptyString),
  model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
  status: AgentStatus,
  activeTurn: Type.Union([
    Strict({ turnId: NonEmptyString, startedAt: Type.Optional(Type.Union([NonEmptyString, Type.Null()])) }),
    Type.Null(),
  ]),
  capabilities: AgentCapabilities,
  pendingInteractions: Type.Array(AgentInteractionRequest),
  runtimeInfo: AgentRuntimeInfo,
  persistence: Type.Optional(AgentPersistenceHandle),
  lastUsage: Type.Optional(AgentUsage),
  lastError: Type.Optional(Type.String()),
});
export type AgentSnapshotPayload = Static<typeof AgentSnapshotPayload>;

export const AgentSnapshot = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('agent_snapshot'),
  payload: AgentSnapshotPayload,
});
export type AgentSnapshot = Static<typeof AgentSnapshot>;
