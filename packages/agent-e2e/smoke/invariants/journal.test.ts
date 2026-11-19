import { describe, expect, it } from 'vitest';
import { page, streamEntry, tailPage, transcript } from './builders.js';
import { journalSequencesContiguous, liveOnlyItemsSurvive, quotaRefusalsReported, noRefusedRowHole, oneReplacementPerRestart, trimReported, turnRowsCompleteAfterReturn } from './journal.js';

describe('journal sequences are contiguous', () => {
  it('passes when live entries continue the tail page', () => {
    const wire = transcript().receive(1, 'timeline_page', tailPage('e1', 1, 5)).receive(2, 'agent_stream', streamEntry('e1', 6)).receive(3, 'agent_stream', streamEntry('e1', 7)).build();
    expect(journalSequencesContiguous(wire).status).toBe('passed');
  });
  it('passes when a reconnect starts a new connection at a later sequence', () => {
    const wire = transcript().receive(1, 'timeline_page', tailPage('e1', 1, 5)).receive(2, 'agent_stream', streamEntry('e1', 6))
      .onConnection(2).receive(9, 'timeline_page', tailPage('e1', 1, 9)).receive(10, 'agent_stream', streamEntry('e1', 10)).build();
    expect(journalSequencesContiguous(wire).status).toBe('passed');
  });
  it('fails on a gap and on a repeat', () => {
    const gap = transcript().receive(1, 'timeline_page', tailPage('e1', 1, 5)).receive(2, 'agent_stream', streamEntry('e1', 8)).build();
    const repeat = transcript().receive(1, 'agent_stream', streamEntry('e1', 6)).receive(2, 'agent_stream', streamEntry('e1', 6)).build();
    expect(journalSequencesContiguous(gap).violations[0]?.message).toMatch(/8 followed 5/);
    expect(journalSequencesContiguous(repeat).status).toBe('failed');
  });
});

describe('one replacement per restart', () => {
  it('passes with one replacement after each restart', () => {
    const wire = transcript().marker(1, 'controller-restart').receive(2, 'timeline_replacement', { agentId: 'agent', epoch: 'e2' })
      .marker(3, 'controller-restart').receive(4, 'timeline_replacement', { agentId: 'agent', epoch: 'e3' }).build();
    expect(oneReplacementPerRestart(wire).status).toBe('passed');
  });
  it('fails when one restart is followed by two replacements', () => {
    const wire = transcript().marker(1, 'relay-restart').receive(2, 'timeline_replacement', { agentId: 'agent', epoch: 'e2' })
      .receive(3, 'timeline_replacement', { agentId: 'agent', epoch: 'e3' }).build();
    expect(oneReplacementPerRestart(wire).status).toBe('failed');
  });
});

describe('turn rows are complete after return', () => {
  const rows = [{ key: 'u1', kind: 'user_message', text: 'count to three' }, { key: 'a1', kind: 'assistant_message', text: '1 2 3' }];
  it('passes when the turn has its user message and reply', () => {
    expect(turnRowsCompleteAfterReturn(page({ finalRows: rows }), [{ prompt: 'count to three' }]).status).toBe('passed');
  });
  it('fails for a missing reply, a missing prompt and a tool call still running', () => {
    expect(turnRowsCompleteAfterReturn(page({ finalRows: rows.slice(0, 1) }), [{ prompt: 'count to three' }]).status).toBe('failed');
    expect(turnRowsCompleteAfterReturn(page({ finalRows: [] }), [{ prompt: 'count to three' }]).violations[0]?.message).toMatch(/missing/);
    const running = [...rows.slice(0, 1), { key: 't1', kind: 'tool_call', text: '', status: 'running' }, rows[1]!];
    expect(turnRowsCompleteAfterReturn(page({ finalRows: running }), [{ prompt: 'count to three' }]).violations[0]?.message).toMatch(/running tool call/);
  });
});

describe('trims are reported', () => {
  it('passes when a page above sequence 1 reports older history', () => {
    expect(trimReported(transcript().receive(1, 'timeline_page', tailPage('e1', 40, 60)).build()).status).toBe('passed');
  });
  it('fails when the page hides the trimmed rows', () => {
    expect(trimReported(transcript().receive(1, 'timeline_page', tailPage('e1', 40, 60, { hasOlder: false })).build()).status).toBe('failed');
  });
});

describe('live-only items survive a trim', () => {
  it('passes when the named item is shown', () => {
    expect(liveOnlyItemsSurvive(page({ finalRows: [{ key: 'live', kind: 'tool_call', text: '' }] }), ['live']).status).toBe('passed');
  });
  it('fails when it is gone', () => {
    expect(liveOnlyItemsSurvive(page({ finalRows: [] }), ['live']).status).toBe('failed');
  });
});

describe('no refused-row hole', () => {
  it('passes for entries that follow each other', () => {
    expect(noRefusedRowHole(transcript().receive(1, 'timeline_page', tailPage('e1', 1, 4)).build()).status).toBe('passed');
  });
  it('fails when an entry skips a sequence', () => {
    const entries = [{ itemKey: 'a', seqStart: 1, seqEnd: 2 }, { itemKey: 'b', seqStart: 4, seqEnd: 4 }];
    expect(noRefusedRowHole(transcript().receive(1, 'timeline_page', tailPage('e1', 1, 4, { entries })).build()).status).toBe('failed');
  });
});

describe('quota refusals are reported', () => {
  const publish = (bytes: number) => ({ sessionKey: 'p:s', generation: 1, entries: [{ sequence: 1, op: 'window', items: [{ text: 'x'.repeat(bytes) }] }] });
  const answered = (reply: (builder: ReturnType<typeof transcript>) => void, bytes = 5000) => { const builder = transcript().send(1, 'journal_publish', publish(bytes)); reply(builder); return builder.build(); };
  it('passes for a window refused by name and for one taken within the limit', () => {
    expect(quotaRefusalsReported(answered(b => b.receive(2, 'journal_refused', { sessionKey: 'p:s', generation: 1, sequence: 1, reason: 'quota_exceeded' })), { sessionBytes: 1024 }).status).toBe('passed');
    expect(quotaRefusalsReported(answered(b => b.receive(2, 'journal_ack', { sessionKey: 'p:s', generation: 1, watermark: 1 }), 100), { sessionBytes: 1024 }).status).toBe('passed');
  });
  it('fails for a window nobody answered, for both answers, and for a window over the limit that was taken', () => {
    expect(quotaRefusalsReported(answered(() => {})).violations[0]?.message).toMatch(/no answer/);
    expect(quotaRefusalsReported(answered(b => b.receive(2, 'journal_refused', { sessionKey: 'p:s', generation: 1, sequence: 1, reason: 'quota_exceeded' }).receive(3, 'journal_ack', { sessionKey: 'p:s', generation: 1, watermark: 1 }))).violations[0]?.message).toMatch(/refused and acknowledged/);
    expect(quotaRefusalsReported(answered(b => b.receive(2, 'journal_ack', { sessionKey: 'p:s', generation: 1, watermark: 1 })), { sessionBytes: 1024 }).violations[0]?.message).toMatch(/taken by a session limited/);
  });
  it('ignores an answer for another generation and is not exercised without a window', () => {
    expect(quotaRefusalsReported(answered(b => b.receive(2, 'journal_ack', { sessionKey: 'p:s', generation: 2, watermark: 1 }))).status).toBe('failed');
    expect(quotaRefusalsReported(transcript().build()).status).toBe('not_exercised');
  });
});
