// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createDiagnosticJournal } from '@orchardworks/agent-remote-hosted/diagnostic-journal';
import { parseRelayDiagnosticBatch, type RelayDiagnostic } from '@orchardworks/agent-remote-hosted/relay-diagnostics';
import { decodeRemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';
import { createRelayDiagnosticSink } from '../../../agent-host/src/relay-diagnostics.js';
import { createRemoteHostBroker, type RemoteHostBrokerOptions } from './remote-host-broker.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup(options: Partial<RemoteHostBrokerOptions> = {}, initial: RelayDiagnostic[] = []) {
  let saved = initial;
  const journal = createDiagnosticJournal({ storage: { initial, async save(entries) { saved = entries; } } });
  const broker = createRemoteHostBroker({ origin: 'http://127.0.0.1:6175', diagnostics: journal, rpcTimeoutMs: 80, ...options });
  const server = createServer((_, response) => { response.statusCode = 404; response.end(); });
  broker.install(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    await broker.close(); await journal.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  cleanup.push(close);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  return { url, post, journal, broker, close, saved: () => saved };
}

async function connect(url: string, key: string, installationId: string, supported = true, append?: (entries: RelayDiagnostic[]) => Promise<void>, capabilityStatus = 200, diagnosticVersion = 1) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws/remote-host', { headers: { authorization: `Bearer ${key}` } });
  cleanup.push(async () => { socket.terminate(); });
  const batches: RelayDiagnostic[][] = [], calls: string[] = [], errors: unknown[] = [];
  socket.on('message', raw => {
    void (async () => {
      const decoded = decodeRemoteHostUplinkMessage(raw.toString());
      if (decoded.status !== 'ok') throw new Error('Invalid uplink envelope');
      const message = decoded.value;
      if (message.type === 'heartbeat') socket.send(JSON.stringify({ uplinkVersion: 2, type: 'heartbeat_ack', nonce: message.nonce }));
      if (message.type !== 'rpc_request') return;
      calls.push(message.path);
      let status = 200, body = '{}';
      if (message.path === '/remote/controller-update') {
        status = capabilityStatus;
        body = JSON.stringify(supported ? { diagnosticDelivery: diagnosticVersion } : {});
      }
      else if (message.path === '/remote/diagnostics/relay') {
        const entries = parseRelayDiagnosticBatch(JSON.parse(message.body!));
        if (!entries) throw new Error('Invalid diagnostic batch');
        await append?.(entries); batches.push(entries); status = 204;
      } else return; // Leave business requests unanswered to exercise timeout evidence.
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status, body }));
    })().catch(error => errors.push(error));
  });
  await once(socket, 'open');
  const registered = once(socket, 'message');
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId, name: 'Diagnostic test Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  const [raw] = await registered;
  return { socket, id: JSON.parse(raw.toString()).hostId as string, batches, calls, errors };
}

it('replays original disconnect evidence into the correct Host file after reconnect and Server restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-diagnostic-transport-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const sink = createRelayDiagnosticSink({ path: join(directory, 'relay-diagnostics.log') });
  const first = await setup();
  const pair = await (await first.post('/v1/remote/pairings')).json();
  const native = await connect(first.url, pair.key, 'diagnostic-installation', true, sink.append);
  await expect.poll(() => native.batches.flat().some(entry => entry.event === 'host_registered'), { timeout: 4000 }).toBe(true);
  native.socket.close(); await once(native.socket, 'close');
  await expect.poll(() => first.saved().find(entry => entry.event === 'host_disconnected'), { timeout: 2000 }).toBeTruthy();
  const original = first.saved().find(entry => entry.event === 'host_disconnected')!;
  const state = first.broker.snapshot();
  await first.close();
  const second = await setup({ initialState: state }, first.saved());
  const otherKey = await (await second.post('/v1/remote/pairings')).json();
  const other = await connect(second.url, otherKey.key, 'different-installation');
  const resumed = await connect(second.url, pair.key, 'diagnostic-installation', true, sink.append);
  expect(resumed.id).toBe(native.id);
  await expect.poll(() => resumed.batches.flat().some(entry => entry.id === original.id), { timeout: 4000 }).toBe(true);
  await expect.poll(() => other.batches.length, { timeout: 4000 }).toBeGreaterThan(0);
  expect(other.batches.flat().every(entry => entry.hostId === other.id)).toBe(true);
  expect(resumed.batches.flat().every(entry => entry.hostId === native.id)).toBe(true);
  const records = (await readFile(join(directory, 'relay-diagnostics.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records.find(entry => entry.id === original.id)).toEqual(original);
  expect(records.some(entry => entry.event === 'relay_started' && entry.relayInstanceId !== original.relayInstanceId)).toBe(true);
  expect([...native.errors, ...resumed.errors, ...other.errors]).toEqual([]);
}, 15_000);

it('does not send the new RPC to a legacy Controller and retains its evidence without disrupting catalog requests', async () => {
  const f = await setup();
  const pair = await (await f.post('/v1/remote/pairings')).json();
  const native = await connect(f.url, pair.key, 'legacy-installation', false);
  await expect.poll(() => native.calls, { timeout: 4000 }).toContain('/remote/controller-update');
  const response = await fetch(f.url + `/v1/remote/hosts/${native.id}/catalog?providerId=codex`, { signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(504);
  await f.journal.flush();
  expect(f.saved().some(entry => entry.event === 'rpc_timeout')).toBe(true);
  expect(native.calls.filter(path => path === '/remote/controller-update')).toHaveLength(1);
  expect(native.calls).not.toContain('/remote/diagnostics/relay');
  expect(native.socket.readyState).toBe(WebSocket.OPEN);
  expect(native.errors).toEqual([]);
}, 10_000);

it('discovers the independent diagnostic capability even when updater status fails', async () => {
  const f = await setup();
  const pair = await (await f.post('/v1/remote/pairings')).json();
  const native = await connect(f.url, pair.key, 'updater-unavailable', true, undefined, 409);
  await expect.poll(() => native.batches.flat().some(entry => entry.event === 'host_registered'), { timeout: 4000 }).toBe(true);
  expect(native.errors).toEqual([]);
}, 10_000);

it('delivers bounded business timeout metadata without request payloads or query strings', async () => {
  const f = await setup();
  const pair = await (await f.post('/v1/remote/pairings')).json();
  const native = await connect(f.url, pair.key, 'timeout-installation');
  const response = await f.post(`/v1/remote/hosts/${native.id}/create`, { providerId: 'codex', operationId: '00000000-0000-4000-8000-000000000009', cwd: '/private/secret-workspace' });
  expect(response.status).toBe(504);
  await expect.poll(() => native.batches.flat().find(entry => entry.event === 'rpc_timeout'), { timeout: 4000 }).toMatchObject({ operation: 'create', hostId: native.id });
  const serialized = JSON.stringify(native.batches);
  expect(serialized).not.toContain('secret-workspace');
  expect(serialized).not.toContain(pair.key);
  expect(native.batches.every(batch => batch.length <= 32)).toBe(true);
  expect(native.errors).toEqual([]);
}, 10_000);

it('records browser stream opening, readiness and closure without conversation content', async () => {
  const f = await setup({ rpcTimeoutMs: 2000 });
  const pair = await (await f.post('/v1/remote/pairings')).json();
  const native = await connect(f.url, pair.key, 'stream-installation');
  native.socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'rpc_request' && message.path === '/remote/attach') {
      native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'rpc_response', requestId: message.requestId, status: 200,
        body: JSON.stringify({ agentId: message.sessionId, nativeSessionId: 'native-stream' }) }));
    } else if (message.type === 'stream_open') {
      native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_opened', streamId: message.streamId }));
      native.socket.send(JSON.stringify({ uplinkVersion: 2, type: 'stream_message', streamId: message.streamId, message: 'private conversation content' }));
    }
  });
  const attached = await (await f.post(`/v1/remote/hosts/${native.id}/attach`, { providerId: 'codex', nativeSessionId: 'native-stream' })).json();
  const browser = new WebSocket(f.url.replace('http:', 'ws:') + `/v1/sessions/${attached.agentId}/events`, { headers: { origin: 'http://127.0.0.1:6175' } });
  cleanup.push(async () => { browser.terminate(); });
  await once(browser, 'message');
  browser.close(); await once(browser, 'close');
  await expect.poll(() => native.batches.flat().filter(entry => entry.event.startsWith('stream_')).map(entry => entry.event), { timeout: 4000 })
    .toEqual(['stream_opening', 'stream_ready', 'stream_closed']);
  const streamEvents = native.batches.flat().filter(entry => entry.event.startsWith('stream_'));
  expect(new Set(streamEvents.map(entry => entry.streamId)).size).toBe(1);
  expect(JSON.stringify(native.batches)).not.toContain('private conversation content');
  expect(native.errors).toEqual([]);
}, 10_000);

it.each(['close', 'terminate'] as const)('preserves the native close code after %s through reconnect into the Host log', async operation => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-close-diagnostic-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'relay-diagnostics.log');
  const sink = createRelayDiagnosticSink({ path });
  const f = await setup();
  const pair = await (await f.post('/v1/remote/pairings')).json();
  const native = await connect(f.url, pair.key, 'close-installation', true, sink.append, 200, 3);
  const closed = once(native.socket, 'close');
  if (operation === 'close') native.socket.close(1000, 'private-close-reason');
  else native.socket.terminate();
  await closed;
  await expect.poll(() => f.saved().find(entry => entry.event === 'host_disconnected')).toMatchObject({
    reason: 'socket_closed', closeCode: operation === 'close' ? 1000 : 1006, heartbeatAgeMs: expect.any(Number),
  });
  const resumed = await connect(f.url, pair.key, 'close-installation', true, sink.append, 200, 3);
  await expect.poll(() => resumed.batches.flat().some(entry => entry.event === 'host_disconnected'), { timeout: 4000 }).toBe(true);
  const log = await readFile(path, 'utf8');
  expect(log).not.toContain('private-close-reason');
  const entry = log.trim().split('\n').map(line => JSON.parse(line)).find(entry => entry.event === 'host_disconnected');
  expect(entry.closeCode).toBe(operation === 'close' ? 1000 : 1006);
  expect(entry.wasClean).toBeUndefined(); // Node ws does not expose this browser CloseEvent field.
  expect([...native.errors, ...resumed.errors]).toEqual([]);
}, 10000);
