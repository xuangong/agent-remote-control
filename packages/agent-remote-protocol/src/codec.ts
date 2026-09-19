import { SessionChannelClientMessage, SessionChannelServerMessage } from './session-channel.js';
import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { AgentStreamMessage, type AgentStreamMessage as AgentStreamMessageValue } from './envelope.js';
import { HistoryPage, type HistoryPage as HistoryPageValue } from './history.js';
import {
  AgentSessionResponse,
  ClientMessage,
  CommandAcknowledgementMessage,
  CreateAgentRequest,
  IncompatibleProtocolVersionErrorMessage,
  ProviderListResponse,
  ResumeAgentRequest,
  ServerMessage,
  type AgentSessionResponse as AgentSessionResponseValue,
  type ClientMessage as ClientMessageValue,
  type CommandAcknowledgementMessage as CommandAcknowledgementMessageValue,
  type CreateAgentRequest as CreateAgentRequestValue,
  type IncompatibleProtocolVersionErrorMessage as IncompatibleProtocolVersionErrorMessageValue,
  type ProviderListResponse as ProviderListResponseValue,
  type ResumeAgentRequest as ResumeAgentRequestValue,
  type ServerMessage as ServerMessageValue,
} from './messages.js';
import {
  ResourceResponse,
  ResourceUpdate,
  type ResourceResponse as ResourceResponseValue,
  type ResourceUpdate as ResourceUpdateValue,
} from './resources.js';
import { AgentSnapshot, type AgentSnapshot as AgentSnapshotValue } from './snapshot.js';
import { BORGEE_AGENT_REMOTE_PROTOCOL_VERSION } from './version.js';

export interface WireIssue {
  code: 'invalid_json' | 'invalid_shape' | 'incompatible_protocol_version' | 'not_json_serializable';
  path: string;
  message: string;
}

export type WireDecodeResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'rejected'; issues: WireIssue[] };

export type WireEncodeResult =
  | { status: 'ok'; json: string }
  | { status: 'rejected'; issues: WireIssue[] };

function shapeIssues(schema: TSchema, value: unknown): WireIssue[] {
  return [...Value.Errors(schema, value)].map((error) => ({
    code: 'invalid_shape',
    path: error.path,
    message: error.message,
  }));
}

function versionIssues(value: { protocolVersion: string }): WireIssue[] {
  if (value.protocolVersion === BORGEE_AGENT_REMOTE_PROTOCOL_VERSION) return [];
  return [{
    code: 'incompatible_protocol_version',
    path: '/protocolVersion',
    message: `Protocol version ${value.protocolVersion} is incompatible with ${BORGEE_AGENT_REMOTE_PROTOCOL_VERSION}.`,
  }];
}

function decode<T extends { protocolVersion: string }>(json: string, schema: TSchema): WireDecodeResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { status: 'rejected', issues: [{ code: 'invalid_json', path: '', message: 'Invalid JSON.' }] };
  }
  if (
    typeof value === 'object'
    && value !== null
    && 'protocolVersion' in value
    && typeof value.protocolVersion === 'string'
  ) {
    const issues = versionIssues(value as { protocolVersion: string });
    if (issues.length > 0) return { status: 'rejected', issues };
  }
  if (!Value.Check(schema, value)) return { status: 'rejected', issues: shapeIssues(schema, value) };
  const typed = value as T;
  const issues = versionIssues(typed);
  return issues.length > 0 ? { status: 'rejected', issues } : { status: 'ok', value: typed };
}

function decodeShape<T>(json: string, schema: TSchema): WireDecodeResult<T> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { status: 'rejected', issues: [{ code: 'invalid_json', path: '', message: 'Invalid JSON.' }] };
  }
  if (!Value.Check(schema, value)) return { status: 'rejected', issues: shapeIssues(schema, value) };
  return { status: 'ok', value: value as T };
}

function encode<T extends { protocolVersion: string }>(value: T, schema: TSchema): WireEncodeResult {
  const issues = versionIssues(value);
  if (issues.length > 0) return { status: 'rejected', issues };
  if (!Value.Check(schema, value)) return { status: 'rejected', issues: shapeIssues(schema, value) };
  try {
    return { status: 'ok', json: JSON.stringify(value) };
  } catch {
    return {
      status: 'rejected',
      issues: [{ code: 'not_json_serializable', path: '', message: 'Value cannot be serialized as JSON.' }],
    };
  }
}

export function decodeAgentSnapshot(json: string): WireDecodeResult<AgentSnapshotValue> {
  return decode(json, AgentSnapshot);
}

export function encodeAgentSnapshot(value: AgentSnapshotValue): WireEncodeResult {
  return encode(value, AgentSnapshot);
}

export function decodeHistoryPage(json: string): WireDecodeResult<HistoryPageValue> {
  return decode(json, HistoryPage);
}

export function encodeHistoryPage(value: HistoryPageValue): WireEncodeResult {
  return encode(value, HistoryPage);
}

export function decodeAgentStreamMessage(json: string): WireDecodeResult<AgentStreamMessageValue> {
  return decode(json, AgentStreamMessage);
}

export function encodeAgentStreamMessage(value: AgentStreamMessageValue): WireEncodeResult {
  return encode(value, AgentStreamMessage);
}

export function decodeResourceResponse(json: string): WireDecodeResult<ResourceResponseValue> {
  return decode(json, ResourceResponse);
}

export function encodeResourceResponse(value: ResourceResponseValue): WireEncodeResult {
  return encode(value, ResourceResponse);
}

export function decodeResourceUpdate(json: string): WireDecodeResult<ResourceUpdateValue> {
  return decode(json, ResourceUpdate);
}

export function encodeResourceUpdate(value: ResourceUpdateValue): WireEncodeResult {
  return encode(value, ResourceUpdate);
}

export function decodeCreateAgentRequest(json: string): WireDecodeResult<CreateAgentRequestValue> {
  return decode(json, CreateAgentRequest);
}

export function encodeCreateAgentRequest(value: CreateAgentRequestValue): WireEncodeResult {
  return encode(value, CreateAgentRequest);
}

export function decodeResumeAgentRequest(json: string): WireDecodeResult<ResumeAgentRequestValue> {
  return decode(json, ResumeAgentRequest);
}

export function encodeResumeAgentRequest(value: ResumeAgentRequestValue): WireEncodeResult {
  return encode(value, ResumeAgentRequest);
}

export function decodeAgentSessionResponse(json: string): WireDecodeResult<AgentSessionResponseValue> {
  return decode(json, AgentSessionResponse);
}

export function encodeAgentSessionResponse(value: AgentSessionResponseValue): WireEncodeResult {
  return encode(value, AgentSessionResponse);
}

export function decodeProviderListResponse(json: string): WireDecodeResult<ProviderListResponseValue> {
  return decode(json, ProviderListResponse);
}

export function encodeProviderListResponse(value: ProviderListResponseValue): WireEncodeResult {
  return encode(value, ProviderListResponse);
}

export function decodeCommandAcknowledgementMessage(
  json: string,
): WireDecodeResult<CommandAcknowledgementMessageValue> {
  return decode(json, CommandAcknowledgementMessage);
}

export function encodeCommandAcknowledgementMessage(
  value: CommandAcknowledgementMessageValue,
): WireEncodeResult {
  return encode(value, CommandAcknowledgementMessage);
}

export function decodeClientMessage(json: string): WireDecodeResult<ClientMessageValue> {
  return decode(json, ClientMessage);
}

export function encodeClientMessage(value: ClientMessageValue): WireEncodeResult {
  return encode(value, ClientMessage);
}

export function decodeServerMessage(json: string): WireDecodeResult<ServerMessageValue> {
  return decode(json, ServerMessage);
}

export function decodeIncompatibleProtocolVersionError(
  json: string,
): WireDecodeResult<IncompatibleProtocolVersionErrorMessageValue> {
  return decodeShape(json, IncompatibleProtocolVersionErrorMessage);
}

export function encodeServerMessage(value: ServerMessageValue): WireEncodeResult {
  return encode(value, ServerMessage);
}

export function decodeSessionChannelClientMessage(json: string): WireDecodeResult<SessionChannelClientMessage> {
  return decode(json, SessionChannelClientMessage);
}

export function encodeSessionChannelClientMessage(value: SessionChannelClientMessage): WireEncodeResult {
  return encode(value, SessionChannelClientMessage);
}

export function decodeSessionChannelServerMessage(json: string): WireDecodeResult<SessionChannelServerMessage> {
  return decode(json, SessionChannelServerMessage);
}

export function encodeSessionChannelServerMessage(value: SessionChannelServerMessage): WireEncodeResult {
  return encode(value, SessionChannelServerMessage);
}
