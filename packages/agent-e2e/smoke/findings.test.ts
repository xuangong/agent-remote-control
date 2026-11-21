import { describe, expect, it } from 'vitest';
import { findingsFromFailures, firstViolation, knownInvariants } from './findings.js';
import { transcript } from './invariants/builders.js';
import { result } from './invariants/types.js';
import * as invariants from './invariants/index.js';

describe('findings from failed invariants', () => {
  it('writes one finding per failure with the seed, transcript and the two tests it should become', () => {
    const findings = findingsFromFailures('M2', 5, [result('journal-sequences-contiguous', 9, [{ message: 'epoch e: sequence 8 followed 5' }, { message: 'x' }]), result('no-blank-frame', 4, [])], 'M2.transcript.jsonl');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: 'M2-journal-sequences-contiguous', evidence: 'scenario M2, seed 5, transcript M2.transcript.jsonl' });
    expect(findings[0]?.summary).toContain('and 1 more');
    expect(findings[0]?.candidateTests[0]).toContain('seam S3');
  });
  it('knows an owner for every invariant the library can report', () => {
    const empty = { samples: [], paints: [], rowKeys: [], finalRows: [] };
    const reported = [
      invariants.firstPaintFromDeviceStore(empty), invariants.messagesSettleOnce([]), invariants.noDuplicateItemKey([], empty),
      invariants.journalSequencesContiguous([]), invariants.oneReplacementPerRestart([]), invariants.turnRowsCompleteAfterReturn(empty, []),
      invariants.noBlankFrame(empty), invariants.noSessionConnectionLabel(empty), invariants.halfOpenSocketRecovers([]), invariants.trimReported([]), invariants.liveOnlyItemsSurvive(empty, []),
      invariants.noRefusedRowHole([]), invariants.subscriptionsWithinBudget([], 1), invariants.unchangedRowsNotRerendered(empty),
      invariants.memoryFlat(empty), invariants.rowCountsStable(empty), invariants.socketCountsStable(empty),
      invariants.noLostOrDoubledMessage([]), invariants.everyWriterSends([]), invariants.terminalRowsAppear([]), invariants.stateAndPropertiesMatch([]), invariants.pageStaysLiveWhenCodexRefuses([]),
      invariants.catchUpCostsOneTailRequest([]), invariants.draftAndPositionKept(empty),
    ].map(item => item.invariant);
    expect(reported.filter(name => !knownInvariants.includes(name))).toEqual([]);
    expect(knownInvariants.filter(name => !reported.includes(name))).toEqual([]);
  });
});

describe('the first violation of a failed invariant', () => {
  const schedule = [{ t: 100, action: 'controller-restart', detail: { round: 1 } }, { t: 900, action: 'controller-restart', detail: { round: 2 } }];
  const entries = transcript().marker(50, 'turn-sent').receive(120, 'negotiated').receive(950, 'negotiated').receive(990, 'timeline_page').receive(1500, 'agent_stream').build();
  it('names the step that was running, the entries that replay it and its context', () => {
    expect(firstViolation({ message: 'gap', at: 1000, detail: { epoch: 'e', seq: 7 } }, { schedule, entries })).toEqual({
      message: 'gap', at: 1000, step: schedule[1], window: { from: 3, to: 4 }, detail: { epoch: 'e', seq: 7 } });
  });
  it('says only the message when the violation has no time', () => {
    expect(firstViolation({ message: 'lost' }, { schedule, entries })).toEqual({ message: 'lost' });
  });
  it('is the earliest violation of the finding, and the evidence says its step and entries', () => {
    const [finding] = findingsFromFailures('M2', 7, [result('journal-sequences-contiguous', 3, [{ message: 'late', at: 1400 }, { message: 'early', at: 960 }])], 'M2.transcript.jsonl', { schedule, entries });
    expect(finding?.firstViolation).toMatchObject({ message: 'early', at: 960, step: { t: 900 } });
    expect(finding?.evidence).toBe('scenario M2, seed 7, transcript M2.transcript.jsonl, step controller-restart at t=900 ms, entries 3 to 3');
  });
});
