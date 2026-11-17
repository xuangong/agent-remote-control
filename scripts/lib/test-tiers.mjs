/**
 * The tier a Vitest test file belongs to today, from its name and Vitest project. Until the migration adds the
 * contract, integration and transport suffixes, every other Vitest file is a unit test.
 */
export function tierOf(file, project) {
  if (/\.local\.test\.tsx?$/.test(file)) return 'native';
  if (project === 'process' || /\.process\.test\.tsx?$/.test(file)) return 'process';
  if (/\.browser\.ts$/.test(file)) return 'browser';
  return 'unit';
}

/** Tiers whose tests use real processes, browsers or CLIs; the speed rule for mock-data tests does not apply to them. */
export const realStackTiers = new Set(['native', 'process', 'browser']);

/** Counts per tier from measured tests `{ tier, durationMs }`: tests, over 300 ms and over 1 s. */
export function countTiers(measured, warnMs = 300, failMs = 1000) {
  const tiers = {};
  for (const { tier, durationMs } of measured) {
    const tally = tiers[tier] ??= { tests: 0, over300ms: 0, over1s: 0 };
    tally.tests += 1;
    if (durationMs > warnMs) tally.over300ms += 1;
    if (durationMs > failMs) tally.over1s += 1;
  }
  return tiers;
}
