// Turns the result files of local-baselines.mjs into one table per target and a verdict per criterion:
//   node packages/agent-remote-lab/performance/summarize-p1d.mjs .tmp/s4
// It reads `<dir>/<arm>-<condition>.json` for the arms control, s4a and s4a-crude and the conditions 1x, 4x, rtt100 and 4x-rtt100,
// and prints the P0 figure beside them. A sample of a journal arm that was not served from the Relay's journal is excluded from
// every statistic; the crude arm keeps every sample and reports the ones that were journal-served nevertheless.
// A cell states a percentile only from 20 samples (10 for the conditions that restart the instance for every sample); with
// fewer it states the maximum and the count.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { reportable } from './journal-measurement.mjs';

export const ARMS = ['control', 's4a', 's4a-crude'];
export const CONDITIONS = [['1x', 'no emulation'], ['4x', '4x CPU'], ['rtt100', '100 ms round trip'], ['4x-rtt100', '4x CPU and 100 ms round trip']];
const cell = value => value === null || value === undefined ? 'n/a' : String(value);

/** The samples that count for an arm: journal arms use only journal-served samples, the crude arm uses all of them. */
export function usable(arm, samples) {
  return arm === 's4a-crude' ? samples : samples.filter(sample => sample.journalServed === true);
}

/** A statistic as a table cell: the percentiles from the minimum count, the maximum and the count below it. */
export function figure(values, minimum) {
  const own = reportable(values.filter(Number.isFinite), minimum);
  return own.p50 === null ? `max ${cell(own.max)} (n=${own.n})` : `${own.p50} / ${own.p95} (n=${own.n})`;
}

/** T6, restart and release: row nodes that left the document, and states without rows, over the usable samples. */
export function rowSurvival(samples) {
  const total = samples.reduce((sum, sample) => sum + (sample.rows?.total ?? 0), 0);
  const alive = samples.reduce((sum, sample) => sum + (sample.rows?.alive ?? 0), 0);
  return { n: samples.length, rows: total, rekeyed: total - alive, rowlessMax: Math.max(0, ...samples.map(sample => sample.rowlessStates ?? 0)) };
}

/** T6, forced replacement: rekeyed rows, row-less states, composer and anchor, over the samples in which a replacement happened. */
export function replacementResult(samples) {
  const forced = samples.filter(sample => sample.replacementForced === true);
  const survival = rowSurvival(forced);
  const anchored = forced.filter(sample => sample.anchorKey !== null);
  return { ...survival, forced: forced.length, composerChanged: forced.filter(sample => !sample.composerUnchanged).length,
    anchorLost: anchored.filter(sample => !sample.anchorSurvived).length, anchorShiftMaxPx: Math.max(0, ...anchored.map(sample => sample.anchorShiftPx ?? 0)),
    pass: forced.length > 0 && survival.rekeyed === 0 && survival.rowlessMax === 0 && forced.every(sample => sample.composerUnchanged)
      && anchored.every(sample => sample.anchorSurvived && (sample.anchorShiftPx ?? Infinity) <= 1) };
}

const verdictOf = pass => pass ? 'pass' : 'miss';

export function summarize(dir, p0Dir = join(dirname(fileURLToPath(import.meta.url)), 'results')) {
  const load = (arm, condition) => {
    const file = join(dir, `${arm}-${condition}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  };
  const p0 = name => { const file = join(p0Dir, name); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; };
  const lines = [];
  const table = (title, header, rows) => {
    lines.push(`### ${title}`, '', `| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`), '');
  };
  const runs = [];
  for (const arm of ARMS) for (const [condition, name] of CONDITIONS) {
    const run = load(arm, condition);
    if (run) runs.push({ arm, condition, name, run });
  }
  const invalid = runs.filter(({ run }) => run.invalid);
  if (invalid.length) lines.push(`**Invalid runs, excluded from every table and verdict:** ${invalid.map(({ arm, condition, run }) => `${arm}/${condition}: ${run.invalid}`).join('; ')}`, '');
  const valid = runs.filter(({ run }) => !run.invalid);
  const scenario = (entry, name) => entry.run.scenarios?.[name];
  const used = (entry, name) => { const all = scenario(entry, name)?.samples; return all ? { all, kept: usable(entry.arm, all) } : undefined; };
  const sampleCount = ({ all, kept }) => `${kept.length}/${all.length}`;

  const p0Restart = p0('p0-local-restart.json')?.scenarios?.['restart-continuity']?.samples;
  const p0Text = p0Restart ? `${p0Restart.filter(sample => sample.markedEntryStillInDocument === false).length} of ${p0Restart.length} sessions lost the marked row; ${p0Restart.reduce((sum, sample) => sum + (sample.blankMoments ?? 0), 0)} row-less states` : 'n/a';

  const restart = valid.map(entry => ({ entry, used: used(entry, 'restart-continuity') })).filter(item => item.used);
  table('T6: the open conversation across a Controller and Relay restart', ['Arm', 'Condition', 'Samples used', 'Rows marked', 'Rows re-keyed', 'Row-less states (max)', 'Verdict (0 and 0)'],
    [['P0 (marks the first row only)', 'no emulation', 'n/a', 'n/a', p0Text, 'n/a', 'n/a'],
      ...restart.map(({ entry, used: own }) => { const result = rowSurvival(own.kept); return [entry.arm, entry.name, sampleCount(own), result.rows, result.rekeyed, result.rowlessMax, own.kept.length ? verdictOf(result.rekeyed === 0 && result.rowlessMax === 0) : 'no samples']; })]);

  const forced = valid.map(entry => ({ entry, used: used(entry, 'replacement-absorbed') })).filter(item => item.used);
  table('T6: a forced replacement (the Relay recorded a `changed` or `open_item` window; other samples are not counted)', ['Arm', 'Condition', 'Samples (forced/used/all)', 'Rows marked', 'Rows re-keyed', 'Row-less states (max)', 'Composer changed', 'Anchor lost', 'Anchor shift max (px)', 'Verdict'],
    forced.map(({ entry, used: own }) => { const result = replacementResult(own.kept); return [entry.arm, entry.name, `${result.forced}/${own.kept.length}/${own.all.length}`, result.rows, result.rekeyed, result.rowlessMax, result.composerChanged, result.anchorLost, result.anchorShiftMaxPx, result.forced ? verdictOf(result.pass) : 'no replacement forced']; }));

  const release = valid.map(entry => ({ entry, used: used(entry, 'runtime-release') ?? used(entry, 'release-continuity') })).filter(item => item.used);
  table('T6: a runtime release', ['Arm', 'Condition', 'Samples used', 'Rows marked', 'Rows re-keyed', 'Row-less states (max)', 'Verdict'],
    release.map(({ entry, used: own }) => { const result = rowSurvival(own.kept); return [entry.arm, entry.name, sampleCount(own), result.rows, result.rekeyed, result.rowlessMax, own.kept.length ? verdictOf(result.rekeyed === 0 && result.rowlessMax === 0) : 'no samples']; }));

  const p0Switch = p0('p0-local-switch.json')?.scenarios?.switch;
  const switches = valid.map(entry => ({ entry, own: scenario(entry, 'switch')?.switch })).filter(item => item.own);
  table('Switch time (median of the switches of one run; below the 20-sample minimum for a percentile)', ['Arm', 'Condition', 'Cold ms', 'Warm ms', 'HTTP API requests (cold / warm)', 'Opening-label states (cold / warm)', 'Row-less states (cold / warm)', 'Verdict (warm no slower than cold)'],
    [['P0', 'no emulation', cell(p0Switch?.normal?.cold?.shownMs), cell(p0Switch?.normal?.warm?.shownMs), 'n/a', 'n/a', 'n/a', 'n/a'],
      ['P0', '4x CPU', cell(p0Switch?.throttled4x?.cold?.shownMs), cell(p0Switch?.throttled4x?.warm?.shownMs), 'n/a', 'n/a', 'n/a', 'n/a'],
      ...switches.map(({ entry, own }) => [entry.arm, entry.name, own.cold.shownMs, own.warm.shownMs, `${cell(own.cold.httpApi)} / ${cell(own.warm.httpApi)}`, `${cell(own.cold.openingStates)} / ${cell(own.warm.openingStates)}`, `${cell(own.cold.rowlessStates)} / ${cell(own.warm.rowlessStates)}`, verdictOf(own.warm.shownMs <= own.cold.shownMs)])]);

  const opens = valid.map(entry => ({ entry, used: used(entry, 'open-known') })).filter(item => item.used);
  if (opens.length) {
    table('T1: a conversation opened before (reloads)', ['Arm', 'Condition', 'Samples used', 'Content since mount, ms', 'Content since attach, ms', 'Opening-label states (max)', 'Row-less states since mount (max)'],
      opens.map(({ entry, used: own }) => [entry.arm, entry.name, sampleCount(own), figure(own.kept.map(sample => sample.contentSinceMountMs), 20), figure(own.kept.map(sample => sample.contentSinceAttachMs), 20),
        Math.max(0, ...own.kept.map(sample => sample.openingLabelFrames ?? 0)), Math.max(0, ...own.kept.map(sample => sample.rowlessFramesSinceMount ?? 0))]));
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: summarize-p1d.mjs <directory of <arm>-<condition>.json files>'); process.exit(2); }
  console.log(summarize(process.argv[2]));
}
