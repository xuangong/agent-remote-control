// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpWebSocketTransport } from '@orchardworks/agent-client';
import { memorySocketServer } from '@orchardworks/agent-client/testing';
import { decodeSessionChannelServerMessage } from '@orchardworks/agent-remote-protocol';
import { frameShape, relayReadyFrames, runScriptedSession, scriptedRelay, settled, version } from './release-skew.fixture.js';

/**
 * S3, the session wire across a deploy. A Worker and its Durable Object are deployed independently, and pages keep running the bundle
 * they loaded, so for minutes (phones: days) the release in production and the next one meet on one wire. Both sides decode strictly:
 * the Relay closes the channel with 1008 on a client frame with a field it does not know, and the client fails the channel on a
 * server frame with one. A release may therefore add a field or frame only once the other side of the previous release decodes it
 * (the release before 388205b7 did not decode `settle`, which is why this rule exists).
 *
 * `fixtures/release-388205b7.json` holds the verdicts of production's decoders (provenance in the file) on the frames this tree sends.
 * The tests play the verdicts: no frame of this tree may be one that production refuses.
 */
interface Verdict { frame: any; verdict: 'accepted' | 'refused' }
const recording = JSON.parse(readFileSync(new URL('./fixtures/release-388205b7.json', import.meta.url), 'utf8')) as { relayChannelDecoder: Verdict[]; clientReadyDecoder: Verdict[] };
const relayVerdicts = new Map(recording.relayChannelDecoder.map(({ frame, verdict }) => [frameShape(frame), verdict]));
const readyVerdicts = new Map(recording.clientReadyDecoder.map(({ frame, verdict }) => [JSON.stringify(frame), verdict]));
const unrecorded: string[] = [];
const judge = (frame: any) => {
  const verdict = relayVerdicts.get(frameShape(frame));
  if (!verdict) unrecorded.push(frameShape(frame));
  return verdict ?? 'refused';
};
const cleanups: (() => unknown)[] = [];
afterEach(async () => { unrecorded.length = 0; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const productionReady = { protocolVersion: version, type: 'ready', preemption: 1 };

describe('a new client against the Relay in production', () => {
  it('sends only frames the production Relay decodes, so its scripted session never loses its channel', async () => {
    const relay = scriptedRelay(productionReady, judge); cleanups.push(relay.dispose);
    const session = await runScriptedSession(relay);
    expect(unrecorded, 'a frame shape the recording does not hold: record the verdict of production for it').toEqual([]);
    expect(relay.refused).toEqual([]);
    // The channel is lost once, on purpose; the client opened exactly one more.
    expect(session.sockets).toHaveLength(2);
    const sent = session.frames.flatMap(frame => [frame.type, frame.message?.type]);
    for (const type of ['subscribe', 'unsubscribe', 'intent', 'ping', 'send_message', 'steer', 'cancel', 'set_session_setting', 'set_planning', 'list_commands', 'execute_command',
      'session_control_request', 'interaction_response', 'resource_request', 'resource_resolve_request', 'timeline_subscription', 'timeline_request']) expect(sent).toContain(type);
    expect(session.frames.some(frame => frame.message?.payload?.settle === true)).toBe(true);
  });

  it('plays the recorded verdict: a frame production refuses closes the channel of every conversation on it', async () => {
    const refusing = (frame: any) => frame.message?.payload?.settle === true ? 'refused' : 'accepted';
    const relay = scriptedRelay(productionReady, refusing); cleanups.push(relay.dispose);
    const session = await runScriptedSession(relay);
    expect(relay.refused.length).toBeGreaterThan(0);
    expect(session.sockets.length).toBeGreaterThan(2);
  });

  it('degrades on a ready frame without the flags: no intent, no idleMs, no successions, and the session works', async () => {
    const relay = scriptedRelay({ protocolVersion: version, type: 'ready' }, judge); cleanups.push(relay.dispose);
    const session = await runScriptedSession(relay);
    expect(session.frames.filter(frame => frame.type === 'intent')).toEqual([]);
    expect(session.frames.filter(frame => frame.type === 'subscribe' && 'idleMs' in frame)).toEqual([]);
    expect(unrecorded).toEqual([]);
    expect(relay.refused).toEqual([]);
    expect(session.frames.some(frame => frame.message?.type === 'send_message')).toBe(true);
  });

  it('knows no successions on a ready frame without them, and takes the path of a client without them', async () => {
    const memory = memorySocketServer();
    memory.onConnection(socket => { socket.send(JSON.stringify({ protocolVersion: version, type: 'ready' })); });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const transport = new HttpWebSocketTransport('http://127.0.0.1:1/base/', { WebSocket: memory.WebSocket, sessionChannels: true, sessionSuccessions: true, stateRetryMs: 10 });
    cleanups.push(() => { transport.dispose?.(); vi.useRealTimers(); });
    transport.connect('a', { onOpen: () => undefined, onMessage: () => undefined, onDisconnect: () => undefined }).send({ protocolVersion: version, type: 'negotiate' });
    await settled();
    expect(transport.sessionSuccessionSupport).toBe('unsupported');
  });
});

describe('the client in production against the Relay of this tree', () => {
  it('decodes every ready frame the channel adapter of this tree sends', () => {
    const frames = relayReadyFrames();
    expect(frames.length).toBe(4);
    for (const frame of frames) {
      expect(readyVerdicts.get(JSON.stringify(frame)), `production's client has no accepting verdict for ${JSON.stringify(frame)}`).toBe('accepted');
    }
  });

  it('is recorded to refuse a ready frame with a flag it does not know, which is why a new flag cannot ship before the clients know it', () => {
    const unknown = recording.clientReadyDecoder.filter(({ frame }) => 'settlement' in frame || 'futureFeature' in frame);
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every(({ verdict }) => verdict === 'refused')).toBe(true);
    // The tree's own client agrees about a flag it does not know: the recorded rule holds for the current decoder too.
    for (const { frame } of unknown) expect(decodeSessionChannelServerMessage(JSON.stringify(frame)).status).toBe('rejected');
  });
});
