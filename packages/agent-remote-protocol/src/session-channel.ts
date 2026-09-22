import { SessionMigration } from './session-migration.js';
import { type Static, Type } from '@sinclair/typebox';
import { ClientMessage, IncompatibleProtocolVersionErrorMessage, NegotiateRequest, ServerMessage } from './messages.js';
import { ProtocolVersionSchema } from './version.js';

const SubscriptionId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });

export const SessionChannelClientMessage = Type.Union([
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('subscribe'), subscriptionId: SubscriptionId, agentId: Type.String({ minLength: 1 }), message: NegotiateRequest }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('message'), subscriptionId: SubscriptionId, message: ClientMessage }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('unsubscribe'), subscriptionId: SubscriptionId }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('ping') }),
]);
export type SessionChannelClientMessage = Static<typeof SessionChannelClientMessage>;

export const SessionChannelServerMessage = Type.Union([
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_migrated'), migration: SessionMigration }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('ready') }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('message'), subscriptionId: SubscriptionId, message: Type.Union([ServerMessage, IncompatibleProtocolVersionErrorMessage]) }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('closed'), subscriptionId: SubscriptionId, code: Type.Integer(), reason: Type.String() }),
  Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('pong') }),
]);
export type SessionChannelServerMessage = Static<typeof SessionChannelServerMessage>;
