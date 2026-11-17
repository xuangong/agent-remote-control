/**
 * The tier a Vitest test file belongs to, from its name and Vitest project: the suffixes of section 5.1 of the target architecture
 * (`.contract`, `.integration`, `.transport`, `.process`, `.workers`, `.local`). Every other Vitest file is a unit test.
 */
export function tierOf(file, project) {
  if (/\.local\.test\.tsx?$/.test(file)) return 'native';
  if (project === 'process' || /\.process\.test\.tsx?$/.test(file)) return 'process';
  const suffixed = /\.(contract|integration|transport|workers)\.test\.tsx?$/.exec(file);
  if (suffixed) return suffixed[1];
  if (/\.browser\.ts$/.test(file)) return 'browser';
  return 'unit';
}

/** Tiers whose tests use real processes, browsers or CLIs; the speed rule for mock-data tests does not apply to them. */
export const realStackTiers = new Set(['native', 'process', 'browser', 'transport', 'workers']);

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
