import { describe, expect, it } from 'vitest';

import { hashOf, hostSessionFixture, registration } from './test-utils/fake-host-link.js';

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
