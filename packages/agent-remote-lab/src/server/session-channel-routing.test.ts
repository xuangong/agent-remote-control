// @vitest-environment node
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { createProtocolValidationServer } from '../server.js';
import { createRecordedLabProvider } from './recorded.js';

const origin = 'http://127.0.0.1:6175';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function inbox(socket: WebSocket) {
  const queued: any[] = [];
  const waiters: Array<{ match: (value: any) => boolean; resolve(value: any): void }> = [];
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex(item => item.match(value));
    if (index >= 0) waiters.splice(index, 1)[0]!.resolve(value); else queued.push(value);
  });
  return (match: (value: any) => boolean) => {
    const index = queued.findIndex(match);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Channel message deadline')), 5000);
      waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lab-session-channel-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = createProtocolValidationServer({
    providers: [createRecordedLabProvider().provider], labOrigin: origin,
    imageDirectory: join(directory, 'images'), resourceDirectory: join(directory, 'resources'),
    teamResourceDirectory: join(directory, 'team'), successionStateDirectory: join(directory, 'successions'),
  });
  cleanup.push(() => server.close());
  const { url } = await server.http.listen(0, '127.0.0.1');
  await server.relay.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: {
    requestId: 'local-request', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'local-agent', providerId: 'recorded', config: { sessionId: 'local-native' },
  } });
  // Local per-session streams the Lab opens for channel subscriptions.
  const localStreams = new Map<string, Duplex>();
  server.http.server.on('upgrade', (request, socket) => {
    const match = /^\/v1\/sessions\/([^/]+)\/events$/.exec(request.url ?? '');
    if (match) localStreams.set(decodeURIComponent(match[1]!), socket);
  });

  // A paired Host whose sessions live in its own Relay and arrive through the production uplink.
  const remote = createAgentRemoteRelay({ providers: [createRecordedLabProvider().provider] });
  cleanup.push(() => remote.close());
  const pair = await (await fetch(url + '/v1/remote/pairings', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).json();
  const leases = { acquired: 0, released: 0 };
  const uplink = createRemoteHostUplinkClient({
    relay: remote, url: url.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: pair.key,
    installationId: 'channel-host', name: 'Channel Host',
    resolveSession: id => { try { return remote.requireAgent(id); } catch { return undefined; } },
    async acquireSession(id) {
      let agent; try { agent = remote.requireAgent(id); } catch { return undefined; }
      leases.acquired++;
      return { agent, release() { leases.released++; } };
    },
    async control(request) {
      const body = JSON.parse(request.body ?? '{}');
      try { remote.requireAgent(request.sessionId!); } catch {
        await remote.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: {
          requestId: request.sessionId!, operationId: '00000000-0000-4000-8000-000000000002', agentId: request.sessionId!, providerId: 'recorded', config: { sessionId: body.nativeSessionId },
        } });
      }
      return { status: 200, body: JSON.stringify({ nativeSessionId: body.nativeSessionId }) };
    },
  });
  cleanup.push(() => uplink.close());
  const { hostId } = await uplink.ready;
  const attached = await (await fetch(url + `/v1/remote/hosts/${hostId}/attach`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ nativeSessionId: 'remote-native' }) })).json();
  const remoteAgent = attached.agentId as string;
  expect(remoteAgent).toBeTruthy();

  const connect = async (mode = 'session', headers: Record<string, string> = { origin }) => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + `/v1/session-channel?observation=${mode}`, { headers });
    cleanup.push(() => socket.terminate());
    const next = inbox(socket);
    await once(socket, 'open'); await next(value => value.type === 'ready');
    const send = (value: object) => socket.send(JSON.stringify({ protocolVersion: '1.8.0', ...value }));
    const subscribe = (subscriptionId: number, agentId: string) => send({ type: 'subscribe', subscriptionId, agentId, message: { protocolVersion: '1.8.0', type: 'negotiate' } });
    return { socket, next, send, subscribe };
  };
  return { url, connect, remoteAgent, uplink, leases, localStreams };
}

it('routes local and remote-Host subscriptions on one channel to their own backends', async () => {
  const f = await fixture(); const c = await f.connect();
  c.subscribe(1, 'local-agent'); c.subscribe(2, f.remoteAgent);
  expect((await c.next(v => v.subscriptionId === 1 && v.message?.type === 'agent_snapshot')).message.payload).toMatchObject({ id: 'local-agent' });
  expect((await c.next(v => v.subscriptionId === 2 && v.message?.type === 'agent_snapshot')).message.payload).toMatchObject({ id: f.remoteAgent });
  // Only the local subscription used the local Relay; the remote one went through the Host uplink.
  expect([...f.localStreams.keys()]).toEqual(['local-agent']);
  expect(f.leases.acquired).toBe(1);
  expect(c.socket.readyState).toBe(WebSocket.OPEN);
}, 20_000);

it('reports failures per subscription without closing siblings', async () => {
  const f = await fixture(); const c = await f.connect();
  c.subscribe(1, 'local-agent');
  await c.next(v => v.subscriptionId === 1 && v.message?.type === 'agent_snapshot');
  c.subscribe(2, 'missing-agent');
  expect(await c.next(v => v.subscriptionId === 2 && v.type === 'closed')).toMatchObject({ code: 1011 });
  // A remote-Host subscription whose Host went offline is refused with the broker's reason.
  await f.uplink.close();
  c.subscribe(3, f.remoteAgent);
  const refused = await c.next(v => v.subscriptionId === 3 && v.type === 'closed');
  expect([1008, 1013]).toContain(refused.code);
  expect(refused.reason).not.toBe('');
  c.send({ type: 'ping' }); await c.next(v => v.type === 'pong');
  // The local sibling still carries traffic after both failures.
  c.send({ type: 'message', subscriptionId: 1, message: { protocolVersion: '1.8.0', type: 'negotiate' } });
  await c.next(v => v.subscriptionId === 1 && v.message?.type === 'negotiated');
  expect(c.socket.readyState).toBe(WebSocket.OPEN);
}, 20_000);

it('closes the backend stream of each unsubscribed subscription', async () => {
  const f = await fixture(); const c = await f.connect();
  c.subscribe(1, 'local-agent'); c.subscribe(2, f.remoteAgent);
  await c.next(v => v.subscriptionId === 1 && v.message?.type === 'agent_snapshot');
  await c.next(v => v.subscriptionId === 2 && v.message?.type === 'agent_snapshot');
  const local = f.localStreams.get('local-agent')!;
  const localClosed = once(local, 'close');
  c.send({ type: 'unsubscribe', subscriptionId: 1 });
  c.send({ type: 'unsubscribe', subscriptionId: 2 });
  await localClosed;
  await expect.poll(() => f.leases.released, { timeout: 5000 }).toBe(1);
  // Unsubscribed IDs are never reused; a new subscription opens fresh backend streams.
  c.subscribe(3, f.remoteAgent);
  await c.next(v => v.subscriptionId === 3 && v.message?.type === 'agent_snapshot');
  expect(f.leases.acquired).toBe(2);
}, 20_000);

it('refuses channels from other browser origins', async () => {
  const f = await fixture();
  const socket = new WebSocket(f.url.replace('http:', 'ws:') + '/v1/session-channel?observation=session', { headers: { origin: 'https://untrusted.example' } });
  socket.on('error', () => undefined);
  const [, response] = await once(socket, 'unexpected-response') as [unknown, { statusCode: number; resume(): void }];
  response.resume(); socket.terminate();
  expect(response.statusCode).toBe(401);
}, 20_000);
