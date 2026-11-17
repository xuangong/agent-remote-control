import { describe, expect, it } from 'vitest';
import { decodeChannelFrame, TranscriptRecorder } from './transcript.js';

const tapped = (direction: 'browser->relay' | 'relay->browser', body: object, t = 1000) => ({ t, connection: 1, direction, text: JSON.stringify({ protocolVersion: '1.8.0', ...body }) });
const counter = () => { let n = 0; return () => ++n; };

describe('decoding a session-channel frame', () => {
  it('unwraps a message frame and keeps its subscription', () => {
    const [frame] = decodeChannelFrame(tapped('relay->browser', { type: 'message', subscriptionId: 3, message: { type: 'timeline_replacement', payload: { agentId: 'a', epoch: 'e' } } }), counter());
    expect(frame).toMatchObject({ n: 1, subscriptionId: 3, direction: 'relay->browser', message: { type: 'timeline_replacement', payload: { epoch: 'e' } } });
  });
  it('splits a subscribe into the subscription and its negotiation, both carrying the agent', () => {
    const frames = decodeChannelFrame(tapped('browser->relay', { type: 'subscribe', subscriptionId: 2, agentId: 'agent-1', message: { type: 'negotiate' } }), counter());
    expect(frames.map(frame => [frame.message.type, frame.message.payload?.agentId, frame.subscriptionId])).toEqual([['subscribe', 'agent-1', 2], ['negotiate', 'agent-1', 2]]);
  });
  it('keeps closed and state frames by their own type and drops keep-alives and garbage', () => {
    expect(decodeChannelFrame(tapped('relay->browser', { type: 'closed', subscriptionId: 4, code: 1013, reason: 'full' }), counter())[0]?.message).toEqual({ type: 'closed', payload: { code: 1013, reason: 'full' } });
    expect(decodeChannelFrame(tapped('relay->browser', { type: 'session_states', snapshot: true, states: [] }), counter())[0]?.message.type).toBe('session_states');
    expect(decodeChannelFrame(tapped('browser->relay', { type: 'ping' }), counter())).toEqual([]);
    expect(decodeChannelFrame({ ...tapped('relay->browser', {}), text: 'not json' }, counter())).toEqual([]);
  });
});

describe('the transcript recorder', () => {
  it('numbers frames and markers in arrival order on the run clock and writes JSON lines', () => {
    let now = 10_000;
    const recorder = new TranscriptRecorder(() => now);
    now = 10_500;
    recorder.socket({ t: 10_500, connection: 1, event: 'open' });
    recorder.tap(tapped('relay->browser', { type: 'message', subscriptionId: 1, message: { type: 'negotiated' } }, 10_600));
    now = 11_000;
    recorder.mark('controller-restart', { mode: 'kill' });
    const transcript = recorder.transcript();
    expect(transcript.map(entry => entry.n)).toEqual([1, 2, 3]);
    expect(transcript.map(entry => entry.t)).toEqual([500, 600, 1000]);
    expect(recorder.toJsonLines().trim().split('\n')).toHaveLength(3);
    expect(transcript[2]).toMatchObject({ marker: 'controller-restart', detail: { mode: 'kill' } });
  });
});
