import { describe, expect, it } from 'vitest';

import { createAccess } from './access.js';
import { createBrokerState, type BrokerState } from './broker-state.js';
import type { Binding, Host, RpcResponse } from './broker-types.js';
import { sequentialRelayIds } from './relay-ids.js';
import { createSessionBindings } from './session-bindings.js';
import { createSuccession } from './succession-service.js';
import { RELAY_SOCKET_OPEN } from './transport.js';
import { ManualClock } from './test-utils/fake-host-link.js';

const host = (): Host => ({ id: 'h1', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, generation: 1,
  pending: new Map(), streams: new Map(), ready: true, control: true, socket: { readyState: RELAY_SOCKET_OPEN } as never });

type Answer = (path: string, body: Record<string, any>) => RpcResponse | Promise<RpcResponse>;
const ok = (body: unknown): RpcResponse => ({ status: 200, body: JSON.stringify(body) });

function setup(answer: Answer, options: { ownerSubject?: string; onStateChange?: () => Promise<void> } = {}) {
  const clock = new ManualClock();
  const state: BrokerState = createBrokerState({ initialState: undefined, now: () => clock.time, keepsAssociations: false, keepsSharing: options.ownerSubject !== undefined,
    ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}) });
  const subject = host();
  state.hosts.set(subject.id, subject);
  const ownerSubject = options.ownerSubject;
  const access = createAccess({ state, ownerSubject });
  const ids = sequentialRelayIds();
  const calls: Array<{ method: string; path: string; sessionId?: string; body: Record<string, any> }> = [];
  const rpc = async (_host: Host, method: 'GET' | 'POST', path: string, sessionId?: string, body?: string) => {
    const parsed = body ? JSON.parse(body) : {};
    calls.push({ method, path, ...(sessionId ? { sessionId } : {}), body: parsed });
    return answer(path, parsed);
  };
  const succession = createSuccession({ brokerState: state, enrollment: undefined, projectionAllowance: undefined, ids, rpc,
    teams: { assertReplacementSupported: () => undefined, hasUnsettledRecipient: () => false }, creations: { has: () => false } });
  const bindings = createSessionBindings({ brokerState: state, access, succession, rpc, ids, now: () => clock.time, scheduler: clock, enrollmentEnabled: false, savedAssociations: undefined,
    ownerSubject, rpcTimeoutMs: 1000 });
  return { state, host: subject, bindings, calls, clock };
}

const attachAnswer = (agentId = 'runtime-1'): Answer => (path, body) => path === '/remote/attach' || path === '/remote/child/attach' ? ok({ agentId, nativeSessionId: body.nativeSessionId }) : { status: 404, body: '{}' };

describe('attaching a native session', () => {
  it('saves the binding under the identity the Controller confirmed, and answers a repeat with the same binding', async () => {
    const run = setup(attachAnswer());
    const first = await run.bindings.mutate(run.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' });
    expect(first).toMatchObject({ hostId: 'h1', providerId: 'codex', nativeSessionId: 'n1' });
    expect(run.state.bindings.get(first.agentId)).toBe(first);
    expect(run.state.snapshot().bindings).toEqual([{ hostId: 'h1', providerId: 'codex', nativeSessionId: 'n1', agentId: first.agentId }]);
    const again = await run.bindings.mutate(run.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' });
    expect(again).toBe(first);
    // Every attach asks the Controller again: a person may have taken the session over.
    expect(run.calls.filter(call => call.path === '/remote/attach')).toHaveLength(2);
  });

  it('joins concurrent attaches of the same session into one request to the Controller', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = setup(async (path, body) => { await gate; return attachAnswer()(path, body); });
    const first = run.bindings.mutate(run.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' });
    const second = run.bindings.mutate(run.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' });
    await Promise.resolve();
    release();
    expect(await first).toBe(await second);
    expect(run.calls).toHaveLength(1);
  });

  it('saves nothing when the Controller refuses or answers another native identity', async () => {
    const refused = setup(() => ({ status: 404, body: JSON.stringify({ code: 'native_session_unavailable', error: 'Gone.' }) }));
    await expect(refused.bindings.mutate(refused.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' })).rejects.toMatchObject({ status: 404, code: 'native_session_unavailable' });
    expect(refused.state.bindings.size).toBe(0);
    const swapped = setup((_path, _body) => ok({ agentId: 'runtime-1', nativeSessionId: 'other' }));
    await expect(swapped.bindings.mutate(swapped.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' })).rejects.toMatchObject({ status: 409, code: 'native_identity_conflict' });
    expect(swapped.state.bindings.size).toBe(0);
  });

  it('passes the native owner of a refused attach on to the caller', async () => {
    const owner = { kind: 'native_cli', generation: '11111111-1111-4111-8111-111111111111' };
    const run = setup(() => ({ status: 409, body: JSON.stringify({ code: 'native_session_owned', error: 'A terminal holds it.', nativeOwner: owner }) }));
    await expect(run.bindings.mutate(run.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' })).rejects.toMatchObject({ status: 409, code: 'native_session_owned', nativeOwner: owner });
  });

  it('refuses a provider the Host does not offer, before it asks the Controller', async () => {
    const run = setup(attachAnswer());
    await expect(run.bindings.mutate(run.host, 'attach', { providerId: 'claude', nativeSessionId: 'n1' })).rejects.toMatchObject({ status: 400, code: 'invalid_provider' });
    expect(run.calls).toEqual([]);
  });
});

describe('creating a native session', () => {
  const createAnswer: Answer = (path, body) => path === '/remote/create' ? ok({ agentId: 'runtime-2', nativeSessionId: 'created-1' }) : path === '/remote/attach' ? ok({ agentId: 'runtime-2', nativeSessionId: body.nativeSessionId }) : { status: 404, body: '{}' };
  const operationId = '00000000-0000-4000-8000-0000000000c1';

  it('creates once per operation id, whatever the number of retries, and records the completed creation', async () => {
    const run = setup(createAnswer);
    const first = await run.bindings.mutate(run.host, 'create', { providerId: 'codex', operationId });
    const retry = await run.bindings.mutate(run.host, 'create', { providerId: 'codex', operationId });
    expect(retry).toBe(first);
    expect(first.nativeSessionId).toBe('created-1');
    expect(run.calls.filter(call => call.path === '/remote/create')).toHaveLength(1);
    expect([...run.state.completedCreations.values()]).toEqual([{ fingerprint: expect.any(String), agentId: first.agentId }]);
  });

  it('refuses the same operation id with other settings', async () => {
    const run = setup(createAnswer);
    await run.bindings.mutate(run.host, 'create', { providerId: 'codex', operationId, model: 'a' });
    await expect(run.bindings.mutate(run.host, 'create', { providerId: 'codex', operationId, model: 'b' })).rejects.toMatchObject({ status: 409, code: 'request_conflict' });
  });

  it('answers 504 at the caller\'s deadline and lets the creation finish for the retry', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = setup(async (path, body) => { if (path === '/remote/create') await gate; return createAnswer(path, body); });
    const creation = run.bindings.mutate(run.host, 'create', { providerId: 'codex', operationId });
    const waiting = run.bindings.waitForCreation(creation);
    const timeout = expect(waiting).rejects.toMatchObject({ status: 504, code: 'session_create_pending' });
    run.clock.advance(1000);
    await timeout;
    release();
    const binding = await creation;
    expect(await run.bindings.mutate(run.host, 'create', { providerId: 'codex', operationId })).toBe(binding);
    expect(run.calls.filter(call => call.path === '/remote/create')).toHaveLength(1);
  });
});

describe('recovering a binding after the Host reconnected', () => {
  const bound = (run: ReturnType<typeof setup>, extra: Partial<Binding> = {}): Binding => {
    const binding: Binding = { hostId: 'h1', providerId: 'codex', nativeSessionId: 'n1', agentId: 'public-1', generation: 0, ...extra };
    run.state.bindings.set(binding.agentId, binding);
    run.state.nativeBindings.set(JSON.stringify(['h1', 'codex', binding.nativeSessionId]), binding);
    return binding;
  };

  it('attaches once per connection generation and remembers the Controller\'s own id for the session', async () => {
    const run = setup(attachAnswer('runtime-9'));
    const binding = bound(run);
    expect(run.bindings.runtimeAgentId(run.host, binding)).toBe('public-1');
    await Promise.all([run.bindings.recoverBinding(run.host, binding), run.bindings.recoverBinding(run.host, binding)]);
    await run.bindings.recoverBinding(run.host, binding);
    expect(run.calls).toEqual([{ method: 'POST', path: '/remote/attach', sessionId: 'public-1', body: { providerId: 'codex', nativeSessionId: 'n1' } }]);
    expect(binding.generation).toBe(run.host.generation);
    expect(run.bindings.runtimeAgentId(run.host, binding)).toBe('runtime-9');
    run.host.generation += 1;
    expect(run.bindings.runtimeAgentId(run.host, binding)).toBe('public-1');
  });

  it('refuses when the Controller answers another session, and when a binding was revoked meanwhile', async () => {
    const swapped = setup((_path, _body) => ok({ agentId: 'runtime-1', nativeSessionId: 'other' }));
    await expect(swapped.bindings.recoverBinding(swapped.host, bound(swapped))).rejects.toMatchObject({ status: 409, code: 'session_binding_conflict' });
    const revoked = setup(attachAnswer());
    const binding = bound(revoked);
    revoked.state.bindings.delete(binding.agentId);
    await expect(revoked.bindings.recoverBinding(revoked.host, binding)).rejects.toMatchObject({ status: 404, code: 'session_unavailable' });
  });

  it('attaches the parent of a child session first, and refuses a child whose parent was never attached', async () => {
    const run = setup((path, body) => path.endsWith('/attach') ? ok({ agentId: `runtime-${body.nativeSessionId}`, nativeSessionId: body.nativeSessionId }) : { status: 404, body: '{}' });
    const child = bound(run, { agentId: 'child-1', nativeSessionId: 'c1', parentNativeSessionId: 'n1' });
    await expect(run.bindings.recoverBinding(run.host, child)).rejects.toMatchObject({ status: 409, code: 'parent_binding_missing' });
    bound(run);
    await run.bindings.recoverBinding(run.host, child);
    expect(run.calls.map(call => call.path)).toEqual(['/remote/attach', '/remote/child/attach']);
  });

  it('asks for a Controller update before a Host that did not take over session control opens any session', async () => {
    const run = setup(attachAnswer());
    run.host.control = undefined;
    await expect(run.bindings.recoverBinding(run.host, bound(run))).rejects.toMatchObject({ status: 409, code: 'controller_upgrade_required' });
    expect(run.calls).toEqual([]);
  });

  it('forgets a Host\'s bindings and creation records when it is revoked', async () => {
    const run = setup(attachAnswer());
    const binding = await run.bindings.mutate(run.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' });
    run.state.completedCreations.set(JSON.stringify(['h1', 'codex', 'op']), { fingerprint: 'f', agentId: binding.agentId });
    run.bindings.forgetHost('h1');
    expect(run.state.bindings.size).toBe(0);
    expect(run.state.nativeBindings.size).toBe(0);
    expect(run.state.completedCreations.size).toBe(0);
    expect(run.bindings.hasCreation(JSON.stringify(['h1', 'codex', 'op']))).toBe(false);
  });
});

describe('a shared Host\'s guest', () => {
  it('may attach only a session it created', async () => {
    const run = setup(attachAnswer(), { ownerSubject: 'owner' });
    const other: Binding = { hostId: 'h1', providerId: 'codex', nativeSessionId: 'n1', agentId: 'public-1', generation: 1, creatorSubject: 'someone-else' };
    run.state.bindings.set(other.agentId, other);
    run.state.nativeBindings.set(JSON.stringify(['h1', 'codex', 'n1']), other);
    run.state.sharing = new (await import('./host-sharing.js')).HostSharing({ grants: [{ hostId: 'h1', subject: 'guest', sessionQuota: 5 } as never], reservations: [] }, () => {});
    await expect(run.bindings.userMutation(run.host, 'attach', { providerId: 'codex', nativeSessionId: 'n1' }, 'guest')).rejects.toMatchObject({ status: 403, code: 'session_forbidden' });
    expect(run.calls).toEqual([]);
  });
});

describe('revoked bindings and guarded creations', () => {
  let created = 0;
  const createAnswer: Answer = (path, body) => path === '/remote/create' ? ok({ agentId: `runtime-${++created}`, nativeSessionId: `created-${created}` })
    : path === '/remote/attach' ? ok({ agentId: 'runtime-1', nativeSessionId: body.nativeSessionId }) : { status: 404, body: '{}' };
  const op = (index: number) => `00000000-0000-4000-8000-0000000000d${index}`;
  const bind = (run: ReturnType<typeof setup>, nativeSessionId: string, agentId: string): Binding => {
    const binding: Binding = { hostId: 'h1', providerId: 'codex', nativeSessionId, agentId, generation: 0 };
    run.state.bindings.set(agentId, binding); run.state.nativeBindings.set(JSON.stringify(['h1', 'codex', nativeSessionId]), binding);
    return binding;
  };

  it('does not ask the Controller to reopen a session whose binding was revoked', async () => {
    const run = setup(attachAnswer());
    const binding = bind(run, 'n1', 'public-1');
    run.state.bindings.delete('public-1');
    await expect(run.bindings.recoverBinding(run.host, binding)).rejects.toMatchObject({ status: 404, code: 'session_unavailable' });
    expect(run.calls).toEqual([]);
  });

  it('does not restore a binding that was revoked while its reattachment was waiting to be saved', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // The Controller answers while a revocation is already being saved; the reattachment's own save queues behind it.
    const run: ReturnType<typeof setup> = setup((path, body) => {
      void run.state.commit(() => ({ value: undefined, publish() { run.state.bindings.delete('public-1'); } }));
      return attachAnswer('runtime-1')(path, body);
    }, { onStateChange: () => gate });
    const binding = bind(run, 'n1', 'public-1');
    const outcome = expect(run.bindings.recoverBinding(run.host, binding)).rejects.toMatchObject({ status: 404, code: 'session_unavailable' });
    await new Promise(resolve => setImmediate(resolve));
    release();
    await outcome;
    expect(binding.generation).toBe(0);
    expect(run.bindings.runtimeAgentId(run.host, binding)).toBe('public-1');
  });

  it('keeps a guest to the creation quota the Host owner granted', async () => {
    const run = setup(createAnswer, { ownerSubject: 'owner' });
    run.state.sharing.set('h1', 'guest', 'Guest', 1);
    await run.bindings.waitForCreation(run.bindings.userMutation(run.host, 'create', { providerId: 'codex', operationId: op(1) }, 'guest'));
    await expect(run.bindings.userMutation(run.host, 'create', { providerId: 'codex', operationId: op(2) }, 'guest')).rejects.toMatchObject({ status: 409, code: 'session_quota_exceeded' });
    expect(run.calls.filter(call => call.path === '/remote/create')).toHaveLength(1);
    expect(run.state.sharing.quota('h1', 'guest')).toEqual({ limit: 1, used: 1 });
  });

  it('refuses a creation whose source contradicts its native source identity, and takes one that agrees', async () => {
    const run = setup(createAnswer);
    bind(run, 'source-1', 'source-agent');
    const source = { providerId: 'codex', nativeSessionId: 'source-1' };
    await expect(run.bindings.userMutation(run.host, 'create', { providerId: 'codex', operationId: op(3), creationSource: source, sourceNativeSessionId: 'another' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request', message: expect.stringContaining('contradicts') });
    await expect(run.bindings.userMutation(run.host, 'create', { providerId: 'codex', operationId: op(4), creationSource: { providerId: 'other', nativeSessionId: 'source-1' }, sourceNativeSessionId: 'source-1' }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(run.calls).toEqual([]);
    await run.bindings.waitForCreation(run.bindings.userMutation(run.host, 'create', { providerId: 'codex', operationId: op(5), creationSource: source }));
    await run.bindings.waitForCreation(run.bindings.userMutation(run.host, 'create', { providerId: 'codex', operationId: op(6), creationSource: source, sourceNativeSessionId: 'source-1' }));
    expect(run.calls.filter(call => call.path === '/remote/create')).toHaveLength(2);
  });
});
