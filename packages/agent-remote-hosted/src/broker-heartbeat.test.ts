import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createHostBroker, type HostBrokerOptions } from './broker.js';
import type { BrokerScheduler, RelaySocket } from './transport.js';
import { createDiagnosticJournal } from './diagnostic-journal.js';

const closers: Array<() => void> = [];
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); });
afterEach(() => vi.useRealTimers());

class Clock implements BrokerScheduler {
  time = 10_000;
  nextId = 0;
  timers = new Map<number, { at: number; callback(): void }>();
  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown) { this.timers.delete(timer as number); }
  advance(ms: number) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.time = end;
  }
}

class Socket implements RelaySocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, any>> = [];
  closes: Array<{ code?: number; reason?: string }> = [];
  messages = new Set<(data: string, binary: boolean) => void | Promise<void>>();
  closeListeners = new Set<() => void>();
  errors = new Set<() => void>();
  sendFailure?: 'throw' | 'error';
  send(data: string) {
    if (this.sendFailure === 'throw') throw new Error('Transport write failed');
    this.sent.push(JSON.parse(data));
    if (this.sendFailure === 'error') for (const callback of this.errors) callback();
  }
  close(code?: number, reason?: string) { this.closes.push({ code, reason }); }
  finishClose() { this.readyState = 3; for (const callback of this.closeListeners) callback(); }
  onMessage(listener: (data: string, binary: boolean) => void | Promise<void>) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onClose(listener: () => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  onError(listener: () => void) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  async receive(message: unknown) { for (const callback of this.messages) await callback(JSON.stringify(message), false); }
}

async function fixture(options: Partial<HostBrokerOptions> = {}) {
  const clock = new Clock();
  const broker = createHostBroker({ origin: 'https://relay.example', scheduler: clock, now: () => clock.time,
    heartbeatIntervalMs: 30, heartbeatTimeoutMs: 10,
    initialState: { keys: [[createHash('sha256').update('key').digest('hex'), { expires: 1_000_000, installationId: 'machine', kind: 'device' }]],
      hosts: [], bindings: [], creations: [] }, ...options });
  closers.push(() => broker.close());
  async function connect(register = true, credentialRotation = false) {
    const upgrade = await broker.prepareUpgrade(new Request('https://relay.example/ws/remote-host', {
      headers: { authorization: 'Bearer key' },
    }));
    if (!upgrade || upgrade instanceof Response) throw new Error('Host upgrade rejected');
    const socket = new Socket(); upgrade.accept(socket);
    if (register) await socket.receive({ uplinkVersion: 2, type: 'register', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }], ...(credentialRotation ? { credentialRotation } : {}) });
    return socket;
  }
  async function hosts() { return (await (await broker.handleRequest(new Request('https://relay.example/v1/remote/hosts')))!.json()).hosts; }
  return { broker, clock, connect, hosts };
}

it('announces heartbeat deadlines on every registered Host', async () => {
  const b = await fixture(); const socket = await b.connect();
  expect(socket.sent[0]).toMatchObject({ type: 'registered', heartbeat: { intervalMs: 30, timeoutMs: 10 } });
}, 10_000);

it('marks a half-open Host offline and rejects pending RPCs before the socket close event', async () => {
  const b = await fixture(); const socket = await b.connect();
  const hostId = socket.sent[0]!.hostId;
  const request = b.broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/${hostId}/catalog?providerId=codex`));
  await vi.waitFor(() => expect(socket.sent.some(message => message.type === 'rpc_request')).toBe(true));
  b.clock.advance(30);
  const pending = socket.sent.find(message => message.type === 'heartbeat')!;
  expect(pending).toBeDefined();
  const rpc = socket.sent.find(message => message.type === 'rpc_request')!;
  expect(rpc).toBeDefined();
  await socket.receive({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: rpc.requestId });
  await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: 'unrelated', status: 200, body: '{}' });
  b.clock.advance(10);
  expect((await b.hosts())[0].online).toBe(false);
  expect(socket.readyState).toBe(1);
  expect(socket.closes).toEqual([{ code: 1012, reason: expect.any(String) }]);
  expect((await request)?.status).toBe(503);
  const count = socket.sent.length;
  b.clock.advance(100);
  expect(socket.sent).toHaveLength(count);
}, 10_000);

it('isolates replacement connections from old heartbeat callbacks and close events', async () => {
  const b = await fixture(); const old = await b.connect();
  b.clock.advance(30);
  const callbacks = [...b.clock.timers.values()].map(timer => timer.callback);
  const replacement = await b.connect();
  for (const callback of callbacks) callback();
  expect(b.clock.timers.size).toBe(2);
  old.finishClose();
  expect((await b.hosts())[0].online).toBe(true);
  expect(replacement.closes).toHaveLength(0);
  b.clock.advance(30);
  expect(replacement.sent.filter(message => message.type === 'heartbeat')).toHaveLength(1);
  expect(old.sent.filter(message => message.type === 'heartbeat')).toHaveLength(1);
}, 10_000);

it.each(['throw', 'error'] as const)('retires registration when the socket reports a synchronous send %s', async failure => {
  const b = await fixture(); const socket = await b.connect(false);
  socket.sendFailure = failure;
  await socket.receive({ uplinkVersion: 2, type: 'register', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  expect((await b.hosts())[0].online).toBe(false);
  expect(b.clock.timers.size).toBe(0);
  expect(socket.closes.at(-1)?.code).toBe(1011);
}, 10_000);

it.each(['close', 'error', 'disconnect', 'shutdown'] as const)('clears heartbeat timers on %s', async action => {
  const b = await fixture(); const socket = await b.connect();
  b.clock.advance(30);
  if (action === 'close') socket.finishClose();
  if (action === 'error') for (const callback of socket.errors) callback();
  if (action === 'disconnect') b.broker.disconnect();
  if (action === 'shutdown') b.broker.close();
  expect(b.clock.timers.size).toBe(0);
  const count = socket.sent.length, closeCount = socket.closes.length;
  b.clock.advance(100);
  expect(socket.sent).toHaveLength(count);
  expect(socket.closes).toHaveLength(closeCount);
  if (action !== 'shutdown') expect((await b.hosts())[0].online).toBe(false);
}, 10_000);

it('starts after registration and keeps heartbeat send cadence independent of acknowledgement latency', async () => {
  const b = await fixture();
  const socket = await b.connect(false);
  b.clock.advance(100);
  expect(socket.sent).toHaveLength(0);
  await socket.receive({ uplinkVersion: 2, type: 'register', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  b.clock.advance(30);
  const first = socket.sent.at(-1)!;
  expect(first).toMatchObject({ type: 'heartbeat', nonce: expect.any(String) });
  b.clock.advance(5);
  await socket.receive({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: first.nonce });
  b.clock.advance(25);
  expect(socket.sent.at(-1)).toMatchObject({ type: 'heartbeat', nonce: expect.any(String) });
  expect(socket.sent.at(-1)!.nonce).not.toBe(first.nonce);
  expect(socket.closes).toHaveLength(0);
}, 10_000);

it('requires acknowledgement of the current heartbeat even after earlier successful replies', async () => {
  const b = await fixture(); const socket = await b.connect();
  b.clock.advance(30);
  const previous = socket.sent.at(-1)!.nonce;
  await socket.receive({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: previous });
  b.clock.advance(30);
  await socket.receive({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: previous });
  b.clock.advance(10);
  expect((await b.hosts())[0].online).toBe(false);
  expect(socket.closes.at(-1)?.code).toBe(1012);
}, 10_000);

it('starts after enrollment is saved and preserves the schedule across device credential rotation', async () => {
  const b = await fixture({ durable: true, initialState: {
    keys: [[createHash('sha256').update('key').digest('hex'), { expires: 1_000_000, requiresRotation: true }]],
    hosts: [], bindings: [], creations: [],
  } });
  const socket = await b.connect(true, true);
  expect(socket.sent.map(message => message.type)).toEqual(['credential_issued']);
  b.clock.advance(100);
  expect(socket.sent).toHaveLength(1);
  await socket.receive({ uplinkVersion: 2, type: 'credential_saved' });
  const registered = socket.sent.at(-1)!;
  expect(registered).toMatchObject({ type: 'registered', heartbeat: { intervalMs: 30, timeoutMs: 10 } });
  b.clock.advance(25);
  const rotate = await b.broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/${registered.hostId}/rotate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  expect(rotate?.status).toBe(200);
  await socket.receive({ uplinkVersion: 2, type: 'credential_saved' });
  expect(socket.sent.at(-1)).toEqual(registered);
  b.clock.advance(5);
  const heartbeat = socket.sent.at(-1)!;
  expect(heartbeat.type).toBe('heartbeat');
  await socket.receive({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: heartbeat.nonce });
  b.clock.advance(30);
  expect(socket.sent.filter(message => message.type === 'heartbeat')).toHaveLength(2);
  expect((await b.hosts())[0].online).toBe(true);
  expect(socket.closes).toHaveLength(0);
}, 10_000);

it('clears outstanding heartbeats when durable storage fails before a close event', async () => {
  let fail = false;
  const b = await fixture({ onStateChange: async () => { if (fail) throw new Error('Storage unavailable'); } });
  const socket = await b.connect(); b.clock.advance(30);
  fail = true;
  const response = await b.broker.handleRequest(new Request('https://relay.example/v1/remote/pairings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  expect(response?.status).toBe(503);
  expect(socket.closes.at(-1)?.code).toBe(1011);
  expect(b.clock.timers.size).toBe(0);
}, 10_000);

it('clears outstanding heartbeats when the device is revoked', async () => {
  const b = await fixture({ durable: true }); const socket = await b.connect(); b.clock.advance(30);
  const response = await b.broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/${socket.sent[0]!.hostId}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  expect(response?.status).toBe(200);
  expect(socket.closes.at(-1)?.code).toBe(1008);
  expect(b.clock.timers.size).toBe(0);
  expect(await b.hosts()).toEqual([]);
}, 10_000);

it('retires an expired device before waiting for its pending heartbeat deadline', async () => {
  const b = await fixture({ initialState: {
    keys: [[createHash('sha256').update('key').digest('hex'), { expires: 10_035, installationId: 'machine', kind: 'device' }]],
    hosts: [], bindings: [], creations: [],
  } });
  const socket = await b.connect(); b.clock.advance(35);
  expect(socket.closes.at(-1)?.code).toBe(1008);
  expect(b.clock.timers.size).toBe(0);
  expect((await b.hosts())[0].online).toBe(false);
}, 10_000);

it('closes virtual browser streams and clears their opening deadline when the Host heartbeat expires', async () => {
  const b = await fixture({ initialState: {
    keys: [[createHash('sha256').update('key').digest('hex'), { expires: 1_000_000, installationId: 'machine', kind: 'device' }]],
    hosts: [{ id: 'host', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
    bindings: [{ hostId: 'host', providerId: 'codex', nativeSessionId: 'native', agentId: 'agent' }], creations: [],
  } });
  const socket = await b.connect();
  const upgrading = b.broker.prepareUpgrade(new Request('https://relay.example/v1/sessions/agent/events', { headers: { origin: 'https://relay.example' } }));
  await vi.waitFor(() => expect(socket.sent.some(message => message.type === 'rpc_request')).toBe(true));
  const attach = socket.sent.find(message => message.type === 'rpc_request')!;
  await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: attach.requestId, status: 200, body: '{"agentId":"agent","nativeSessionId":"native"}' });
  const upgraded = await upgrading;
  if (!upgraded || upgraded instanceof Response) throw new Error('Browser upgrade rejected');
  const browser = new Socket(); upgraded.accept(browser);
  expect(socket.sent.at(-1)).toMatchObject({ type: 'stream_open' });
  b.clock.advance(40);
  expect(browser.closes).toEqual([{ code: 1012, reason: 'Remote Host disconnected' }]);
  expect(b.clock.timers.size).toBe(0);
  b.clock.advance(30_000);
  expect(browser.closes).toHaveLength(1);
}, 10_000);

it('retains exact server heartbeat cause and startup/connection identity for later Host delivery', async()=>{
 const {createDiagnosticJournal}=await import('./diagnostic-journal.js');
 let saved:import('./relay-diagnostics.js').RelayDiagnostic[]=[];
 const journal=createDiagnosticJournal({storage:{save:async events=>{saved=structuredClone(events);}}});
 const b=await fixture({diagnostics:journal});const socket=await b.connect();
 b.clock.advance(40);await journal.flush();
 expect(saved).toEqual(expect.arrayContaining([
   expect.objectContaining({event:'host_registered',hostId:socket.sent[0]!.hostId}),
   expect.objectContaining({event:'host_disconnected',reason:'heartbeat_timeout',closeCode:1012}),
 ]));
 expect(saved.filter(e=>e.event==='host_disconnected')).toHaveLength(1);
 socket.finishClose();await journal.flush();expect(saved.filter(e=>e.event==='host_disconnected')).toHaveLength(1);
 expect(saved[0]?.connectionId).toBe(saved[1]?.connectionId);await journal.close();
},10000);

it('defers diagnostic capability probing while the Host has buffered business traffic', async () => {
  vi.useFakeTimers(); const journal = createDiagnosticJournal(); const b = await fixture({ diagnostics: journal });
  try {
    const socket = await b.connect(); socket.bufferedAmount = 1;
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent.filter(message => message.type === 'rpc_request')).toEqual([]);
    b.clock.advance(30); expect(socket.sent.at(-1)?.type).toBe('heartbeat'); expect(socket.closes).toEqual([]);
    socket.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(30000);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'rpc_request', path: '/remote/controller-update' });
  } finally { await journal.close(); }
});

it('rechecks buffered traffic after capability probing before sending the diagnostic batch', async () => {
  vi.useFakeTimers(); const journal = createDiagnosticJournal(); const b = await fixture({ diagnostics: journal });
  try {
    const socket = await b.connect(); await vi.advanceTimersByTimeAsync(1000);
    const probe = socket.sent.at(-1)!; expect(probe.path).toBe('/remote/controller-update');
    socket.bufferedAmount = 1;
    await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: probe.requestId, status: 200, body: '{"diagnosticDelivery":1}' });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.filter(message => message.type === 'rpc_request')).toHaveLength(1);
    socket.bufferedAmount = 0; await vi.advanceTimersByTimeAsync(30000);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'rpc_request', path: '/remote/diagnostics/relay' });
  } finally { await journal.close(); }
});

it.each(['before', 'after'] as const)('defers diagnostics when business requests accumulate %s the capability probe', async timing => {
  vi.useFakeTimers(); const journal = createDiagnosticJournal(); const b = await fixture({ diagnostics: journal });
  try {
    const socket = await b.connect(); const hostId = socket.sent[0]!.hostId;
    if (timing === 'after') await vi.advanceTimersByTimeAsync(1000);
    const probe = socket.sent.find(message => message.path === '/remote/controller-update');
    const requests = Array.from({ length: 17 }, () => b.broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/${hostId}/catalog?providerId=codex`)));
    await vi.waitFor(() => expect(socket.sent.filter(message => message.path?.startsWith('/remote/catalog'))).toHaveLength(17));
    if (probe) await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: probe.requestId, status: 200, body: '{"diagnosticDelivery":1}' });
    await vi.advanceTimersByTimeAsync(timing === 'before' ? 1000 : 0);
    expect(socket.sent.filter(message => message.path === '/remote/controller-update')).toHaveLength(timing === 'before' ? 0 : 1);
    expect(socket.sent.some(message => message.path === '/remote/diagnostics/relay')).toBe(false);
    for (const request of socket.sent.filter(message => message.path?.startsWith('/remote/catalog'))) {
      await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: request.requestId, status: 200, body: '{"sessions":[]}' });
    }
    await Promise.all(requests);
  } finally { await journal.close(); }
});

it('permits diagnostics on adapters that cannot report their buffered byte count', async () => {
  vi.useFakeTimers(); const journal = createDiagnosticJournal(); const b = await fixture({ diagnostics: journal });
  try {
    const socket = await b.connect(); Object.defineProperty(socket, 'bufferedAmount', { value: undefined });
    await vi.advanceTimersByTimeAsync(1000);
    const probe = socket.sent.at(-1)!; expect(probe.path).toBe('/remote/controller-update');
    await socket.receive({ uplinkVersion: 2, type: 'rpc_response', requestId: probe.requestId, status: 200, body: '{"diagnosticDelivery":1}' });
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'rpc_request', path: '/remote/diagnostics/relay' });
  } finally { await journal.close(); }
});
