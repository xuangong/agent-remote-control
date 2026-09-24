import { type Static, Type } from '@sinclair/typebox';
import { ProtocolVersionSchema } from './version.js';
import type { ClientMessage } from './messages.js';

const Id = Type.String({ minLength: 1, maxLength: 256 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const SessionControlClientKind = Type.Union([Type.Literal('web'), Type.Literal('headless'), Type.Literal('unknown')]);
export type SessionControlClientKind = Static<typeof SessionControlClientKind>;

export const NativeSessionOwner = Strict({ kind: Type.Union([Type.Literal('native_cli'), Type.Literal('controller')]), generation: Id });
export type NativeSessionOwner = Static<typeof NativeSessionOwner>;

export const SessionControlState = Strict({
  agentId: Id, revision: Id,
  access: Type.Union([Type.Literal('control'), Type.Literal('read_only')]),
  available: Type.Boolean(),
  ownerKind: Type.Optional(SessionControlClientKind),
  nativeOwner: Type.Optional(NativeSessionOwner),
  token: Type.Optional(Id),
});
export type SessionControlState = Static<typeof SessionControlState>;

export const SessionControlMessage = Strict({
  protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_control'),
  payload: Strict({ ...SessionControlState.properties, requestId: Type.Optional(Id) }),
});
export type SessionControlMessage = Static<typeof SessionControlMessage>;

export const SessionControlRequest = Strict({
  protocolVersion: ProtocolVersionSchema, type: Type.Literal('session_control_request'),
  payload: Strict({ agentId: Id, requestId: Id, revision: Id,
    action: Type.Union([Type.Literal('acquire'), Type.Literal('take_over')]), resumeToken: Type.Optional(Id), retainOnDisconnect: Type.Optional(Type.Boolean()), clientKind: Type.Optional(SessionControlClientKind),
  }),
});
export type SessionControlRequest = Static<typeof SessionControlRequest>;

export type SessionMutation = Extract<ClientMessage, { type: 'send_message' | 'steer' | 'cancel' | 'set_planning' | 'set_session_setting' | 'execute_command' | 'interaction_response' | 'image_upload_begin' | 'image_upload_chunk' | 'image_upload_finish' }>;

export function isSessionMutation(message: { type: string }): message is SessionMutation {
  return ['send_message', 'steer', 'cancel', 'set_planning', 'set_session_setting', 'execute_command',
    'interaction_response', 'image_upload_begin', 'image_upload_chunk', 'image_upload_finish'].includes(message.type);
}
