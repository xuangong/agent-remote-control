// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-client';
import { memorySocketServer, type MemoryServerSocket } from '@orchardworks/agent-client/testing';
import { decodeSessionChannelClientMessage } from '@orchardworks/agent-remote-protocol';

/**
 * S3, a new client against the Relay of the previous release. Cloudflare propagates the Worker and the Durable Object independently, so
 * for a few minutes after a deploy a page runs the new bundle while the Relay object still runs the release before. The Relay of
 * `fixtures/old-relay-dc1d9bf8.json` is played from what that release answered when it was run (provenance in the file): its `ready`
 * frame, and its decoder, which refuses a `send_message` carrying a field it does not know and then closes the whole channel with 1008,
 * every subscription of the page with it. The client must stay usable on that channel, and must not ask what that Relay cannot decode.
 */
interface Recorded { name: string; frame: any; answer: { status: string; channel?: { closeCode: number; closeReason: string } } }
const recording = JSON.parse(readFileSync(new URL('./fixtures/old-relay-dc1d9bf8.json', import.meta.url), 'utf8')) as { ready: object; decoded: Recorded[]; refused: Recorded[] };
const version = '1.8.0';
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const immediate = globalThis.setImmediate;
const settled = () => new Promise<void>(resolve => immediate(resolve));

/** The fields of a send the old Relay does not know: what its recorded refusal has beyond what its recorded acceptance has. */
const unknownToOldRelay = Object.keys(recording.refused[0]!.frame.message.payload).filter(key => !(key in recording.decoded[0]!.frame.message.payload));

const history = (requestId: string, agentId = 'a', direction = 'tail') => ({ protocolVersion: version, type: 'timeline_page', payload: {
  requestId, agentId, direction, epoch: 'epoch', reset: false, staleCursor: false, gap: false, error: null,
  window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [] } });
const snapshot = (id: string) => ({ protocolVersion: version, type: 'agent_snapshot', payload: {
  id, providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
  status: 'idle', activeTurn: null, pendingInteractions: [], runtimeInfo: { providerId: 'test', sessionId: id, status: 'idle' },
  capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false, interactions: { question: false, planApproval: false, toolApproval: false } } } });

/** A Relay object that answers the handshake of a session and acts on a frame as the recorded release did. `ready` is the frame it opens a channel with. */
function relay(ready: object) {
  const memory = memorySocketServer();
  const closedByRelay: MemoryServerSocket[] = [];
  memory.onConnection((socket) => {
    socket.send(JSON.stringify(ready));
    socket.on('message', (data: string) => {
      const frame = JSON.parse(data);
      if (ready === recording.ready && frame.type === 'message' && unknownToOldRelay.some(key => key in (frame.message.payload ?? {}))) {
        closedByRelay.push(socket); socket.close(recording.refused[0]!.answer.channel!.closeCode, recording.refused[0]!.answer.channel!.closeReason); return;
      }
      if (frame.type === 'ping') { socket.send(JSON.stringify({ protocolVersion: version, type: 'pong' })); return; }
      const reply = (message: object) => socket.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: frame.subscriptionId, message }));
      if (frame.type === 'subscribe') { reply({ protocolVersion: version, type: 'negotiated' }); reply(snapshot(frame.agentId)); }
      else if (frame.message?.type === 'timeline_subscription') reply({ protocolVersion: version, type: 'timeline_subscribed', payload: { requestId: frame.message.payload.requestId, agentIds: [frame.message.payload.agentIds?.[0] ?? 'a'] } });
      else if (frame.message?.type === 'send_message' && frame.message.payload.settle) reply({ protocolVersion: version, type: 'command_acknowledged', payload: { requestId: frame.message.payload.requestId, agentId: frame.message.payload.agentId, command: 'send_message' } });
      else if (frame.message?.type === 'timeline_request') reply(history(frame.message.payload.requestId, frame.message.payload.agentId, frame.message.payload.direction));
    });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  cleanups.push(() => vi.useRealTimers());
  const transport = new HttpWebSocketTransport('http://127.0.0.1:1/base/', { WebSocket: memory.WebSocket, sessionChannels: true, stateRetryMs: 10, fetch: (async () => Response.json(history('http'))) as unknown as typeof fetch });
  cleanups.push(() => transport.dispose?.());
  return { ...memory, transport, closedByRelay };
}

/** A page with two conversations; the first has a message whose delivery the lost channel left unknown. */
async function pageWithACutOffMessage(ready: object) {
  const harness = relay(ready);
  const replica = new AgentReplica();
  const first = new RemoteSessionClient('a', harness.transport, replica, { reconnectInitialDelayMs: 250, operationTimeoutMs: 20 });
  const second = new RemoteSessionClient('b', harness.transport, new AgentReplica(), { reconnectInitialDelayMs: 250 });
  cleanups.push(() => { first.stop(); second.stop(); });
  const statuses = { a: 'idle', b: 'idle' }; first.subscribeStatus(s => { statuses.a = s; }); second.subscribeStatus(s => { statuses.b = s; });
  first.start(); second.start();
  await settled();
  expect(statuses).toEqual({ a: 'ready', b: 'ready' });
  const send = first.sendMessage('Cut off'); void send.catch(() => undefined);
  await settled();
  harness.sockets[0]!.terminate();
  await settled();
  // The reconnect delay, then the handshake of both conversations on the new channel.
  await vi.advanceTimersByTimeAsync(3_000);
  for (let turn = 0; turn < 4; turn += 1) await settled();
  return { ...harness, replica, statuses, first, second };
}

describe('the recording of the previous Relay', () => {
  it('refuses a send that settles, and only because of the field it does not know', () => {
    expect(unknownToOldRelay).toEqual(['settle']);
    for (const { frame, answer } of recording.decoded) expect([frame, answer.status, decodeSessionChannelClientMessage(JSON.stringify(frame)).status]).toEqual([frame, 'ok', 'ok']);
    // The current decoder takes both, so the difference is the Relay's release, not the frame.
    expect(decodeSessionChannelClientMessage(JSON.stringify(recording.refused[0]!.frame)).status).toBe('ok');
    expect(recording.refused[0]!.answer).toMatchObject({ status: 'rejected', channel: { closeCode: 1008 } });
  });
});

describe('a new client against the Relay of the previous release', () => {
  it('does not ask whether a cut-off message arrived, so no channel closes, no message is sent twice and every page conversation stays', async () => {
    const f = await pageWithACutOffMessage(recording.ready);
    expect(f.replica.getState().outgoingMessages).toMatchObject([{ status: 'unconfirmed' }]);
    expect(f.statuses).toEqual({ a: 'ready', b: 'ready' });
    const sends = f.frames.filter(({ frame }) => frame.message?.type === 'send_message');
    expect(sends).toHaveLength(1);
    expect(sends.some(({ frame }) => 'settle' in frame.message.payload)).toBe(false);
    expect(f.closedByRelay).toEqual([]);
    // One channel lost, one opened again; nothing loops.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets.filter(socket => socket.readyState === 1)).toHaveLength(1);
  });

  it('is still sent what it types: a new message goes out normally on the channel of the old Relay', async () => {
    const f = await pageWithACutOffMessage(recording.ready);
    const send = f.first.sendMessage('Next'); void send.catch(() => undefined);
    await settled();
    expect(f.frames.filter(({ frame }) => frame.message?.type === 'send_message').map(({ frame }) => frame.message.payload.text)).toEqual(['Cut off', 'Next']);
    expect(f.closedByRelay).toEqual([]);
  });

  it('asks a Relay that announces settlement, once, and the old Relay would have closed the channel on that frame', async () => {
    const f = await pageWithACutOffMessage({ ...recording.ready, settlement: 1 });
    const asks = f.frames.filter(({ frame }) => frame.message?.payload?.settle === true);
    expect(asks).toHaveLength(1);
    // The same frame, played to the old Relay: it closes the channel the page's other conversation also lives on.
    const old = relay(recording.ready);
    const channel = new old.WebSocket('http://127.0.0.1:1/base/v1/session-channel');
    await settled();
    channel.send(JSON.stringify(asks[0]!.frame));
    await settled();
    expect(old.closedByRelay).toHaveLength(1);
    expect(channel.readyState).toBe(3);
  });
});

describe('a ready frame without the flags of the newer releases', () => {
  it('leaves every feature the flags announce off, and the session works', async () => {
    const memory = memorySocketServer();
    memory.onConnection((socket) => { socket.send(JSON.stringify({ protocolVersion: version, type: 'ready' })); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    cleanups.push(() => vi.useRealTimers());
    const transport = new HttpWebSocketTransport('http://127.0.0.1:1/base/', { WebSocket: memory.WebSocket, sessionChannels: true, sessionSuccessions: true, stateRetryMs: 10 });
    cleanups.push(() => transport.dispose?.());
    const connection = transport.connect('a', { onOpen: () => undefined, onMessage: () => undefined, onDisconnect: () => undefined });
    await settled();
    connection.setActive?.(false, 1); connection.send({ protocolVersion: version, type: 'negotiate' });
    await settled();
    // No successions: the page learns the Relay has none and takes the path of a client without them.
    expect(transport.sessionSuccessionSupport).toBe('unsupported');
    // No preemption: the client reports no `intent`, and a subscribe carries no `idleMs`.
    expect(memory.frames.map(({ frame }) => frame.type)).toEqual(['subscribe']);
    expect(memory.frames[0]!.frame).not.toHaveProperty('idleMs');
    // No settlement: the connection says it cannot settle.
    expect(connection.settles).toBe(false);
    connection.close();
  });
});
