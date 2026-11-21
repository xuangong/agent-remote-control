import { isCreationSource, type CreationSource } from '@orchardworks/agent-remote-protocol';
import { OperationCacheError, SessionBindingError, RemoteHostCatalogError, type AgentRemoteHttpResult } from '@orchardworks/agent-session-runtime';
import { AgentOperationRejectedError, AgentRuntimeError, AgentSessionInUseError } from '@orchardworks/agent-provider-sdk';

import { HostExecutionPolicyError } from '../execution-policy.js';
import { NativeSessionOwnerError } from '../native-session-owner.js';
import { WorkspaceFolderError } from '../workspace-folders.js';
import type { SessionBinding } from './types.js';

/**
 * Requests: how the Host's control requests are read and how their failures are answered.
 *
 * Contract.
 * - Every refusal of a malformed request is a `HostRequestError` with status 400 and code `invalid_request` unless noted; nothing is read
 *   from a request before it is validated, and no parser touches a port.
 * - `parseCreateRequest` accepts a provider, an operation identity and the proposed session identity (a request's `sessionId`). It bounds a
 *   source identity to 256 characters, takes a prompt edit only as a complete native prompt identity (session, turn, message) that is not
 *   also a source, and rejects a creation source that contradicts the legacy source identity. The creation source is the explicit one, or the
 *   legacy source read as one of the same provider.
 * - `parseAttachRequest` needs the proposed identity, a provider and a native session; a child attach needs its parent; a takeover needs a native
 *   owner generation (a UUID) and is never a child attach.
 * - `failureResponse` answers an error: the typed errors keep their own status and code, a failed GET is `catalog_unavailable`, a failed attach is
 *   `session_attach_failed`, anything else is `mutation_outcome_unknown`. Generic answers carry the class and code of the error behind them, never its text.
 * - `operationErrorStatus` maps the operation cache's codes: conflict 409, capacity 429, unknown outcome, closed cache, native file limit and a
 *   bad clock 503, the rest 400.
 *
 * Pure: no ports, no clock, no state.
 */
export class HostRequestError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

export const json = (status: number, value: unknown): AgentRemoteHttpResult => ({ status, body: JSON.stringify(value) });

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new HostRequestError(400, 'invalid_request', `${field} is required.`);
  return value;
}

export function boundedSourceIdentity(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 512; }

export function parseBody(value: string | undefined): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value ?? ''); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>; } catch { /* Rejected below. */ }
  throw new HostRequestError(400, 'invalid_request', 'Remote Host body is invalid.');
}

export function publicBinding(binding: SessionBinding): Omit<SessionBinding, 'providerId'> {
  const { providerId: _providerId, ...value } = binding;
  return value;
}

export function operationErrorStatus(code: string): number {
  if (code === 'operation_conflict') return 409;
  if (code === 'operation_capacity_exceeded') return 429;
  if (code === 'native_file_limit' || code === 'operation_outcome_unknown' || code === 'operation_cache_closed' || code === 'operation_clock_invalid') return 503;
  return 400;
}

export type RequestOperation = 'session_attach' | 'session_create' | 'catalog_read' | 'host_control';

export function requestOperation(request: { path: string; method: string }): RequestOperation {
  return request.path === '/remote/attach' || request.path === '/remote/child/attach' ? 'session_attach'
    : request.path === '/remote/create' ? 'session_create' : request.method === 'GET' ? 'catalog_read' : 'host_control';
}

/** What a create request asks for, validated; the Host settles the rest from its own state. */
export interface CreateRequest {
  providerId: string;
  operationId: string;
  proposedAgentId: string;
  /** A prompt edit: the native prompt that is branched. */
  editing: boolean;
  provenance: CreationSource | undefined;
  settings: {
    editNativeSessionId?: string; editTurnId?: string; editMessageId?: string; sourceNativeSessionId?: string;
    cwd?: string; workspaceId?: string; model?: string; reasoningEffort?: string; planning?: boolean;
  };
}

export function parseCreateRequest(request: { sessionId?: string }, payload: Record<string, unknown>): CreateRequest {
  const providerId = requiredString(payload.providerId, 'providerId');
  const operationId = requiredString(payload.operationId, 'operationId');
  const proposedAgentId = request.sessionId;
  if (!proposedAgentId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
  if (payload.sourceNativeSessionId !== undefined && (typeof payload.sourceNativeSessionId !== 'string' || !payload.sourceNativeSessionId || payload.sourceNativeSessionId.length > 256)) throw new HostRequestError(400, 'invalid_request', 'Source session identity is invalid.');
  const editKeys = ['editNativeSessionId', 'editTurnId', 'editMessageId'] as const;
  const editing = editKeys.some(key => payload[key] !== undefined);
  if (editing && (editKeys.some(key => typeof payload[key] !== 'string' || !(payload[key] as string).trim() || (payload[key] as string).length > 256) || payload.sourceNativeSessionId !== undefined)) throw new HostRequestError(400, 'invalid_request', 'A complete native prompt identity is required.');
  const legacySource = payload.sourceNativeSessionId ?? payload.editNativeSessionId;
  if (payload.creationSource !== undefined && !isCreationSource(payload.creationSource)) throw new HostRequestError(400, 'invalid_request', 'Creation source must contain only a provider and native session identity.');
  const provenance = payload.creationSource === undefined ? (typeof legacySource === 'string' ? { providerId, nativeSessionId: legacySource } : undefined) : payload.creationSource;
  if (provenance && legacySource !== undefined && (provenance.providerId !== providerId || provenance.nativeSessionId !== legacySource)) throw new HostRequestError(400, 'invalid_request', 'Creation source contradicts the native source identity.');
  const settings = {
    ...(editing ? { editNativeSessionId: payload.editNativeSessionId as string, editTurnId: payload.editTurnId as string, editMessageId: payload.editMessageId as string } : {}),
    ...(typeof payload.sourceNativeSessionId === 'string' ? { sourceNativeSessionId: payload.sourceNativeSessionId } : {}),
    ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
    ...(typeof payload.workspaceId === 'string' ? { workspaceId: payload.workspaceId } : {}),
    ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
    ...(typeof payload.reasoningEffort === 'string' ? { reasoningEffort: payload.reasoningEffort } : {}),
    ...(typeof payload.planning === 'boolean' ? { planning: payload.planning } : {}),
  };
  return { providerId, operationId, proposedAgentId, editing, provenance, settings };
}

export interface AttachRequest { proposedAgentId: string; providerId: string; nativeSessionId: string; parent: string | undefined; takeOver: string | undefined }

export function parseAttachRequest(request: { path: string; sessionId?: string }, payload: Record<string, unknown>): AttachRequest {
  if (!request.sessionId) throw new HostRequestError(400, 'invalid_request', 'A proposed Agent identity is required.');
  const providerId = requiredString(payload.providerId, 'providerId');
  const nativeSessionId = requiredString(payload.nativeSessionId, 'nativeSessionId');
  const parent = request.path === '/remote/child/attach' ? requiredString(payload.parentNativeSessionId, 'parentNativeSessionId') : undefined;
  const takeOver = payload.takeOver === undefined ? undefined : requiredString(payload.takeOver, 'takeOver');
  if (takeOver && (parent || !/^[a-f\d-]{36}$/i.test(takeOver))) throw new HostRequestError(400, 'invalid_request', 'A native owner generation is required for takeover.');
  return { proposedAgentId: request.sessionId, providerId, nativeSessionId, parent, takeOver };
}

/** `operationId` is read when asked for, after the Host has checked that the provider can rename, so a missing one is reported last. */
export interface RenameRequest { providerId: string; nativeSessionId: string; title: string; operationId(): string }

export function parseRenameRequest(request: { sessionId?: string }, payload: Record<string, unknown>): RenameRequest {
  const providerId = requiredString(payload.providerId, 'providerId');
  const nativeSessionId = requiredString(payload.nativeSessionId, 'nativeSessionId');
  const title = requiredString(payload.title, 'title').trim();
  if (!title || title.length > 512 || /[\u0000-\u001f\u007f]/.test(title) || request.sessionId || Object.keys(payload).some(key => !['providerId', 'nativeSessionId', 'title', 'operationId'].includes(key))) {
    throw new HostRequestError(400, 'invalid_request', 'A valid session name is required.');
  }
  return { providerId, nativeSessionId, title, operationId: () => requiredString(payload.operationId, 'operationId') };
}

export function parseStopRequest(request: { sessionId?: string }, payload: Record<string, unknown>): string {
  if (Object.keys(payload).some(key => key !== 'operationId') || request.sessionId) throw new HostRequestError(400, 'invalid_request', 'Stop requires only an operation identity.');
  return requiredString(payload.operationId, 'operationId');
}

/** The class and, when it names one, the code of an error; native error text can carry content, so it is never kept. */
export function failureCause(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : typeof error;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
  return code ? `${name} ${code}` : name;
}

/** The answer to a request that failed; `cause` is set only for the generic answers, which do not describe their cause. */
export function failureResponse(error: unknown, request: { method: string; path: string }): { result: AgentRemoteHttpResult; cause?: string } {
  if (error instanceof AgentOperationRejectedError) return { result: json(operationErrorStatus(error.code), { error: error.message, code: error.code }) };
  if (error instanceof NativeSessionOwnerError) return { result: json(409, { error: error.message, code: error.code, ...(error.owner ? { nativeOwner: error.owner } : {}) }) };
  if (error instanceof AgentRuntimeError) return { result: json(error.code === 'native_session_unavailable' ? 404 : 503, { error: error.message, code: error.code }) };
  // The CLI's own reason and wait travel with the refusal, so the Relay and the page can say why and when to try again (O48).
  if (error instanceof AgentSessionInUseError) return { result: json(409, { error: error.message, code: 'session_in_use', ...(error.reason ? { reason: error.reason } : {}),
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) }) };
  if (error instanceof HostExecutionPolicyError) return { result: json(403, { error: error.message, code: 'local_execution_policy' }) };
  if (error instanceof WorkspaceFolderError) return { result: json(error.status, { error: error.message, code: error.code }) };
  if (error instanceof OperationCacheError) return { result: json(operationErrorStatus(error.code), { error: error.message, code: error.code }) };
  if (error instanceof SessionBindingError) return { result: json(error.status, { error: error.message, code: error.code }) };
  if (error instanceof HostRequestError) return { result: json(error.status, { error: error.message, code: error.code }) };
  if (error instanceof RemoteHostCatalogError) return { result: json(error.status, { error: error.message, code: error.code }) };
  if (request.method === 'GET') return { result: json(503, { error: 'The Remote Host catalog is unavailable.', code: 'catalog_unavailable' }) };
  if (request.path === '/remote/attach' || request.path === '/remote/child/attach') {
    return { result: json(503, { error: 'The Host could not open the native session. Check the Controller log and reopen it from the session list.', code: 'session_attach_failed' }), cause: failureCause(error) };
  }
  return { result: json(503, { error: 'Remote Host operation outcome is unknown.', code: 'mutation_outcome_unknown' }), cause: failureCause(error) };
}

/** Bounds a wait: settles with the operation, or resolves after `timeoutMs`, whichever is first. */
export async function bounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([operation, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}

export function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Agent Host shutdown timeout must be a positive integer.');
  return value;
}
