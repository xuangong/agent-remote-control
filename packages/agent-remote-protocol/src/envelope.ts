import { type Static, Type } from '@sinclair/typebox';

import { SafeNonNegativeInteger } from './cursor.js';
import { ResourceBinding } from './resources.js';
import { AgentRuntimeInfo } from './snapshot.js';
import { AgentTimelineItem, AgentUsage } from './timeline.js';
import { ProtocolVersionSchema } from './version.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

const ProviderEvent = { providerId: NonEmptyString };
const TurnId = { turnId: Type.Optional(NonEmptyString) };

export const PublicAgentTimelineEvent = Strict({
  type: Type.Literal('timeline'),
  ...ProviderEvent,
  item: AgentTimelineItem,
  ...TurnId,
  resources: Type.Array(ResourceBinding),
});
export type PublicAgentTimelineEvent = Static<typeof PublicAgentTimelineEvent>;

export const PublicAgentNonTimelineEvent = Type.Union([
  Strict({ type: Type.Literal('thread_started'), ...ProviderEvent, sessionId: NonEmptyString }),
  Strict({ type: Type.Literal('turn_started'), ...ProviderEvent, ...TurnId }),
  Strict({ type: Type.Literal('turn_completed'), ...ProviderEvent, ...TurnId, usage: Type.Optional(AgentUsage) }),
  Strict({
    type: Type.Literal('turn_failed'), ...ProviderEvent, ...TurnId, error: Type.String(),
    code: Type.Optional(NonEmptyString), diagnostic: Type.Optional(Type.String()),
  }),
  Strict({ type: Type.Literal('turn_canceled'), ...ProviderEvent, ...TurnId, reason: Type.String() }),
  Strict({ type: Type.Literal('usage_updated'), ...ProviderEvent, ...TurnId, usage: AgentUsage }),
  Strict({ type: Type.Literal('runtime_updated'), ...ProviderEvent, runtimeInfo: AgentRuntimeInfo,
    activeTurnId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])) }),
]);
export type PublicAgentNonTimelineEvent = Static<typeof PublicAgentNonTimelineEvent>;

export const AgentStreamMessage = Type.Union([
  Strict({
    protocolVersion: ProtocolVersionSchema,
    type: Type.Literal('agent_stream'),
    payload: Strict({
      agentId: NonEmptyString,
      event: PublicAgentTimelineEvent,
      timestamp: NonEmptyString,
      seq: SafeNonNegativeInteger,
      epoch: NonEmptyString,
    }),
  }),
  Strict({
    protocolVersion: ProtocolVersionSchema,
    type: Type.Literal('agent_stream'),
    payload: Strict({
      agentId: NonEmptyString,
      event: PublicAgentNonTimelineEvent,
      timestamp: NonEmptyString,
    }),
  }),
]);
export type AgentStreamMessage = Static<typeof AgentStreamMessage>;
