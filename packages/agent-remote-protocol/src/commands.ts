import { type Static, Type } from '@sinclair/typebox';
import { ProtocolVersionSchema } from './version.js';
import { ResourceBinding } from './resources.js';
import { OperationId } from './operations.js';

const NonEmptyString = Type.String({ minLength: 1 });
const Strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const AgentCommand = Strict({
  id: NonEmptyString,
  name: Type.String({ minLength: 1, pattern: '^[^\\s/]+$' }),
  description: Type.String(),
  kind: Type.Union([Type.Literal('command'), Type.Literal('skill'), Type.Literal('prompt')]),
  inputHint: Type.Optional(Type.String()),
  shortDescription: Type.Optional(Type.String()),
  documentation: Type.Optional(ResourceBinding),
});
export type AgentCommand = Static<typeof AgentCommand>;
export const AgentCommandResult = Strict({ text: Type.Optional(Type.String()) });
export type AgentCommandResult = Static<typeof AgentCommandResult>;
const Identity = { requestId: NonEmptyString, agentId: NonEmptyString };
export const ListCommandsRequest = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('list_commands'), payload: Strict(Identity) });
export const CommandListResponse = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('command_list'), payload: Strict({ ...Identity, commands: Type.Array(AgentCommand) }) });
export type CommandListResponse = Static<typeof CommandListResponse>;
export const ExecuteCommandRequest = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('execute_command'), payload: Strict({ ...Identity, operationId: OperationId, commandId: NonEmptyString, args: Type.String() }) });
export const CommandResultResponse = Strict({ protocolVersion: ProtocolVersionSchema, type: Type.Literal('command_result'), payload: Strict({ ...Identity, result: AgentCommandResult }) });
export type CommandResultResponse = Static<typeof CommandResultResponse>;
