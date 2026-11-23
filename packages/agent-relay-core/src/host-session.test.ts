import { PROTOCOL_VERSION, type NativeSessionOwner, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import { BrokerError } from './broker-types.js';
import { createStreamControl } from './stream-control.js';
import { BROKER_MAX_FRAME_BYTES } from './transport.js';
import { FakeSocket, hashOf, hostSessionFixture, registration } from './test-utils/fake-host-link.js';

const ack = (nonce: string) => ({ uplinkVersion: 2, type: 'heartbeat_ack', nonce });

describe('host session registration', () => {
  it('acknowledges the registration with the heartbeat deadlines and session control, and records the Host online', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    expect(socket.sent[0]).toMatchObject({ type: 'registered', heartbeat: { intervalMs: 30, timeoutMs: 10 }, control: 1, hostId: expect.any(String) });
    expect(run.host()).toMatchObject({ installationId: 'machine', name: 'Machine', ready: true, control: true });
  });

  it('closes a connection that sends no registration within the deadline, and leaves one that registered in time', async () => {
    const run = hostSessionFixture({ registrationDeadlineMs: 50, heartbeat: { intervalMs: 600_000, timeoutMs: 10_000 } });
    const silent = await run.connect({ register: false });
    const registered = await run.connect();
    run.clock.advance(49);
    expect(silent.closes).toEqual([]);
    run.clock.advance(1);
    expect(silent.closes).toEqual([{ code: 1008, reason: 'Registration deadline exceeded' }]);
    expect(registered.closes).toEqual([]);
  });

  it('refuses a registration whose credential is gone, and a first message that is not a registration', async () => {
    const run = hostSessionFixture();
    const stranger = await run.connect({ register: false });
    await stranger.receive({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: 'x' });
    expect(stranger.closes.at(-1)?.code).toBe(1008);
    expect(run.state.hosts.size).toBe(0);
    const revoked = await run.connect({ register: false });
    run.state.keys.clear();
    await revoked.receive(registration());
    expect(revoked.closes.at(-1)).toEqual({ code: 1008, reason: 'Device credential revoked' });
  });

  it.each(['throw', 'error'] as const)('retires the registration when the socket reports a synchronous send %s', async failure => {
    const run = hostSessionFixture();
    const socket = await run.connect({ register: false });
    socket.sendFailure = failure;
    await socket.receive(registration());
    expect(run.host()!.ready).toBeFalsy();
    expect(run.clock.timers.size).toBe(0);
    expect(socket.closes.at(-1)?.code).toBe(1011);
  });

  it('closes the older connection of a Host that registers again, and fails what began on it', async () => {
    const run = hostSessionFixture();
    const old = await run.connect();
    const generation = run.host()!.generation;
    const pending = run.session.rpc(run.host()!, 'GET', '/remote/catalog');
    const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
    await run.connect();
    await rejected;
    expect(old.closes.at(-1)?.code).toBe(1012);
    expect(run.host()!.generation).toBe(generation + 1);
  });
});

describe('host session heartbeat', () => {
  it('sends the first heartbeat only after registration, and keeps its cadence whatever the acknowledgement latency', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect({ register: false });
    run.clock.advance(100);
    expect(socket.sent).toHaveLength(0);
    await socket.receive(registration());
    run.clock.advance(30);
    const first = socket.sent.at(-1)!;
    expect(first).toMatchObject({ type: 'heartbeat', nonce: expect.any(String) });
    run.clock.advance(5);
    await socket.receive(ack(first.nonce));
    run.clock.advance(25);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'heartbeat' });
    expect(socket.sent.at(-1)!.nonce).not.toBe(first.nonce);
    expect(socket.closes).toEqual([]);
  });

  it('requires the acknowledgement of the current nonce, not of an earlier one', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    run.clock.advance(30);
    const previous = socket.sent.at(-1)!.nonce;
    await socket.receive(ack(previous));
    run.clock.advance(30);
    await socket.receive(ack(previous));
    run.clock.advance(10);
    expect(run.host()!.ready).toBe(false);
    expect(socket.closes.at(-1)?.code).toBe(1012);
  });

  it('marks a silent Host offline and rejects its pending requests before the socket reports a close', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const request = run.session.rpc(run.host()!, 'GET', '/remote/catalog?providerId=codex');
    const outcome = expect(request).rejects.toMatchObject({ status: 503, code: 'host_offline' });
    run.clock.advance(30);
    await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: 'unrelated', status: 200, body: '{}' });
    run.clock.advance(10);
    await outcome;
    expect(run.host()!.ready).toBe(false);
    expect(socket.readyState).toBe(1);
    expect(socket.closes).toEqual([{ code: 1012, reason: expect.any(String) }]);
    const count = socket.sent.length;
    run.clock.advance(100);
    expect(socket.sent).toHaveLength(count);
  });

  it('keeps the heartbeat of a replacement connection apart from the callbacks and close of the old one', async () => {
    const run = hostSessionFixture();
    const old = await run.connect();
    run.clock.advance(30);
    const callbacks = [...run.clock.timers.values()].map(timer => timer.callback);
    const replacement = await run.connect();
    for (const callback of callbacks) callback();
    expect(run.clock.timers.size).toBe(2);
    old.finishClose();
    expect(run.host()!.ready).toBe(true);
    expect(replacement.closes).toHaveLength(0);
    run.clock.advance(30);
    expect(replacement.of('heartbeat')).toHaveLength(1);
    expect(old.of('heartbeat')).toHaveLength(1);
  });

  it.each(['close', 'error', 'close all'] as const)('clears the heartbeat timers on %s', async action => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    run.clock.advance(30);
    if (action === 'close') socket.finishClose();
    if (action === 'error') for (const callback of socket.errors) callback();
    if (action === 'close all') run.session.closeAll('relay_closed', 1001);
    expect(run.clock.timers.size).toBe(0);
    const count = socket.sent.length, closes = socket.closes.length;
    run.clock.advance(100);
    expect(socket.sent).toHaveLength(count);
    expect(socket.closes).toHaveLength(closes);
    expect(run.host()!.ready).toBe(false);
  });
});

describe('host session ending', () => {
  it('closes the browser streams of a Host that disconnects, and clears them and their opening deadlines', async () => {
    const run = hostSessionFixture();
    await run.connect();
    const closed: Array<[number | undefined, string | undefined]> = [];
    const timer = run.clock.setTimeout(() => closed.push([0, 'deadline fired']), 1000);
    run.host()!.streams.set('s1', { timer, socket: { close: (code?: number, reason?: string) => closed.push([code, reason]) } } as never);
    run.session.closeAll('relay_closed', 1001);
    expect(closed).toEqual([[1012, 'Remote Host disconnected']]);
    expect(run.host()!.streams.size).toBe(0);
    run.clock.advance(2000);
    expect(closed).toHaveLength(1);
  });

  it('closes streams with the revoked wording when the Host\'s access ended', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const closed: Array<[number | undefined, string | undefined]> = [];
    run.host()!.streams.set('s1', { timer: undefined, socket: { close: (code?: number, reason?: string) => closed.push([code, reason]) } } as never);
    run.session.disconnected(run.host()!, socket, 'access_revoked', 1008);
    expect(closed).toEqual([[1008, 'Host access revoked']]);
  });
});

describe('host session expiry and failure', () => {
  it('retires a device whose credential expires before waiting for its pending heartbeat deadline', async () => {
    const run = hostSessionFixture({ initialState: { keys: [['hash-placeholder', { expires: 0 }]], hosts: [], bindings: [], creations: [] } });
    run.state.keys.clear();
    run.state.keys.set(hashOf('key'), { expires: 10_035, installationId: 'machine', kind: 'device' });
    const socket = await run.connect();
    run.clock.advance(35);
    expect(socket.closes.at(-1)?.code).toBe(1008);
    expect(run.clock.timers.size).toBe(0);
    expect(run.host()!.ready).toBe(false);
  });

  it('retires the connection and its timers when a save fails and the state becomes unavailable', async () => {
    let fail = false;
    const run = hostSessionFixture({ onStateChange: async () => { if (fail) throw new Error('Storage unavailable'); } });
    const socket = await run.connect();
    run.clock.advance(30);
    fail = true;
    await expect(run.state.commit(() => ({ value: 0, publish() {} }))).rejects.toThrow('Storage unavailable');
    expect(socket.closes.at(-1)?.code).toBe(1011);
    expect(run.clock.timers.size).toBe(0);
  });
});

describe('host session requests', () => {
  it('sends a request, matches its response by id, and refuses the 129th pending request', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const answered = run.session.rpc(run.host()!, 'POST', '/remote/attach', 'agent', '{"a":1}');
    const request = socket.of('rpc_request')[0]!;
    expect(request).toMatchObject({ method: 'POST', path: '/remote/attach', sessionId: 'agent', body: '{"a":1}' });
    await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: request.requestId, status: 200, body: '{"ok":true}' });
    expect(await answered).toMatchObject({ status: 200, body: '{"ok":true}' });
    const pending = Array.from({ length: 128 }, () => { const call = run.session.rpc(run.host()!, 'GET', '/remote/catalog'); void call.catch(() => undefined); return call; });
    await expect(run.session.rpc(run.host()!, 'GET', '/remote/catalog')).rejects.toMatchObject({ status: 429, code: 'host_busy' });
    run.session.closeAll('relay_closed', 1001);
    await Promise.allSettled(pending);
  });

  it('times out an attach with its own wording after telling the Controller to cancel', async () => {
    const run = hostSessionFixture({ heartbeat: { intervalMs: 600_000, timeoutMs: 10_000 } });
    const socket = await run.connect();
    const attach = run.session.rpc(run.host()!, 'POST', '/remote/attach', 'agent', '{}');
    const outcome = expect(attach).rejects.toMatchObject({ status: 504, code: 'session_attach_timeout' });
    run.clock.advance(30_000);
    await outcome;
    expect(socket.of('rpc_cancel')).toHaveLength(1);
  });

  it('refuses a request while the Host is offline or its output is backed up', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    socket.bufferedAmount = 17 * 1024 * 1024;
    await expect(run.session.rpc(run.host()!, 'GET', '/remote/catalog')).rejects.toMatchObject({ status: 503, code: 'host_backpressure' });
    socket.readyState = 3;
    await expect(run.session.rpc(run.host()!, 'GET', '/remote/catalog')).rejects.toMatchObject({ status: 503, code: 'host_offline' });
  });
});

/** The checks that keep a Host connection inside what its credential and its registration allow. */
describe('host session authorization', () => {
  const invitation = (installationId?: string) => [hashOf('invite'), { expires: 1_000_000, ...(installationId ? { installationId } : {}) }] as const;
  const deviceKey = (name: string, installationId: string) => [hashOf(name), { expires: Number.MAX_SAFE_INTEGER, installationId, kind: 'device' as const }] as const;
  const stateOf = (...keys: Array<readonly [string, any]>) => ({ keys: keys.map(([hash, key]) => [hash, key] as [string, any]), hosts: [], bindings: [], creations: [] });
  const hostCall = () => ({ calls: [] as unknown[], deferred: undefined as undefined | ((value: unknown) => void), async hostCall(_hostId: string, call: unknown) {
    this.calls.push(call); return new Promise(resolve => { this.deferred = resolve; });
  } });

  it('acknowledges the outbox only when the Controller asked for it and the Relay serves one', async () => {
    const served = await hostSessionFixture({ ports: { options: { outbox: hostCall() } } }).connect({ grants: { outboxRequested: true } });
    expect(served.of('registered')[0]).toMatchObject({ outbox: 1 });
    const unserved = await hostSessionFixture().connect({ grants: { outboxRequested: true } });
    expect(unserved.of('registered')[0]).not.toHaveProperty('outbox');
    const unasked = await hostSessionFixture({ ports: { options: { outbox: hostCall() } } }).connect();
    expect(unasked.of('registered')[0]).not.toHaveProperty('outbox');
  });

  it('delivers an outbox answer only on the connection and generation that asked', async () => {
    const outbox = hostCall();
    const run = hostSessionFixture({ ports: { options: { outbox } } });
    const first = await run.connect({ grants: { outboxRequested: true } });
    await first.receive({ uplinkVersion: 2, type: 'outbox_request', requestId: 'r1', call: { action: 'poll' } });
    outbox.deferred!({ entries: [] });
    await new Promise(resolve => setImmediate(resolve));
    expect(first.of('outbox_response')).toEqual([expect.objectContaining({ requestId: 'r1', status: 200 })]);
    await first.receive({ uplinkVersion: 2, type: 'outbox_request', requestId: 'r2', call: { action: 'poll' } });
    const second = await run.connect({ grants: { outboxRequested: true } });
    outbox.deferred!({ entries: [] });
    await new Promise(resolve => setImmediate(resolve));
    expect(second.of('outbox_response')).toEqual([]);
    expect(first.of('outbox_response')).toHaveLength(1);
  });

  it('refuses diagnostic delivery while the connection is backed up, without asking the Controller', async () => {
    let deliver: ((entries: never[]) => Promise<{ status: number }>) | undefined;
    const diagnostics = { record: () => undefined, connect: (_hostId: string, send: typeof deliver) => { deliver = send; return () => undefined; } };
    const run = hostSessionFixture({ ports: { options: { diagnostics } as never } });
    const socket = await run.connect();
    socket.bufferedAmount = 1;
    const outcome = await Promise.race([deliver!([]), Promise.resolve('asked the Controller')]);
    expect(outcome).toEqual({ status: 503 });
    expect(socket.of('rpc_request')).toEqual([]);
  });

  it('keeps one device credential per installation when a device registers, and no other installation loses its key', async () => {
    const run = hostSessionFixture({ accountBacked: true, initialState: stateOf(deviceKey('key', 'machine'), deviceKey('stale', 'machine'), deviceKey('other', 'other-machine')) });
    await run.connect();
    expect([...run.state.keys.keys()].sort()).toEqual([hashOf('key'), hashOf('other')].sort());
  });

  it('issues a device credential after an invitation registers with a rotation, and registers the Host once the Controller saved it', async () => {
    const run = hostSessionFixture({ accountBacked: true, initialState: stateOf(invitation(), deviceKey('old', 'machine'), deviceKey('other', 'other-machine')) });
    const socket = await run.connect({ key: 'invite', rotation: true });
    expect(socket.of('registered')).toEqual([]);
    const issued = socket.of('credential_issued')[0]!;
    expect(issued.credential).toMatch(/^arc_device_/);
    expect(run.state.keys.has(hashOf(issued.credential))).toBe(true);
    await socket.receive({ uplinkVersion: 2, type: 'credential_saved' });
    expect(socket.of('registered')).toHaveLength(1);
    // The installation keeps only the new credential; another installation keeps its own.
    expect([...run.state.keys.keys()].sort()).toEqual([hashOf(issued.credential), hashOf('other')].sort());
  });

  it('registers a device that rotates at once and issues no credential before it asks', async () => {
    const run = hostSessionFixture({ accountBacked: true, initialState: stateOf(deviceKey('key', 'machine')) });
    const socket = await run.connect({ rotation: true });
    expect(socket.of('registered')).toHaveLength(1);
    expect(socket.of('credential_issued')).toEqual([]);
  });

  it('refuses a new device credential at 128 and issues one at 127', async () => {
    const filler = (count: number) => Array.from({ length: count }, (_, index) => deviceKey(`filler-${index}`, `filler-${index}`));
    const full = hostSessionFixture({ accountBacked: true, initialState: stateOf(deviceKey('key', 'machine'), ...filler(127)) });
    const crowded = await full.connect({ rotation: true });
    await expect(full.host()!.issueCredential!()).rejects.toMatchObject({ status: 429, code: 'capacity_exceeded' });
    expect(crowded.of('credential_issued')).toEqual([]);
    const room = hostSessionFixture({ accountBacked: true, initialState: stateOf(deviceKey('key', 'machine'), ...filler(126)) });
    const open = await room.connect({ rotation: true });
    await room.host()!.issueCredential!();
    expect(open.of('credential_issued')).toHaveLength(1);
  });

  it('does not open a browser stream the page may no longer use, and sends what it buffered once it may', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    let allowed = false;
    const stream = { timer: undefined, ready: false, buffered: ['frame'], authorized: () => allowed, socket: { readyState: 1, send: () => undefined, close: () => undefined } };
    run.host()!.streams.set('s1', stream as never);
    await socket.receive({ uplinkVersion: 2, type: 'stream_opened', streamId: 's1' });
    expect(stream.ready).toBe(false);
    expect(socket.of('stream_message')).toEqual([]);
    allowed = true;
    await socket.receive({ uplinkVersion: 2, type: 'stream_opened', streamId: 's1' });
    expect(stream.ready).toBe(true);
    expect(socket.of('stream_message')).toEqual([expect.objectContaining({ streamId: 's1', message: 'frame' })]);
  });

  it('closes with 1008 and the reason when a registration is no longer authorized, and not with a server failure', async () => {
    const recovery = { hostId: 'recovered', installationId: 'machine', revocationId: '00000000-0000-4000-8000-000000000001' };
    const run = hostSessionFixture({ initialState: stateOf([hashOf('key'), { expires: 1_000_000, installationId: 'machine', kind: 'device', recovery }]) });
    const socket = await run.connect();
    expect(socket.closes).toEqual([{ code: 1008, reason: expect.stringContaining('recovery invitation') }]);
    expect(run.state.hosts.size).toBe(0);
  });

  it('ignores a provider snapshot from a Host that did not advertise provider management, and takes one from a Host that did', async () => {
    const snapshot = { uplinkVersion: 2, type: 'provider_snapshot', providers: [{ providerId: 'claude', displayName: 'Claude' }] };
    const plain = hostSessionFixture();
    const refused = await plain.connect();
    await refused.receive(snapshot);
    expect(refused.closes.at(-1)).toEqual({ code: 1008, reason: 'Provider management was not advertised' });
    expect(plain.host()!.providers.map(provider => provider.providerId)).toEqual(['codex']);
    const managed = hostSessionFixture();
    const accepted = await managed.connect({ register: false });
    await accepted.receive({ ...registration(), providerManagement: true });
    await accepted.receive(snapshot);
    expect(accepted.closes).toEqual([]);
    expect(managed.host()!.providers.map(provider => provider.providerId)).toEqual(['claude']);
  });
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const uplink = (message: Record<string, unknown>) => ({ uplinkVersion: 2, ...message });
const firstHostId = '00000000-0000-4000-8000-000000000001';

/** A browser stream the Host holds open, as the broker registers it. */
function openStream(run: ReturnType<typeof hostSessionFixture>, config: { runtimeAgentId?: string; publicAgentId?: string; control?: ReturnType<typeof createStreamControl> } = {}) {
  const socket = new FakeSocket();
  run.host()!.streams.set('s1', { publicAgentId: config.publicAgentId ?? 'agent-1', runtimeAgentId: config.runtimeAgentId ?? 'agent-1', socket, ready: true, buffered: [], ...(config.control ? { control: config.control } : {}) });
  return socket;
}
const streamFrame = (message: unknown) => uplink({ type: 'stream_message', streamId: 's1', message: JSON.stringify(message) });

describe('host session registration with a journal deletion pending', () => {
  const pendingRun = (deleteOne: () => Promise<boolean>) => hostSessionFixture({
    heartbeat: { intervalMs: 600_000, timeoutMs: 10_000 },
    initialState: { keys: [[hashOf('key'), { expires: 1_000_000, installationId: 'machine', kind: 'device' }]], hosts: [], bindings: [], creations: [], journalDeletions: [firstHostId] },
    ports: { journals: {} as never, deletion: { revoked: () => undefined, drain: () => undefined, deleteOne } },
  });

  it('waits for the deletion of its own id for at most 5000 ms, then registers without journals and leaves the id pending', async () => {
    const run = pendingRun(() => new Promise(() => undefined));
    const socket = await run.connect({ grants: { journalRequested: 1 } });
    expect(run.host()!.id).toBe(firstHostId);
    run.clock.advance(4999);
    expect(socket.of('registered')).toEqual([]);
    run.clock.advance(1);
    expect(socket.of('registered')).toHaveLength(1);
    expect(socket.of('registered')[0]).not.toHaveProperty('journal');
    expect(run.host()!.journal).toBeUndefined();
    expect(run.state.journalDeletions).toEqual([firstHostId]);
    expect(run.host()!.ready).toBe(true);
  });

  it('registers with journals as soon as the deletion ends, before the deadline', async () => {
    const run = pendingRun(async () => { run.state.journalDeletions.length = 0; return true; });
    const socket = await run.connect({ grants: { journalRequested: 1 } });
    await flush();
    expect(socket.of('registered')).toEqual([expect.objectContaining({ journal: 1 })]);
    run.clock.advance(5000);
    expect(socket.of('registered')).toHaveLength(1);
  });
});

describe('host session registration deadline default', () => {
  it('closes a connection with no registration after 10 000 ms and not before', async () => {
    const run = hostSessionFixture({ heartbeat: { intervalMs: 600_000, timeoutMs: 10_000 } });
    const silent = await run.connect({ register: false });
    run.clock.advance(9999);
    expect(silent.closes).toEqual([]);
    run.clock.advance(1);
    expect(silent.closes).toEqual([{ code: 1008, reason: 'Registration deadline exceeded' }]);
  });
});

describe('host session messages from a Host that did not ask for what it sends', () => {
  it.each([
    ['session states', uplink({ type: 'session_states', full: true, states: [] }), 'Session states were not acknowledged'],
    ['a journal message', uplink({ type: 'journal_older_done', requestId: 'r1', sessionKey: 'codex:s1', olderAvailable: true }), 'Journals were not acknowledged'],
    ['an outbox request', uplink({ type: 'outbox_request', requestId: 'r1', call: { action: 'poll' } }), 'The outbox was not acknowledged'],
    ['a message only the Relay sends', uplink({ type: 'rpc_request', requestId: 'r1', method: 'GET', path: '/remote/catalog' }), 'Unexpected uplink message'],
  ])('closes with 1008 on %s', async (_name, message, reason) => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    await socket.receive(message);
    expect(socket.closes).toEqual([{ code: 1008, reason }]);
    expect(run.host()!.ready).toBe(false);
  });
});

describe('host session routing of messages after registration', () => {
  it('hands a preview snapshot to the previews of that Host', async () => {
    const update = vi.fn(async () => undefined);
    const run = hostSessionFixture({ ports: { previews: { disconnect: () => undefined, update } as never } });
    const socket = await run.connect();
    const snapshot = { epoch: 'e1', revision: 3, registrations: [] };
    await socket.receive(uplink({ type: 'preview_snapshot', snapshot }));
    expect(update).toHaveBeenCalledWith(run.host()!.id, snapshot);
    expect(socket.closes).toEqual([]);
  });

  it('takes session states into the Host record and tells the sharing hook, once the Host asked for them', async () => {
    const receive = vi.fn();
    const onSessionStates = vi.fn();
    const run = hostSessionFixture({ ports: { views: { receiveSessionStates: receive }, options: { onSessionStates } } });
    const socket = await run.connect({ grants: { statesRequested: 1 } });
    const calls = onSessionStates.mock.calls.length;
    const message = { full: true, states: [] };
    await socket.receive(uplink({ type: 'session_states', ...message }));
    expect(receive).toHaveBeenCalledWith(run.host()!.sessionStates, expect.objectContaining(message));
    expect(onSessionStates.mock.calls.length).toBe(calls + 1);
    expect(socket.closes).toEqual([]);
  });

  it('closes the browser stream the Controller closed, with its code and reason, and forgets it', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const browser = openStream(run);
    await socket.receive(uplink({ type: 'stream_close', streamId: 's1', code: 1000, reason: 'done' }));
    expect(browser.closes).toEqual([{ code: 1000, reason: 'done' }]);
    expect(run.host()!.streams.size).toBe(0);
  });

  it('answers a Team request on the connection that asked, with the Team broker\'s answer', async () => {
    const hostCall = vi.fn(async () => ({ ok: true }));
    const run = hostSessionFixture({ ports: { teams: { hostCall } as never } });
    const socket = await run.connect();
    const call = { action: 'poll' };
    await socket.receive(uplink({ type: 'team_request', requestId: 't1', call }));
    await flush();
    expect(hostCall).toHaveBeenCalledWith(run.host()!.id, call, expect.any(Function));
    expect(socket.of('team_response')).toEqual([expect.objectContaining({ requestId: 't1', status: 200, body: '{"ok":true}' })]);
  });
});

describe('host session request deadlines', () => {
  const diagnosticPath = '/remote/relay-diagnostics';
  it.each([
    ['a read', 'GET', '/remote/catalog', false, 30_000, 'host_read_timeout'],
    ['another method', 'POST', '/remote/session/rename', false, 30_000, 'host_timeout'],
    ['provider settings', 'POST', '/remote/provider-settings', false, 45_000, 'host_timeout'],
    ['a creation', 'POST', '/remote/create', false, 180_000, 'host_timeout'],
    ['a diagnostic request', 'POST', diagnosticPath, true, 5_000, 'host_timeout'],
  ] as const)('%s is cancelled and rejected 504 at its deadline, not a millisecond before', async (_name, method, path, diagnostic, deadlineMs, code) => {
    const run = hostSessionFixture({ heartbeat: { intervalMs: 600_000, timeoutMs: 10_000 } });
    const socket = await run.connect();
    let outcome: unknown;
    void run.session.rpc(run.host()!, method, path, undefined, undefined, diagnostic).catch(error => { outcome = error; });
    const requestId = socket.of('rpc_request')[0]!.requestId;
    run.clock.advance(deadlineMs - 1);
    await flush();
    expect(outcome).toBeUndefined();
    expect(socket.of('rpc_cancel')).toEqual([]);
    run.clock.advance(1);
    await flush();
    expect(outcome).toMatchObject({ status: 504, code });
    expect(socket.of('rpc_cancel')).toEqual([expect.objectContaining({ requestId })]);
    expect(run.host()!.pending.size).toBe(0);
  });
});

describe('host session browser streams through the Relay', () => {
  const owner: NativeSessionOwner = { kind: 'native_cli', generation: 'native-1' };

  it('forwards the Controller frames of a stream with a lease, and shows the lease after the Snapshot and after an ownership refusal', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const sent: ServerMessage[] = [];
    let browser!: FakeSocket;
    const control = createStreamControl({ agentId: 'agent-1', send: message => { browser.send(JSON.stringify(message)); sent.push(message); }, readNativeOwner: async () => owner });
    browser = openStream(run, { control });
    const snapshot = { type: 'agent_snapshot', payload: { id: 'agent-1' } };
    const refusal = { type: 'protocol_error', payload: { code: 'native_session_owned', message: 'A terminal holds the session.', recoverable: true } };
    await socket.receive(streamFrame(snapshot));
    expect(browser.sent).toEqual([snapshot, expect.objectContaining({ type: 'session_control', payload: expect.objectContaining({ agentId: 'agent-1', access: 'read_only', available: true }) })]);
    await socket.receive(streamFrame(refusal));
    await flush();
    expect(browser.sent.slice(2)).toEqual([refusal, expect.objectContaining({ type: 'session_control', payload: expect.objectContaining({ available: false, nativeOwner: owner }) })]);
    expect(browser.closes).toEqual([]);
  });

  it('sends a frame of a stream without a lease as it is, addressed with the public session id', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const browser = openStream(run, { runtimeAgentId: 'runtime-1', publicAgentId: 'public-1' });
    await socket.receive(streamFrame({ type: 'agent_update', payload: { id: 'runtime-1' } }));
    expect(browser.sent).toEqual([{ type: 'agent_update', payload: { id: 'public-1' } }]);
  });

  it('closes a slow browser stream 1013 above 16 MiB of buffered output, and keeps one at the bound', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const browser = openStream(run);
    browser.bufferedAmount = BROKER_MAX_FRAME_BYTES;
    await socket.receive(streamFrame({ type: 'agent_update', payload: { id: 'agent-1' } }));
    expect(browser.closes).toEqual([]);
    expect(browser.sent).toHaveLength(1);
    browser.bufferedAmount = BROKER_MAX_FRAME_BYTES + 1;
    await socket.receive(streamFrame({ type: 'agent_update', payload: { id: 'agent-1' } }));
    expect(browser.closes).toEqual([{ code: 1013, reason: 'Slow browser connection' }]);
    expect(browser.sent).toHaveLength(1);
  });

  it('closes a stream 1008 when a frame names another session than its own, and sends nothing of it', async () => {
    const run = hostSessionFixture();
    const socket = await run.connect();
    const browser = openStream(run, { runtimeAgentId: 'runtime-1', publicAgentId: 'public-1' });
    await socket.receive(streamFrame({ type: 'agent_update', payload: { id: 'another-session' } }));
    expect(browser.closes).toEqual([{ code: 1008, reason: 'Invalid Remote Host session identity' }]);
    expect(browser.sent).toEqual([]);
    expect(socket.closes).toEqual([]);
  });
});

describe('host session ending releases what the connection held', () => {
  it('closes the journal connection and the previews once, and clears the fields only a connection holds', async () => {
    const disconnect = vi.fn();
    const run = hostSessionFixture({ heartbeat: { intervalMs: 600_000, timeoutMs: 10_000 },
      ports: { journals: {} as never, previews: { disconnect, update: async () => undefined } as never } });
    const socket = await run.connect({ grants: { journalRequested: 1, statesRequested: 1, controlRequested: true } });
    const host = run.host()!;
    const closeJournal = vi.spyOn(host.journal!, 'close');
    expect(host).toMatchObject({ control: true, tunnelToken: expect.any(String), sessionStates: expect.any(Object) });
    socket.finishClose();
    socket.finishClose();
    expect(closeJournal).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledExactlyOnceWith(host.id);
    expect(host.journal).toBeUndefined();
    expect(host.sessionStates).toBeUndefined();
    expect(host.tunnelToken).toBeUndefined();
    expect(host.control).toBeUndefined();
    expect(host.socket).toBeUndefined();
  });
});

describe('host session capacity and the close codes of a failed message', () => {
  const stranger = (index: number) => ({ id: `host-${index}`, installationId: `installation-${index}`, name: `Host ${index}`, providers: [], legacyDsh: false, generation: 0, pending: new Map(), streams: new Map() });
  const crowd = (run: ReturnType<typeof hostSessionFixture>, count: number) => { for (let index = 0; index < count; index += 1) run.state.hosts.set(`host-${index}`, stranger(index) as never); };

  it('refuses the 129th Host with 429 and the close code 1013, and registers the 128th and a Host it already knows', async () => {
    const full = hostSessionFixture();
    crowd(full, 128);
    const refused = await full.connect();
    expect(refused.closes).toEqual([{ code: 1013, reason: 'Host capacity reached' }]);
    expect(refused.of('registered')).toEqual([]);
    expect(full.state.hosts.size).toBe(128);
    const room = hostSessionFixture();
    crowd(room, 127);
    expect(room.state.hosts.size).toBe(127);
    expect((await room.connect()).of('registered')).toHaveLength(1);
    expect(room.state.hosts.size).toBe(128);
    const known = hostSessionFixture();
    crowd(known, 127);
    await known.connect();
    expect((await known.connect()).of('registered')).toHaveLength(1);
    expect(known.state.hosts.size).toBe(128);
  });

  it.each([
    ['401', new BrokerError(401, 'device_revoked', 'Registration is not authorized'), 1008, 'Registration is not authorized'],
    ['429', new BrokerError(429, 'host_capacity', 'Host capacity reached'), 1013, 'Host capacity reached'],
    ['another status', new BrokerError(409, 'conflict', 'A conflict'), 1011, 'Host message could not be processed'],
    ['no status', new Error('boom'), 1011, 'Host message could not be processed'],
  ])('closes a message that failed with status: %s', async (_name, failure, code, reason) => {
    const run = hostSessionFixture({ ports: { previews: { disconnect: () => undefined, update: async () => { throw failure; } } as never } });
    const socket = await run.connect();
    await socket.receive(uplink({ type: 'preview_snapshot', snapshot: { epoch: 'e1', revision: 1, registrations: [] } }));
    expect(socket.closes).toEqual([{ code, reason }]);
  });
});

describe('host session saves records only through the state commit', () => {
  it('changes no live field of the credential or the Host when the save of a registration fails', async () => {
    let failing = true;
    const run = hostSessionFixture({ accountBacked: true, onStateChange: async () => { if (failing) throw new Error('Storage unavailable'); },
      initialState: { keys: [[hashOf('invite'), { expires: 1_000_000 }]], hosts: [], bindings: [], creations: [] } });
    const invitation = run.state.keys.get(hashOf('invite'))!;
    const socket = await run.connect({ key: 'invite' });
    expect(invitation).toEqual({ expires: 1_000_000 });
    expect(run.state.hosts.size).toBe(0);
    expect(run.state.keys.get(hashOf('invite'))).toBe(invitation);
    expect(socket.of('registered')).toEqual([]);
    expect(socket.closes.at(-1)?.code).toBe(1011);
    failing = false;
  });

  it('keeps the providers of a Host live record when the save of its provider snapshot fails', async () => {
    let failing = false;
    const run = hostSessionFixture({ onStateChange: async () => { if (failing) throw new Error('Storage unavailable'); } });
    const socket = await run.connect({ register: false });
    await socket.receive({ ...registration(), providerManagement: true });
    failing = true;
    await socket.receive(uplink({ type: 'provider_snapshot', providers: [{ providerId: 'claude', displayName: 'Claude' }] }));
    expect(run.host()!.providers.map(provider => provider.providerId)).toEqual(['codex']);
    expect(socket.closes.at(-1)?.code).toBe(1011);
  });
});
