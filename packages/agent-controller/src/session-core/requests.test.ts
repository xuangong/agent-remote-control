import { AgentOperationRejectedError, AgentRuntimeError, AgentSessionInUseError } from '@orchardworks/agent-provider-sdk';
import { OperationCacheError, SessionBindingError, RemoteHostCatalogError } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { HostExecutionPolicyError } from '../execution-policy.js';
import { NativeSessionOwnerError } from '../native-session-owner.js';
import { WorkspaceFolderError } from '../workspace-folders.js';
import {
  bounded, failureCause, failureResponse, HostRequestError, operationErrorStatus, parseAttachRequest, parseBody, parseCreateRequest, parseRenameRequest,
  parseStopRequest, positiveTimeout, publicBinding, requestOperation, requiredString,
} from './requests.js';

const answer = (error: unknown, request = { method: 'POST', path: '/remote/stop' }) => {
  const { result, cause } = failureResponse(error, request);
  return { status: result.status, body: JSON.parse(result.body), cause };
};
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof HostRequestError ? { status: error.status, code: error.code, message: error.message } : error; } return undefined; };
const invalid = (message: string) => ({ status: 400, code: 'invalid_request', message });

describe('reading a request', () => {
  it('needs a non-empty string field, and a JSON object body', () => {
    expect(requiredString('x', 'field')).toBe('x');
    for (const value of [undefined, '', 3, null]) expect(refusal(() => requiredString(value, 'field'))).toEqual(invalid('field is required.'));
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    for (const value of [undefined, '', 'nope', '[]', 'null', '3']) expect(refusal(() => parseBody(value))).toEqual(invalid('Remote Host body is invalid.'));
  });

  it('names the operation a request belongs to', () => {
    expect(requestOperation({ method: 'POST', path: '/remote/attach' })).toBe('session_attach');
    expect(requestOperation({ method: 'POST', path: '/remote/child/attach' })).toBe('session_attach');
    expect(requestOperation({ method: 'POST', path: '/remote/create' })).toBe('session_create');
    expect(requestOperation({ method: 'GET', path: '/remote/catalog' })).toBe('catalog_read');
    expect(requestOperation({ method: 'POST', path: '/remote/stop' })).toBe('host_control');
  });

  it('shows a binding without its provider', () => {
    expect(publicBinding({ agentId: 'a', providerId: 'codex', nativeSessionId: 'n', parentNativeSessionId: 'p' })).toEqual({ agentId: 'a', nativeSessionId: 'n', parentNativeSessionId: 'p' });
  });

  it('maps the operation cache codes to statuses', () => {
    expect(operationErrorStatus('operation_conflict')).toBe(409);
    expect(operationErrorStatus('operation_capacity_exceeded')).toBe(429);
    for (const code of ['native_file_limit', 'operation_outcome_unknown', 'operation_cache_closed', 'operation_clock_invalid']) expect(operationErrorStatus(code)).toBe(503);
    expect(operationErrorStatus('operation_rejected')).toBe(400);
  });
});

describe('a create request', () => {
  const create = (payload: Record<string, unknown>, request: { sessionId?: string } = { sessionId: 'agent-1' }) => parseCreateRequest(request, { providerId: 'codex', operationId: 'op-1', ...payload });

  it('keeps the provider, operation, proposed identity and the settings it names', () => {
    expect(create({ cwd: '/work', workspaceId: 'w', model: 'm', reasoningEffort: 'high', planning: true, ignored: 'x' })).toEqual({
      providerId: 'codex', operationId: 'op-1', proposedAgentId: 'agent-1', editing: false, provenance: undefined,
      settings: { cwd: '/work', workspaceId: 'w', model: 'm', reasoningEffort: 'high', planning: true },
    });
  });

  it('needs a provider, an operation and a proposed identity', () => {
    expect(refusal(() => create({ providerId: '' }))).toEqual(invalid('providerId is required.'));
    expect(refusal(() => create({ operationId: undefined }))).toEqual(invalid('operationId is required.'));
    expect(refusal(() => create({}, {}))).toEqual(invalid('A proposed Agent identity is required.'));
  });

  it('reads a Side\'s source as a creation source of the same provider', () => {
    const request = create({ sourceNativeSessionId: 'source-1' });
    expect(request.settings.sourceNativeSessionId).toBe('source-1');
    expect(request.provenance).toEqual({ providerId: 'codex', nativeSessionId: 'source-1' });
  });

  it('bounds the source identity to 256 characters', () => {
    expect(create({ sourceNativeSessionId: 'x'.repeat(256) }).provenance?.nativeSessionId).toHaveLength(256);
    for (const value of ['x'.repeat(257), '', 5]) expect(refusal(() => create({ sourceNativeSessionId: value }))).toEqual(invalid('Source session identity is invalid.'));
  });

  it('takes a prompt edit only as a complete native prompt identity that is not also a source', () => {
    const edit = { editNativeSessionId: 's', editTurnId: 't', editMessageId: 'm' };
    const request = create(edit);
    expect(request.editing).toBe(true);
    expect(request.settings).toMatchObject(edit);
    expect(request.provenance).toEqual({ providerId: 'codex', nativeSessionId: 's' });
    const message = 'A complete native prompt identity is required.';
    expect(refusal(() => create({ editNativeSessionId: 's', editTurnId: 't' }))).toEqual(invalid(message));
    expect(refusal(() => create({ ...edit, editMessageId: '  ' }))).toEqual(invalid(message));
    expect(refusal(() => create({ ...edit, editTurnId: 'x'.repeat(257) }))).toEqual(invalid(message));
    expect(refusal(() => create({ ...edit, sourceNativeSessionId: 'other' }))).toEqual(invalid(message));
  });

  it('takes an explicit creation source, and refuses one that contradicts the native source identity', () => {
    const source = { providerId: 'claude', nativeSessionId: 'from' };
    expect(create({ creationSource: source }).provenance).toEqual(source);
    expect(create({ creationSource: { providerId: 'codex', nativeSessionId: 's' }, sourceNativeSessionId: 's' }).provenance).toEqual({ providerId: 'codex', nativeSessionId: 's' });
    expect(refusal(() => create({ creationSource: source, sourceNativeSessionId: 'from' }))).toEqual(invalid('Creation source contradicts the native source identity.'));
    expect(refusal(() => create({ creationSource: { providerId: 'codex', nativeSessionId: 'x' }, sourceNativeSessionId: 'y' }))).toEqual(invalid('Creation source contradicts the native source identity.'));
    expect(refusal(() => create({ creationSource: { providerId: 'codex' } }))).toEqual(invalid('Creation source must contain only a provider and native session identity.'));
  });
});

describe('an attach request', () => {
  const attach = (payload: Record<string, unknown>, path = '/remote/attach', request: { sessionId?: string } = { sessionId: 'agent-1' }) => parseAttachRequest({ path, ...request }, { providerId: 'codex', nativeSessionId: 'n', ...payload });
  const generation = '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6';

  it('names the session to bind', () => {
    expect(attach({})).toEqual({ proposedAgentId: 'agent-1', providerId: 'codex', nativeSessionId: 'n', parent: undefined, takeOver: undefined });
  });

  it('needs the proposed identity, a provider and a native session', () => {
    expect(refusal(() => attach({}, '/remote/attach', {}))).toEqual(invalid('A proposed Agent identity is required.'));
    expect(refusal(() => attach({ providerId: undefined }))).toEqual(invalid('providerId is required.'));
    expect(refusal(() => attach({ nativeSessionId: '' }))).toEqual(invalid('nativeSessionId is required.'));
  });

  it('needs the parent of a child attach, and ignores a parent on a plain one', () => {
    expect(attach({ parentNativeSessionId: 'p' }, '/remote/child/attach').parent).toBe('p');
    expect(refusal(() => attach({}, '/remote/child/attach'))).toEqual(invalid('parentNativeSessionId is required.'));
    expect(attach({ parentNativeSessionId: 'p' }).parent).toBeUndefined();
  });

  it('takes over only with a native owner generation, and never on a child attach', () => {
    expect(attach({ takeOver: generation }).takeOver).toBe(generation);
    const message = 'A native owner generation is required for takeover.';
    expect(refusal(() => attach({ takeOver: 'not-a-uuid' }))).toEqual(invalid(message));
    expect(refusal(() => attach({ takeOver: generation, parentNativeSessionId: 'p' }, '/remote/child/attach'))).toEqual(invalid(message));
    expect(refusal(() => attach({ takeOver: '' }))).toEqual(invalid('takeOver is required.'));
  });
});

describe('a rename and a stop request', () => {
  const rename = (payload: Record<string, unknown>, sessionId?: string) => parseRenameRequest({ sessionId }, { providerId: 'codex', nativeSessionId: 'n', title: 'Plan', operationId: 'op', ...payload });

  it('trims the title and reads the operation identity last', () => {
    const request = rename({ title: '  Plan  ', operationId: undefined });
    expect(request).toMatchObject({ providerId: 'codex', nativeSessionId: 'n', title: 'Plan' });
    expect(refusal(() => request.operationId())).toEqual(invalid('operationId is required.'));
    expect(rename({}).operationId()).toBe('op');
  });

  it('refuses a title that is empty, too long or holds control characters, a session address and unknown fields', () => {
    const message = 'A valid session name is required.';
    for (const title of ['   ', 'x'.repeat(513), 'two\nlines', 'bell\u0007']) expect(refusal(() => rename({ title }))).toEqual(invalid(message));
    expect(rename({ title: 'x'.repeat(512) }).title).toHaveLength(512);
    expect(refusal(() => rename({}, 'agent-1'))).toEqual(invalid(message));
    expect(refusal(() => rename({ extra: 1 }))).toEqual(invalid(message));
  });

  it('stops with an operation identity only', () => {
    expect(parseStopRequest({}, { operationId: 'op' })).toBe('op');
    expect(refusal(() => parseStopRequest({}, { operationId: 'op', extra: 1 }))).toEqual(invalid('Stop requires only an operation identity.'));
    expect(refusal(() => parseStopRequest({ sessionId: 'a' }, { operationId: 'op' }))).toEqual(invalid('Stop requires only an operation identity.'));
    expect(refusal(() => parseStopRequest({}, {}))).toEqual(invalid('operationId is required.'));
  });
});

describe('answering a failure', () => {
  it.each([
    ['a rejected operation', new AgentOperationRejectedError('operation_conflict', 'busy'), 409, 'operation_conflict'],
    ['a refused native owner', new NativeSessionOwnerError('native_session_owned', 'A terminal owns it.'), 409, 'native_session_owned'],
    ['an unavailable native session', new AgentRuntimeError('native_session_unavailable', 'gone'), 404, 'native_session_unavailable'],
    ['another runtime failure', new AgentRuntimeError('native_runtime_failed', 'down'), 503, 'native_runtime_failed'],
    ['a session in use', new AgentSessionInUseError('in use'), 409, 'session_in_use'],
    ['the execution policy', new HostExecutionPolicyError('outside'), 403, 'local_execution_policy'],
    ['a folder failure', new WorkspaceFolderError(404, 'folder_not_found', 'none'), 404, 'folder_not_found'],
    ['an operation cache failure', new OperationCacheError('operation_capacity_exceeded', 'full'), 429, 'operation_capacity_exceeded'],
    ['a binding failure', new SessionBindingError('session_binding_conflict', 'taken'), 409, 'session_binding_conflict'],
    ['a request failure', new HostRequestError(400, 'invalid_provider', 'no'), 400, 'invalid_provider'],
    ['a catalog failure', new RemoteHostCatalogError('cursor_expired', 'no'), 409, 'cursor_expired'],
  ])('keeps the status and code of %s, with no cause', (_name, error, status, code) => {
    const response = answer(error);
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(response.cause).toBeUndefined();
  });

  it("says why the CLI refused a session in use, and when to try again, when the adapter knows (O48)", () => {
    expect(answer(new AgentSessionInUseError('Another process writes it.', { reason: 'writer_elsewhere', retryAfterMs: 5000 })).body)
      .toEqual({ code: 'session_in_use', error: 'Another process writes it.', reason: 'writer_elsewhere', retryAfterMs: 5000 });
    expect(answer(new AgentSessionInUseError('In use.')).body).toEqual({ code: 'session_in_use', error: 'In use.' });
  });

  it('shows the owner of a refused native session', () => {
    const owner = { kind: 'native_cli' as const, generation: '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6' };
    expect(answer(new NativeSessionOwnerError('native_session_owned', 'owned', owner)).body.nativeOwner).toEqual(owner);
  });

  it('answers any other failure generically, and records its class and code, never its text', () => {
    const secret = new Error('the prompt said: hunter2');
    expect(answer(secret, { method: 'GET', path: '/remote/catalog' })).toMatchObject({ status: 503, body: { code: 'catalog_unavailable' }, cause: undefined });
    const attach = answer(secret, { method: 'POST', path: '/remote/attach' });
    expect(attach).toMatchObject({ status: 503, body: { code: 'session_attach_failed' }, cause: 'Error' });
    expect(answer(secret, { method: 'POST', path: '/remote/child/attach' }).body.code).toBe('session_attach_failed');
    const other = answer(Object.assign(new TypeError('x'), { code: 'native_boom' }));
    expect(other).toMatchObject({ status: 503, body: { code: 'mutation_outcome_unknown' }, cause: 'TypeError native_boom' });
    expect(JSON.stringify([attach, other])).not.toContain('hunter2');
  });

  it('records the class of an error that is not an Error, and ignores a code that is not a plain identifier', () => {
    expect(failureCause('text')).toBe('string');
    expect(failureCause(Object.assign(new Error('x'), { name: 'bad name!' }))).toBe('object');
    expect(failureCause(Object.assign(new Error('x'), { code: 'Not A Code' }))).toBe('Error');
  });
});

describe('bounding a wait', () => {
  it('settles with the operation, or after the timeout', async () => {
    await expect(bounded(Promise.resolve(), 10_000)).resolves.toBeUndefined();
    await expect(bounded(new Promise(() => undefined), 5)).resolves.toBeUndefined();
    await expect(bounded(Promise.reject(new Error('failed')), 10_000)).rejects.toThrow('failed');
  });

  it('accepts a positive integer timeout only', () => {
    expect(positiveTimeout(5)).toBe(5);
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) expect(() => positiveTimeout(value)).toThrow(RangeError);
  });
});
