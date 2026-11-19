import { describe, expect, it } from 'vitest';
import { findingsFromFailures, knownInvariants } from './findings.js';
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
      invariants.leaseFollowsNativeOwner([]), invariants.noLostOrDoubledMessage(empty, []), invariants.takeOverWorks([]),
      invariants.terminalRowsAppear([]), invariants.catchUpCostsOneTailRequest([]), invariants.draftAndPositionKept(empty),
    ].map(item => item.invariant);
    expect(reported.filter(name => !knownInvariants.includes(name))).toEqual([]);
    expect(knownInvariants.filter(name => !reported.includes(name))).toEqual([]);
  });
});
