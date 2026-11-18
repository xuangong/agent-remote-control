import { createOperationCache, type RemoteHostControlRequest } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { createAdmission } from './admission.js';
import type { SessionCoreContext } from './context.js';
import { createControlRoutes } from './control-routes.js';
import type { AgentHostRequestDiagnostic, SessionBinding } from './types.js';

const OPERATION = '0f3c2a1e-5b6d-4c7e-8f90-a1b2c3d4e5f6';
const request = (path: string, body?: unknown, extra: Partial<RemoteHostControlRequest> = {}): RemoteHostControlRequest => ({
  requestId: 'req-1', method: body === undefined ? 'GET' : 'POST', path, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
});

/** Fake ports: a context with the parts the routes read, and a record of what they asked of them. */
function routes(overrides: Partial<SessionCoreContext> = {}, options: Partial<SessionCoreContext['options']> = {}) {
  const diagnostics: AgentHostRequestDiagnostic[] = [];
  const projected: unknown[][] = [];
  const admission = createAdmission();
  const ctx = {
    options: { registrations: [], onRequestDiagnostic: (entry: AgentHostRequestDiagnostic) => { diagnostics.push(entry); }, ...options },
    admission, operationCache: createOperationCache(), successionReady: Promise.resolve(), cancelTimeoutMs: 50,
    hostStatus: { read: async () => ({ sessions: 0 }) }, catalogs: new Map(), bindings: { values: () => [], getByAgent: () => undefined },
    liveAgent: () => undefined, tracked: <T,>(operation: Promise<T>) => operation, mutationFamily: () => [],
    nativeRef: (binding: Pick<SessionBinding, 'providerId' | 'nativeSessionId'>) => ({ controllerId: 'controller', ...binding }),
    markShared: async () => undefined, registration: () => { throw new Error('No registration.'); },
    project: async (...args: unknown[]) => { projected.push(args); return { agentId: String(args[1]), providerId: String(args[0]), nativeSessionId: String(args[2]) }; },
    ...overrides,
  } as unknown as SessionCoreContext;
  return { ...createControlRoutes(ctx), diagnostics, projected, admission };
}
const parse = (result: { status: number; body: string }) => ({ status: result.status, body: result.body ? JSON.parse(result.body) : undefined });

describe('control routes: admission and diagnostics', () => {
  it('refuses everything while closed and names the request in the error', async () => {
    const run = routes();
    run.admission.close();
    expect(parse(await run.control(request('/remote/host-status')))).toEqual({ status: 503, body: { error: 'Agent Host is closed.', code: 'host_closed', requestId: 'req-1' } });
  });

  it('refuses mutations while draining, and keeps answering reads', async () => {
    const run = routes();
    run.admission.beginDrain();
    expect(parse(await run.control(request('/remote/stop', { operationId: OPERATION }))).body.code).toBe('controller_updating');
    expect(parse(await run.control(request('/remote/host-status'))).status).toBe(200);
  });

  it('records a started and a completed diagnostic, with the status and a digest of the native session, never the session itself', async () => {
    const run = routes();
    await run.control(request('/remote/attach', { providerId: 'codex', nativeSessionId: 'thread-secret' }, { sessionId: 'agent-1' }));
    expect(run.diagnostics.map(entry => [entry.event, entry.operation, entry.status])).toEqual([['host_request_started', 'session_attach', undefined], ['host_request_completed', 'session_attach', 200]]);
    expect(run.diagnostics[1]!.sessionRef).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(run.diagnostics)).not.toContain('thread-secret');
  });

  it('is not failed by a diagnostic sink that throws', async () => {
    const run = routes({}, { onRequestDiagnostic: () => { throw new Error('sink down'); } });
    expect((await run.control(request('/remote/host-status'))).status).toBe(200);
  });

  it('refuses a request no route knows, and a malformed body', async () => {
    const run = routes();
    expect(parse(await run.control(request('/remote/unknown', {}))).body.code).toBe('invalid_request');
    expect(parse(await run.control({ requestId: 'req-2', method: 'POST', path: '/remote/stop', body: 'not json' })).body.code).toBe('invalid_request');
  });
});

describe('control routes: attach', () => {
  const attach = { providerId: 'codex', nativeSessionId: 'thread-1' };

  it('binds the proposed identity and answers the binding without its provider', async () => {
    const run = routes();
    const answer = parse(await run.control(request('/remote/attach', attach, { sessionId: 'agent-1' })));
    expect(answer).toEqual({ status: 200, body: { agentId: 'agent-1', nativeSessionId: 'thread-1' } });
    expect(run.projected[0]!.slice(0, 5)).toEqual(['codex', 'agent-1', 'thread-1', undefined, undefined]);
  });

  it('repeats a native start failure instead of starting the session again, until a takeover asks', async () => {
    let calls = 0;
    const run = routes({ project: async () => { calls += 1; throw new Error('native start failed'); } });
    const first = parse(await run.control(request('/remote/attach', attach, { sessionId: 'agent-1' })));
    expect(first.body.code).toBe('session_attach_failed');
    const second = parse(await run.control(request('/remote/attach', attach, { sessionId: 'agent-1' })));
    expect(second.body.code).toBe('session_attach_failed');
    expect(calls).toBe(1);
    expect(run.diagnostics.at(-1)).toMatchObject({ backoff: true });
    await run.control(request('/remote/attach', { ...attach, takeOver: OPERATION }, { sessionId: 'agent-1' }));
    expect(calls).toBe(2);
  });

  it('records the class of a generic failure, never its text', async () => {
    const run = routes({ project: async () => { throw new TypeError('the prompt said hunter2'); } });
    await run.control(request('/remote/attach', attach, { sessionId: 'agent-1' }));
    expect(run.diagnostics.at(-1)).toMatchObject({ cause: 'TypeError' });
    expect(JSON.stringify(run.diagnostics)).not.toContain('hunter2');
  });

  it('refuses a provider that is disabled, unless the session is already live under that identity', async () => {
    const disabled = { providerEnabled: () => false };
    const refused = routes({}, disabled);
    expect(parse(await refused.control(request('/remote/attach', attach, { sessionId: 'agent-1' }))).body.code).toBe('provider_disabled');
    const recovering = routes({
      bindings: { getByAgent: () => ({ agentId: 'agent-1', ...attach }), values: () => [] } as never, liveAgent: () => ({}) as never,
    }, disabled);
    expect(parse(await recovering.control(request('/remote/attach', attach, { sessionId: 'agent-1' }))).status).toBe(200);
  });
});

describe('control routes: stop', () => {
  it('cancels every live session and reports cancelled, unsupported and failed apart', async () => {
    const live: Record<string, { cancel(): Promise<void> }> = {
      ok: { cancel: async () => undefined }, broken: { cancel: async () => { throw new Error('boom'); } }, hung: { cancel: () => new Promise<void>(() => undefined) },
    };
    const run = routes({
      bindings: { values: () => Object.keys(live).map(agentId => ({ agentId, providerId: 'codex', nativeSessionId: agentId })), getByAgent: () => undefined } as never,
      liveAgent: agentId => live[agentId] as never,
      idle: { retain: () => () => undefined } as never,
      relay: { requireAgent: (agentId: string) => live[agentId] } as never,
    });
    const answer = parse(await run.control(request('/remote/stop', { operationId: OPERATION })));
    expect(answer.status).toBe(200);
    expect(Object.fromEntries(answer.body.results.map((result: { agentId: string; status: string }) => [result.agentId, result.status]))).toEqual({ ok: 'cancelled', broken: 'failed', hung: 'failed' });
  });
});
