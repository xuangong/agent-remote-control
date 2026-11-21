import { expect, vi } from 'vitest';
import { AgentReplica, HttpWebSocketTransport, RemoteSessionClient } from '@orchardworks/agent-client';
import { memorySocketServer } from '@orchardworks/agent-client/testing';
import { acceptSessionChannel, type SessionChannelSocket } from '@orchardworks/agent-remote-protocol';

/**
 * What this tree puts on the session wire, for the tests that play it against the release in production (`release-skew.integration.test.ts`).
 * `emittedClientFrames` is a scripted session of the real client over a real transport; `relayReadyFrames` are the `ready` frames of the
 * real channel adapter of the Relay. `frameShape` names a frame by the fields it carries, which is what a strict decoder judges.
 */
export const version = '1.8.0';
/** The message the Relay stub never answers, which the scripted session then loses its channel on. */
const CUT_OFF = 'Cut off';
const immediate = globalThis.setImmediate;
export const settled = () => new Promise<void>(resolve => immediate(resolve));

/** The fields a strict decoder judges: the frame type, the inner message type, and the keys of what they carry. */
export function frameShape(frame: any): string {
  const keys = (value: unknown) => value && typeof value === 'object' ? Object.keys(value).sort().join(',') : '';
  const inner = frame.message;
  return [frame.type, keys(frame), inner?.type, keys(inner), keys(inner?.payload)].join('|');
}

export const history = (requestId: string, agentId: string, direction: string) => ({ protocolVersion: version, type: 'timeline_page', payload: {
  requestId, agentId, direction, epoch: 'epoch', reset: false, staleCursor: false, gap: false, error: null,
  window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [] } });
export const snapshot = (id: string) => ({ protocolVersion: version, type: 'agent_snapshot', payload: {
  id, providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
  status: 'idle', activeTurn: null, pendingInteractions: [], runtimeInfo: { providerId: 'test', sessionId: id, status: 'idle' },
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } } } });

/**
 * A Relay stub that answers the handshake of a session and nothing else, to be given the frames the client sends. `judge` decides, per
 * frame, whether the Relay under test decodes it; a refused frame closes the channel, as the Relay of production does with 1008.
 */
export function scriptedRelay(ready: object, judge: (frame: any) => 'accepted' | 'refused') {
  const memory = memorySocketServer();
  const refused: any[] = [];
  memory.onConnection((socket) => {
    socket.send(JSON.stringify(ready));
    socket.on('message', (data: string) => {
      const frame = JSON.parse(data);
      if (judge(frame) === 'refused') { refused.push(frame); socket.close(1008, 'Invalid channel frame'); return; }
      if (frame.type === 'ping') { socket.send(JSON.stringify({ protocolVersion: version, type: 'pong' })); return; }
      const reply = (message: object) => socket.send(JSON.stringify({ protocolVersion: version, type: 'message', subscriptionId: frame.subscriptionId, message }));
      const inner = frame.message;
      if (frame.type === 'subscribe') { reply({ protocolVersion: version, type: 'negotiated', sessionControl: true }); reply(snapshot(frame.agentId)); reply({ protocolVersion: version, type: 'session_control', payload: { agentId: frame.agentId, revision: 'one', access: 'read_only', available: true } }); }
      else if (inner?.type === 'session_control_request') reply({ protocolVersion: version, type: 'session_control', payload: { agentId: inner.payload.agentId, requestId: inner.payload.requestId, access: 'control', available: false, revision: 'two', token: 'proof' } });
      else if (inner?.type === 'timeline_subscription') reply({ protocolVersion: version, type: 'timeline_subscribed', payload: { requestId: inner.payload.requestId, agentIds: inner.payload.agentIds } });
      else if (inner?.type === 'timeline_request') reply(history(inner.payload.requestId, inner.payload.agentId, inner.payload.direction));
      else if (inner?.type === 'send_message' && inner.payload.text !== CUT_OFF) reply({ protocolVersion: version, type: 'command_acknowledged', payload: { requestId: inner.payload.requestId, agentId: inner.payload.agentId, command: 'send_message' } });
    });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const transport = new HttpWebSocketTransport('http://127.0.0.1:1/base/', { WebSocket: memory.WebSocket, sessionChannels: true, stateRetryMs: 10, fetch: (async () => Response.json(history('http', 'a', 'tail'))) as unknown as typeof fetch });
  return { ...memory, transport, refused, dispose: () => { transport.dispose?.(); vi.useRealTimers(); } };
}

/**
 * A scripted session of the real client over the real transport: it opens, sends, steers, cancels, changes settings, runs commands,
 * takes control, asks for resources, answers an interaction, loses its channel with a message unconfirmed (so it settles it after
 * the reconnect), goes out of use and stops.
 */
export async function runScriptedSession(relay: ReturnType<typeof scriptedRelay>) {
  const quiet = (promise: Promise<unknown>) => { promise.catch(() => undefined); };
  const first = new RemoteSessionClient('a', relay.transport, new AgentReplica(), { reconnectInitialDelayMs: 250, operationTimeoutMs: 20 });
  const second = new RemoteSessionClient('b', relay.transport, new AgentReplica(), { reconnectInitialDelayMs: 250 });
  const statuses = { a: 'idle', b: 'idle' }; first.subscribeStatus(s => { statuses.a = s; }); second.subscribeStatus(s => { statuses.b = s; });
  first.start(); second.start();
  await settled();
  expect(statuses).toEqual({ a: 'ready', b: 'ready' });
  quiet(first.takeControl()); await settled();
  quiet(first.sendMessage('Hello')); quiet(first.sendMessageContent([{ type: 'text', text: 'Parts' }]));
  quiet(first.sendMessage('Later', { delivery: 'next_turn' }));
  quiet(first.steer('Turn left')); quiet(first.cancel()); quiet(first.setSessionSetting('mode', 'fast')); quiet(first.setPlanning(true));
  quiet(first.listCommands()); quiet(first.executeCommand('compact', ''));
  quiet(first.requestResource('resource-one')); quiet(first.resolveResource('file.txt'));
  quiet(first.respondToInteraction('request-one', { kind: 'question', answers: [] }, '11111111-1111-4111-8111-111111111111'));
  await settled();
  second.setActive(false); await settled();
  await vi.advanceTimersByTimeAsync(31_000); await settled();
  // The channel is lost while a message is unconfirmed; after the reconnect the client asks whether it arrived.
  quiet(first.sendMessage(CUT_OFF));
  await settled();
  relay.sockets[0]!.terminate();
  await settled();
  await vi.advanceTimersByTimeAsync(3_000);
  for (let turn = 0; turn < 4; turn += 1) await settled();
  first.stop(); second.stop();
  await settled();
  return { statuses, sockets: relay.sockets, frames: relay.frames.map(({ frame }) => frame) };
}

/** The `ready` frames the Relay's channel adapter sends: with and without successions, with and without preemption. */
export function relayReadyFrames(): any[] {
  const frames: any[] = [];
  for (const successions of [false, true]) for (const preemption of [false, true]) {
    const sent: any[] = [];
    const socket: SessionChannelSocket = { readyState: 1, bufferedAmount: 0, send: data => { sent.push(JSON.parse(data)); }, close: () => undefined,
      onMessage: () => () => undefined, onClose: () => () => undefined, onError: () => () => undefined };
    const stop = acceptSessionChannel(socket, 'session', async () => ({ code: 1011, reason: 'unused' }), successions ? { successions: 1 } : {}, undefined,
      preemption ? { register: () => () => undefined } : undefined);
    stop();
    frames.push(sent[0]);
  }
  return frames;
}
