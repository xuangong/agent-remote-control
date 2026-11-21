import { describe, expect, it } from 'vitest';
import { DIVERGENCE_QUIET_MS, divergedByContent, mayReleaseDiverged } from './transcript-divergence.js';

/** What the resident runtime holds: two loaded rows and its own turn. */
const held = ['base-user', 'base-reply', 'page-user', 'page-reply'];

describe('a transcript decided by its content (D1, D2)', () => {
  it.each([
    ['the transcript ends with the resident runtime\'s last record and holds nothing else', held, false],
    ['the transcript is a suffix of what the runtime holds, as after a compaction it wrote itself', ['page-user', 'page-reply'], false],
    ['a terminal\'s turn follows the runtime\'s last record', [...held, 'term-user', 'term-reply'], true],
    ['a terminal forked the transcript and its branch was written last (O49)', ['base-user', 'base-reply', 'term-user', 'term-reply'], true],
    ['the transcript ends at an older record of the runtime', ['base-user', 'base-reply', 'page-user'], true],
    ['a record the runtime never read sits before its last one', ['base-user', 'other', 'base-reply', 'page-user', 'page-reply'], true],
  ])('%s: diverged %s', (_name, transcript, expected) => {
    expect(divergedByContent(held, transcript)).toBe(expected);
  });
  it('is not diverged for a session neither side has written yet', () => {
    expect(divergedByContent([], [])).toBe(false);
  });
});

describe('a diverged session is released (D3)', () => {
  const nativeUpdatedAt = 1_000_000;
  it.each([
    [DIVERGENCE_QUIET_MS - 1, false], [DIVERGENCE_QUIET_MS, true], [DIVERGENCE_QUIET_MS + 1, true],
  ])('%i ms after the transcript went quiet: %s', (quietFor, expected) => {
    expect(mayReleaseDiverged({ quiet: true, diverged: true, nativeUpdatedAt }, nativeUpdatedAt + quietFor)).toBe(expected);
  });
  it('never while something runs for it, when it did not diverge, or when the transcript\'s update time is unknown', () => {
    const later = nativeUpdatedAt + DIVERGENCE_QUIET_MS;
    expect(mayReleaseDiverged({ quiet: false, diverged: true, nativeUpdatedAt }, later)).toBe(false);
    expect(mayReleaseDiverged({ quiet: true, diverged: false, nativeUpdatedAt }, later)).toBe(false);
    expect(mayReleaseDiverged({ quiet: true, diverged: true, nativeUpdatedAt: undefined }, later)).toBe(false);
  });
});
