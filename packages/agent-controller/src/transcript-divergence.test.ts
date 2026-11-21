import { describe, expect, it } from 'vitest';
import { DIVERGENCE_QUIET_MS, DIVERGENCE_TOLERANCE_MS, diverged, mayReleaseDiverged } from './transcript-divergence.js';

const writtenAt = 1_000_000;

describe('a transcript another writer changed', () => {
  it.each([
    [DIVERGENCE_TOLERANCE_MS - 1, false], [DIVERGENCE_TOLERANCE_MS, false], [DIVERGENCE_TOLERANCE_MS + 1, true],
  ])('is diverged %i ms after the last write: %s', (after, expected) => {
    expect(diverged(writtenAt + after, writtenAt)).toBe(expected);
  });
  it('is not diverged without a native update time', () => {
    expect(diverged(undefined, writtenAt)).toBe(false);
  });
  it('misses a terminal turn that ended within the tolerance of the page\'s own turn: the fork of O49', () => {
    // M6, 2026-11-21: the page's turn and a terminal's `claude --resume -p` turn ended about a second apart.
    expect(diverged(writtenAt + 1000, writtenAt)).toBe(false);
  });
});

describe('a diverged session is released', () => {
  const quiet = { quiet: true, writtenAt };
  const native = writtenAt + DIVERGENCE_TOLERANCE_MS + 1;
  it.each([
    [DIVERGENCE_QUIET_MS - 1, false], [DIVERGENCE_QUIET_MS, true], [DIVERGENCE_QUIET_MS + 1, true],
  ])('%i ms after the transcript went quiet: %s', (quietFor, expected) => {
    expect(mayReleaseDiverged(quiet, native, native + quietFor)).toBe(expected);
  });
  it('never while something runs for it, nor when it did not diverge', () => {
    expect(mayReleaseDiverged({ quiet: false, writtenAt }, native, native + DIVERGENCE_QUIET_MS)).toBe(false);
    expect(mayReleaseDiverged(quiet, writtenAt + DIVERGENCE_TOLERANCE_MS, writtenAt + DIVERGENCE_TOLERANCE_MS + DIVERGENCE_QUIET_MS)).toBe(false);
    expect(mayReleaseDiverged(undefined, native, native + DIVERGENCE_QUIET_MS)).toBe(false);
  });
});
