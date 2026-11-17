import { describe, expect, it } from 'vitest';

import { createNormalizer, createRecorder, framesOf, materialize, mismatch, parseTranscript, playRole, serializeTranscript, type PlayerPeer } from './transcript.js';

const header = { seam: 'S3' as const, scenario: 'sample', description: 'A sample.', consumers: ['x.test.ts'], protocolVersion: '1.8.0', recordedAt: 'test' };

describe('normalizing a message', () => {
  it('numbers ids, tokens and random request ids by first appearance and keeps what is stable', () => {
    const normalize = createNormalizer();
    const first = normalize({ type: 'lease', token: 'secret-abc', revision: '11111111-1111-4111-8111-111111111111', requestId: 'open-0.123', itemKey: 'user:22222222-2222-4222-8222-222222222222', sessionKey: 'codex:native' });
    const second = normalize({ revision: '11111111-1111-4111-8111-111111111111', token: 'secret-xyz', other: '33333333-3333-4333-8333-333333333333' });
    expect(first).toEqual({ type: 'lease', token: '<token:1>', revision: '<uuid:1>', requestId: 'open-<random:1>', itemKey: 'user:<uuid:2>', sessionKey: 'codex:native' });
    expect(second).toEqual({ revision: '<uuid:1>', token: '<token:2>', other: '<uuid:3>' });
  });

  it('turns times into placeholders and unwraps a JSON string a message carries', () => {
    const normalize = createNormalizer();
    expect(normalize({ occurredAt: 1_725_000_000_000, createdAt: '2026-11-15T00:00:00.000Z', watermark: 7, message: '{"type":"x","observedAt":5}' })).toEqual({
      occurredAt: '<time>', createdAt: '<iso>', watermark: 7, message: { $json: { type: 'x', observedAt: '<time>' } },
    });
  });
});

describe('a transcript file', () => {
  it('round-trips through its JSON lines, with the header first and steps between frames', () => {
    const recorder = createRecorder(header);
    recorder.step('open');
    recorder.frame('browser->relay', JSON.stringify({ type: 'negotiate' }));
    recorder.frame('relay->browser', JSON.stringify({ type: 'negotiated', token: 'abc' }));
    const transcript = recorder.finish();
    const text = serializeTranscript(transcript);
    expect(text.split('\n')[0]).toContain('"kind":"transcript"');
    expect(parseTranscript(text)).toEqual(transcript);
    expect(framesOf(transcript, 'relay->browser').map(frame => frame.n)).toEqual([2]);
  });

  it('refuses a file whose first line is not a header', () => {
    expect(() => parseTranscript('{"n":1}\n')).toThrow('header');
  });
});

describe('matching a frame against a transcript', () => {
  it('binds a placeholder to the first value and requires the same value afterwards', () => {
    const bindings = new Map<string, string>();
    expect(mismatch({ id: '<uuid:1>' }, { id: 'a' }, bindings)).toBeUndefined();
    expect(mismatch({ id: '<uuid:1>' }, { id: 'a' }, bindings)).toBeUndefined();
    expect(mismatch({ id: '<uuid:1>' }, { id: 'b' }, bindings)).toContain('uuid:1 was a, now b');
  });

  it('accepts any time for a time placeholder and compares everything else exactly', () => {
    const bindings = new Map<string, string>();
    expect(mismatch({ at: '<time>', n: 1 }, { at: 99, n: 1 }, bindings)).toBeUndefined();
    expect(mismatch({ n: 1 }, { n: 2 }, bindings)).toContain('$.n');
    expect(mismatch({ n: 1 }, { n: 1, extra: true }, bindings)).toContain('unexpected field');
    expect(mismatch({ n: 1, needed: 2 }, { n: 1 }, bindings)).toContain('missing field');
  });

  it('matches a JSON string against its unwrapped form, placeholders inside strings included', () => {
    const bindings = new Map<string, string>();
    expect(mismatch({ message: { $json: { id: 'user:<uuid:1>' } } }, { message: '{"id":"user:abc"}' }, bindings)).toBeUndefined();
    expect(bindings.get('uuid:1')).toBe('abc');
  });
});

describe('sending a transcript frame', () => {
  it('fills a bound placeholder with what the other side said and the rest with stable stand-ins', () => {
    const bindings = new Map([['token:1', 'granted']]);
    expect(materialize({ token: '<token:1>', operationId: '<uuid:3>', at: '<time>', message: { $json: { n: 1 } } }, bindings)).toEqual({
      token: 'granted', operationId: '00000000-0000-4000-8000-000000000003', at: 10_000, message: '{"n":1}',
    });
  });
});

describe('playing a role', () => {
  const transcript = (() => {
    const recorder = createRecorder(header);
    recorder.frame('browser->relay', JSON.stringify({ type: 'acquire' }));
    recorder.frame('relay->browser', JSON.stringify({ type: 'lease', token: 'granted-1' }));
    recorder.frame('browser->relay', JSON.stringify({ type: 'send', token: 'granted-1' }));
    return recorder.finish();
  })();

  /** A Relay stand-in: answers an acquire with a lease and keeps what it was sent. */
  const relay = (reply: unknown) => {
    const sent: unknown[] = [];
    const queue: unknown[] = [];
    const peer: PlayerPeer = { send: json => { sent.push(JSON.parse(json)); if ((JSON.parse(json) as { type: string }).type === 'acquire') queue.push(reply); }, next: async () => queue.shift() };
    return { sent, peer };
  };

  it('sends its frames, waits for the other side\'s, and echoes a value the other side chose', async () => {
    const { sent, peer } = relay({ type: 'lease', token: 'real-token' });
    expect(await playRole(transcript, 'browser', peer)).toBe(1);
    expect(sent.at(-1)).toEqual({ type: 'send', token: 'real-token' });
  });

  it('names the frame that differs from the transcript', async () => {
    const { peer } = relay({ type: 'refusal' });
    await expect(playRole(transcript, 'browser', peer)).rejects.toThrow('sample, frame 2 (relay->browser)');
  });
});
