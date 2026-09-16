import { type Static, Type } from '@sinclair/typebox';

import { AgentStreamMessage } from './envelope.js';
import { HistoryPage, TimelineRequest } from './history.js';
import {
  InteractionRequestedMessage,
  InteractionResolvedMessage,
  InteractionResponseMessage,
} from './interactions.js';
import {
  ResourceRequest,
  ResourceResolveRequest,
  ResourceResolveResponse,
  ResourceResponse,
  ResourceUpdate,
  TimelineResourceBindingReplacement,
} from './resources.js';
import { AgentPersistenceHandle, AgentSnapshot } from './snapshot.js';
import { ProtocolVersionSchema } from './version.js';
import { ListCommandsRequest, ExecuteCommandRequest, CommandListResponse, CommandResultResponse } from './commands.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(
  properties,
  { additionalProperties: false },
);

export const NegotiateRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('negotiate'),
});
export type NegotiateRequest = Static<typeof NegotiateRequest>;

export const NegotiateResponse = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('negotiated'),
});
export type NegotiateResponse = Static<typeof NegotiateResponse>;

export const AgentProviderDescriptor = Strict({
  providerId: NonEmptyString,
  displayName: NonEmptyString,
});
export type AgentProviderDescriptor = Static<typeof AgentProviderDescriptor>;

export const ProviderListResponse = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('provider_list'),
  payload: Strict({ providers: Type.Array(AgentProviderDescriptor) }),
});
export type ProviderListResponse = Static<typeof ProviderListResponse>;

export const SendMessageRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('send_message'),
  payload: Strict({ requestId: NonEmptyString, agentId: NonEmptyString, text: Type.String(), delivery: Type.Optional(Type.Union([Type.Literal('immediate'), Type.Literal('next_turn')])) }),
});
export type SendMessageRequest = Static<typeof SendMessageRequest>;
export type AgentMessageOptions = Pick<SendMessageRequest['payload'], 'delivery'>;

export const SteerRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('steer'),
  payload: Strict({ requestId: NonEmptyString, agentId: NonEmptyString, text: Type.String() }),
});
export type SteerRequest = Static<typeof SteerRequest>;

export const CancelRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('cancel'),
  payload: Strict({ requestId: NonEmptyString, agentId: NonEmptyString }),
});
export type CancelRequest = Static<typeof CancelRequest>;

export const SetPlanningRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('set_planning'),
  payload: Strict({ requestId: NonEmptyString, agentId: NonEmptyString, active: Type.Boolean() }),
});
export type SetPlanningRequest = Static<typeof SetPlanningRequest>;

export const SetSessionSettingRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('set_session_setting'),
  payload: Strict({ requestId: NonEmptyString, agentId: NonEmptyString, settingId: NonEmptyString, value: NonEmptyString }),
});
export type SetSessionSettingRequest = Static<typeof SetSessionSettingRequest>;

export const AgentSessionConfig = Strict({
  sessionId: NonEmptyString,
  cwd: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
  reasoningEffort: Type.Optional(NonEmptyString),
  systemPrompt: Type.Optional(Type.String()),
  planning: Type.Optional(Type.Boolean()),
});
export type AgentSessionConfig = Static<typeof AgentSessionConfig>;

export const CreateAgentRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('create_agent'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    providerId: NonEmptyString,
    config: AgentSessionConfig,
  }),
});
export type CreateAgentRequest = Static<typeof CreateAgentRequest>;

export const ResumeAgentRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('resume_agent'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    persistence: AgentPersistenceHandle,
  }),
});
export type ResumeAgentRequest = Static<typeof ResumeAgentRequest>;

export const AgentSessionResponse = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('agent_session'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    providerId: NonEmptyString,
    sessionId: NonEmptyString,
    persistence: Type.Optional(AgentPersistenceHandle),
  }),
});
export type AgentSessionResponse = Static<typeof AgentSessionResponse>;

export const CommandAcknowledgementMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('command_acknowledged'),
  payload: Strict({
    requestId: NonEmptyString,
    agentId: NonEmptyString,
    command: Type.Union([
      Type.Literal('send_message'), Type.Literal('steer'), Type.Literal('cancel'), Type.Literal('set_planning'), Type.Literal('set_session_setting'),
    ]),
  }),
});
export type CommandAcknowledgementMessage = Static<typeof CommandAcknowledgementMessage>;

export const TimelineSubscriptionRequest = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('timeline_subscription'),
  payload: Strict({ requestId: NonEmptyString, agentIds: Type.Array(NonEmptyString, { uniqueItems: true }) }),
});
export type TimelineSubscriptionRequest = Static<typeof TimelineSubscriptionRequest>;

export const TimelineSubscriptionResponse = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('timeline_subscribed'),
  payload: Strict({ requestId: NonEmptyString, agentIds: Type.Array(NonEmptyString, { uniqueItems: true }) }),
});
export type TimelineSubscriptionResponse = Static<typeof TimelineSubscriptionResponse>;

export const TimelineReplacementMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('timeline_replacement'),
  payload: Strict({ agentId: NonEmptyString, epoch: NonEmptyString }),
});
export type TimelineReplacementMessage = Static<typeof TimelineReplacementMessage>;

export const AgentUpdateMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('agent_update'),
  payload: AgentSnapshot.properties.payload,
});
export type AgentUpdateMessage = Static<typeof AgentUpdateMessage>;

export const ProtocolErrorMessage = Strict({
  protocolVersion: ProtocolVersionSchema,
  type: Type.Literal('protocol_error'),
  payload: Strict({
    requestId: Type.Optional(NonEmptyString),
    code: NonEmptyString,
    message: Type.String(),
    recoverable: Type.Boolean(),
  }),
});
export type ProtocolErrorMessage = Static<typeof ProtocolErrorMessage>;

export const IncompatibleProtocolVersionErrorMessage = Strict({
  protocolVersion: NonEmptyString,
  type: Type.Literal('protocol_error'),
  payload: Strict({
    requestId: Type.Optional(NonEmptyString),
    code: Type.Literal('incompatible_protocol_version'),
    message: Type.String(),
    recoverable: Type.Literal(false),
  }),
});
export type IncompatibleProtocolVersionErrorMessage = Static<typeof IncompatibleProtocolVersionErrorMessage>;

export const ClientMessage = Type.Union([
  ListCommandsRequest,
  ExecuteCommandRequest,
  NegotiateRequest,
  CreateAgentRequest,
  ResumeAgentRequest,
  SendMessageRequest,
  SteerRequest,
  CancelRequest,
  SetPlanningRequest,
  SetSessionSettingRequest,
  TimelineSubscriptionRequest,
  TimelineRequest,
  InteractionResponseMessage,
  ResourceRequest,
  ResourceResolveRequest,
]);
export type ClientMessage = Static<typeof ClientMessage>;

export const ServerMessage = Type.Union([
  CommandListResponse,
  CommandResultResponse,
  NegotiateResponse,
  ProviderListResponse,
  AgentSessionResponse,
  CommandAcknowledgementMessage,
  AgentSnapshot,
  AgentUpdateMessage,
  TimelineSubscriptionResponse,
  HistoryPage,
  TimelineReplacementMessage,
  AgentStreamMessage,
  InteractionRequestedMessage,
  InteractionResolvedMessage,
  ResourceResponse,
  ResourceResolveResponse,
  ResourceUpdate,
  TimelineResourceBindingReplacement,
  ProtocolErrorMessage,
]);
export type ServerMessage = Static<typeof ServerMessage>;
