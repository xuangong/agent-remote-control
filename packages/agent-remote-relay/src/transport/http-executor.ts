import {
  PROTOCOL_VERSION,
  decodeCreateAgentRequest,
  decodeResumeAgentRequest,
  encodeAgentSessionResponse,
  encodeAgentSnapshot,
  encodeHistoryPage,
  encodeProviderListResponse,
  encodeServerMessage,
  type ProtocolErrorMessage,
  type TimelineCursor,
  type TimelineDirection,
  type WireDecodeResult,
  type WireEncodeResult,
} from '@agent-remote-controller/agent-remote-protocol';

import { ProviderNotFoundError } from '../provider-registry.js';
import {
  AgentAlreadyExistsError,
  AgentNotFoundError,
  RelayClosedError,
  type AgentRemoteRelay,
} from '../relay.js';

export interface AgentRemoteHttpRequest {
  method: string;
  path: string;
  body?: string;
}

export interface AgentRemoteHttpResult {
  status: number;
  body: string;
}

class MalformedIngressError extends Error {
  constructor(
    readonly code: 'invalid_path' | 'request_body_too_large' | 'invalid_query' | 'incompatible_protocol_version',
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
  }
}

export async function executeAgentRemoteHttpRequest(
  relay: AgentRemoteRelay,
  request: AgentRemoteHttpRequest,
): Promise<AgentRemoteHttpResult> {
  try {
    if (!request.path.startsWith('/') || request.path.startsWith('//') || request.path.includes('\\') || request.path.includes('#')) {
      throw new MalformedIngressError('invalid_path', 'Relay request target must be a local path.');
    }
    if (Buffer.byteLength(request.body ?? '') > 1_048_576) {
      throw new MalformedIngressError('request_body_too_large', 'Relay request body exceeds one megabyte.');
    }
    return await route(relay, request);
  } catch (error) {
    return agentRemoteHttpFailure(error);
  }
}

export function agentRemoteHttpFailure(error: unknown): AgentRemoteHttpResult {
  if (error instanceof MalformedIngressError) return agentRemoteHttpError(400, error.code, error.message, error.recoverable);
  if (error instanceof AgentNotFoundError) return agentRemoteHttpError(404, 'agent_not_found', 'Agent was not found.', true);
  if (error instanceof ProviderNotFoundError) return agentRemoteHttpError(404, 'provider_not_found', 'Agent provider was not found.', true);
  if (error instanceof AgentAlreadyExistsError) return agentRemoteHttpError(409, 'agent_already_exists', 'Agent already exists.', true);
  if (error instanceof RelayClosedError) return agentRemoteHttpError(503, 'relay_closed', 'Agent Remote relay is closed.', false);
  return agentRemoteHttpError(500, 'request_failed', 'Relay request failed.', false);
}

async function route(relay: AgentRemoteRelay, request: AgentRemoteHttpRequest): Promise<AgentRemoteHttpResult> {
  const method = request.method;
  const url = new URL(request.path, 'http://relay.local');
  if (method === 'GET' && url.pathname === '/v1/providers') {
    requireExactVersion(url.searchParams.get('protocolVersion'));
    return encodedResult(200, encodeProviderListResponse({
      protocolVersion: PROTOCOL_VERSION,
      type: 'provider_list',
      payload: { providers: [...relay.listProviders()] },
    }));
  }

  if (method === 'POST' && url.pathname === '/v1/sessions') {
    const decoded = decodeCreateAgentRequest(request.body ?? '');
    if (decoded.status === 'rejected') {
      return decodeError('invalid_create_agent', decoded);
    }
    return encodedResult(201, encodeAgentSessionResponse(await relay.createAgent(decoded.value)));
  }

  if (method === 'POST' && url.pathname === '/v1/sessions/resume') {
    const decoded = decodeResumeAgentRequest(request.body ?? '');
    if (decoded.status === 'rejected') {
      return decodeError('invalid_resume_agent', decoded);
    }
    return encodedResult(200, encodeAgentSessionResponse(await relay.resumeAgent(decoded.value)));
  }

  const match = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(url.pathname);
  if (!match) {
    return agentRemoteHttpError(404, 'route_not_found', 'Relay route was not found.', true);
  }

  const agentId = decodePathSegment(match[1] as string);
  requireExactVersion(url.searchParams.get('protocolVersion'));
  const action = match[2];

  if (method === 'GET' && action === 'snapshot') {
    return encodedResult(200, encodeAgentSnapshot(relay.requireAgent(agentId).snapshot()));
  }

  if (method === 'GET' && action === 'timeline') {
    const manager = relay.requireAgent(agentId);
    return encodedResult(200, encodeHistoryPage(manager.fetchTimeline(parseTimelineQuery(url, agentId))));
  }

  return agentRemoteHttpError(405, 'method_not_allowed', 'Method is not allowed for this route.', true);
}

function parseTimelineQuery(url: URL, agentId: string): {
  requestId: string;
  agentId: string;
  direction: TimelineDirection;
  cursor?: TimelineCursor;
  limit: number;
} {
  const requestId = url.searchParams.get('requestId');
  const direction = url.searchParams.get('direction');
  const limitValue = url.searchParams.get('limit');
  const epoch = url.searchParams.get('epoch');
  const seqValue = url.searchParams.get('seq');
  if (!requestId || !isDirection(direction)) {
    throw new MalformedIngressError('invalid_query', 'Timeline requestId and direction are required.');
  }
  const limit = limitValue === null ? 100 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new MalformedIngressError('invalid_query', 'Timeline limit must be a positive integer.');
  }
  if ((epoch === null) !== (seqValue === null)) {
    throw new MalformedIngressError('invalid_query', 'Timeline cursor epoch and seq must be supplied together.');
  }
  const cursor = epoch === null ? undefined : { epoch, seq: Number(seqValue) };
  if (cursor && (!epoch || !Number.isSafeInteger(cursor.seq) || cursor.seq < 0)) {
    throw new MalformedIngressError('invalid_query', 'Timeline cursor is invalid.');
  }
  if (direction !== 'tail' && cursor === undefined) {
    throw new MalformedIngressError('invalid_query', `${direction} Timeline requests require a cursor.`);
  }
  return { requestId, agentId, direction, ...(cursor === undefined ? {} : { cursor }), limit };
}

function decodePathSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded) throw new Error('empty path segment');
    return decoded;
  } catch {
    throw new MalformedIngressError('invalid_path', 'Relay Agent path is not percent-encoded correctly.');
  }
}

function requireExactVersion(value: string | null): void {
  if (value === PROTOCOL_VERSION) return;
  const received = value === null ? 'missing' : value;
  throw new MalformedIngressError(
    'incompatible_protocol_version',
    `Protocol version ${received} is incompatible with ${PROTOCOL_VERSION}.`,
    false,
  );
}

function isDirection(value: string | null): value is TimelineDirection {
  return value === 'tail' || value === 'before' || value === 'after';
}

function decodeError<T>(
  fallbackCode: string,
  decoded: Extract<WireDecodeResult<T>, { status: 'rejected' }>,
): AgentRemoteHttpResult {
  const issue = decoded.issues[0];
  const code = issue?.code === 'incompatible_protocol_version' ? issue.code : fallbackCode;
  return agentRemoteHttpError(
    400,
    code,
    issue?.message ?? 'Client message was rejected.',
    code !== 'incompatible_protocol_version',
  );
}

export function agentRemoteHttpError(
  status: number,
  code: string,
  message: string,
  recoverable: boolean,
): AgentRemoteHttpResult {
  const error: ProtocolErrorMessage = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'protocol_error',
    payload: { code, message, recoverable },
  };
  return encodedResult(status, encodeServerMessage(error));
}

function encodedResult(status: number, encoded: WireEncodeResult): AgentRemoteHttpResult {
  if (encoded.status === 'rejected') {
    throw new Error(`Relay produced invalid JSON: ${encoded.issues.map(({ message }) => message).join(' ')}`);
  }
  return { status, body: encoded.json };
}
