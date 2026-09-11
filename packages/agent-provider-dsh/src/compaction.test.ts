import { describe, expect, it } from 'vitest';
import { DshProjector, type DshNativeObservation } from './projector.js';
import { LiveDshSession } from './live-session.js';

function record(seq: number, type: string, data: Record<string, unknown>): DshNativeObservation {
  return { recordId: `event:${seq}`, occurredAt: 1000 + seq, kind: 'session_event', payload: { type, data, seq } };
}
function projector() { return new DshProjector({ sessionId: 's', tools: { get: () => undefined } }); }

describe('DSH compaction lifecycle projection', () => {
  it('preserves original conversation text while projecting native lifecycle and skipping summary bookkeeping', () => {
    const view = projector();
    const records = [
      record(0, 'user/message', { id: 'u', turn: 1, source: { kind: 'user' }, content: [{ type: 'text', text: 'Original question' }] }),
      record(1, 'compaction/start', { compactionId: 'compact-1', turn: 1 }),
      record(2, 'compaction/summary', { compactionId: 'compact-1', summary: [{ type: 'text', text: 'Internal summary' }], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 40, provider: 'native', model: 'a' }),
      record(3, 'user/message', { id: 'checkpoint', turn: 1, source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-1' }, content: [{ type: 'text', text: 'Internal summary' }] }),
      record(4, 'compaction/end', { compactionId: 'compact-1', turn: 1 }),
    ];
    const projected = records.flatMap((input) => view.project(input));
    expect(projected.map(({ event }) => event)).toEqual([
      { type: 'timeline', provider: 'dsh', turnId: '1', item: { type: 'user_message', messageId: 'u', text: 'Original question' } },
      { type: 'timeline', provider: 'dsh', turnId: '1', item: { type: 'compaction', status: 'loading' } },
      { type: 'timeline', provider: 'dsh', turnId: '1', item: { type: 'compaction', status: 'completed' } },
    ]);
  });

  it.each(['Summary generation failed', 'Interrupted'])('reports a failed standalone manual compaction without claiming completion: %s', (error) => {
    const view = projector();
    expect(view.project(record(0, 'compaction/start', { compactionId: 'manual', turn: null, sourceCommandId: 'cmd' }))[0]?.event).toEqual({
      type: 'timeline', provider: 'dsh', item: { type: 'compaction', status: 'loading', trigger: 'manual' },
    });
    expect(view.project(record(1, 'compaction/end', { compactionId: 'manual', turn: null, sourceCommandId: 'cmd', error })).map(({ event }) => event)).toEqual([
      { type: 'timeline', provider: 'dsh', item: { type: 'error', message: `DSH compaction manual failed: ${error}` } },
    ]);
    expect(view.project(record(2, 'compaction/start', { compactionId: 'retry', turn: null }))[0]?.event).toMatchObject({ item: { type: 'compaction', status: 'loading' } });
    expect(view.project(record(3, 'turn/end', { turn: 2, reason: { kind: 'completed' } }))[0]?.event.type).toBe('turn_completed');
  });

  it('does not close another compaction when an end has the wrong native identity or owner', () => {
    const view = projector();
    view.project(record(0, 'compaction/start', { compactionId: 'a', turn: 1 }));
    for (const data of [{ compactionId: 'b', turn: 1 }, { compactionId: 'a', turn: 2 }]) {
      expect(view.project(record(1, 'compaction/end', data)).map(({ event }) => event)).toEqual([
        expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'error' }) }),
      ]);
    }
    expect(view.project(record(2, 'compaction/end', { compactionId: 'a', turn: 1 }))[0]?.event).toMatchObject({ item: { type: 'compaction', status: 'completed' } });
  });

  it('retains stable source keys across replay while distinguishing separate compactions', () => {
    const history = [record(0, 'compaction/start', { compactionId: 'a', turn: null }), record(1, 'compaction/end', { compactionId: 'a', turn: null }), record(2, 'compaction/start', { compactionId: 'b', turn: null })];
    const first = projector();
    const replay = projector();
    const observations = history.flatMap((input) => first.project(input));
    expect(history.flatMap((input) => replay.project(input))).toEqual(observations);
    expect(observations.map(({ event }) => event)).toEqual([
      { type: 'timeline', provider: 'dsh', item: { type: 'compaction', status: 'loading' } },
      { type: 'timeline', provider: 'dsh', item: { type: 'compaction', status: 'completed' } },
      { type: 'timeline', provider: 'dsh', item: { type: 'compaction', status: 'loading' } },
    ]);
    expect(new Set(observations.map(({ sourceKey }) => sourceKey)).size).toBe(3);
  });

  it('deduplicates a native start in the history/live overlap before closing the same compaction live', async () => {
    const start = record(0, 'compaction/start', { compactionId: 'overlap', turn: null });
    const end = record(1, 'compaction/end', { compactionId: 'overlap', turn: null });
    let listener: ((input: DshNativeObservation) => void) | undefined;
    const agent = {
      sessionId: 's', runtimeInfo: { status: 'idle' }, features: { interactions: {} },
      subscribe(receive: typeof listener) { listener = receive; return () => { listener = undefined; }; },
      get events() { listener?.(start); listener?.(end); return [start]; },
      async flush() {}, async dispose() {},
    };
    const session = new LiveDshSession(agent as never, { providerId: 'dsh', sessionId: 's', opaque: '{}' }, { get: () => undefined } as never);
    try {
      const stream = session.observe()[Symbol.asyncIterator]();
      expect((await stream.next()).value).toMatchObject({ delivery: 'history', event: { item: { type: 'compaction', status: 'loading' } } });
      expect((await stream.next()).value).toEqual({ type: 'history_boundary' });
      expect((await stream.next()).value).toMatchObject({ delivery: 'live', event: { item: { type: 'compaction', status: 'completed' } } });
      listener?.(record(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }));
      expect((await stream.next()).value).toMatchObject({ delivery: 'live', event: { type: 'turn_completed' } });
    } finally { await session.dispose(); }
  });
});
