// Turns the result files of local-baselines.mjs into one table per target and a verdict per criterion:
//   node packages/agent-remote-lab/performance/summarize-p1d.mjs .tmp/s4
// It reads `<dir>/<arm>-<condition>.json` for the arms control, s4a, s4a-crude, s4b and s4b-crude and the conditions 1x, 4x, rtt100 and 4x-rtt100,
// and prints the P0 figure beside them. A sample of a journal arm that was not served from the Relay's journal is excluded from
// every statistic; the crude arm keeps every sample and reports the ones that were journal-served nevertheless.
// A cell states a percentile only from 20 samples (10 for the conditions that restart the instance for every sample); with
// fewer it states the maximum and the count.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { reportable } from './journal-measurement.mjs';

export const ARMS = ['control', 's4a', 's4a-crude', 's4b', 's4b-crude'];
export const CONDITIONS = [['1x', 'no emulation'], ['4x', '4x CPU'], ['rtt100', '100 ms round trip'], ['4x-rtt100', '4x CPU and 100 ms round trip']];
const cell = value => value === null || value === undefined ? 'n/a' : String(value);

/** The samples that count for an arm: journal arms use only journal-served samples, the crude arm uses all of them. */
export function usable(arm, samples) {
  return arm.endsWith('-crude') ? samples : samples.filter(sample => sample.journalServed === true);
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

/**
 * The draft survived: the same text and selection. Focus is reported apart: the editor is disabled while the session reconnects (it is
 * read-only until the session is taken again), and a disabled editor loses focus whatever a replacement does.
 */
export function composerKept(sample) {
  const { composerBefore: before, composerAfter: after } = sample;
  if (!before || !after) return sample.composerUnchanged === true;
  return before.text === after.text && before.selectionStart === after.selectionStart && before.selectionEnd === after.selectionEnd;
}

/** T6, forced replacement: rekeyed rows, row-less states, composer and anchor, over the samples in which a replacement happened. */
export function replacementResult(samples) {
  const forced = samples.filter(sample => sample.replacementForced === true);
  const survival = rowSurvival(forced);
  const anchored = forced.filter(sample => sample.anchorKey !== null && (sample.wheelIntent === true || sample.anchorSurvived === false));
  return { ...survival, forced: forced.length, composerChanged: forced.filter(sample => !composerKept(sample)).length,
    focusLost: forced.filter(sample => sample.composerBefore?.focused === true && sample.composerAfter?.focused === false).length,
    anchorLost: anchored.filter(sample => !sample.anchorSurvived).length, anchorShiftMaxPx: Math.max(0, ...anchored.map(sample => sample.anchorShiftPx ?? 0)),
    pass: forced.length > 0 && survival.rekeyed === 0 && survival.rowlessMax === 0 && forced.every(composerKept)
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

  // Every run of the scenario counts for rows and draft; the reading position only from samples that scrolled with a wheel event,
  // the way a reader does (an earlier run scrolled by setting scrollTop, which leaves the timeline following the latest content).
  const forced = valid.map(entry => {
    const names = Object.keys(entry.run.scenarios ?? {}).filter(name => name.startsWith('replacement-absorbed'));
    const all = names.flatMap(name => scenario(entry, name)?.samples ?? []);
    return { entry, used: names.length ? { all, kept: usable(entry.arm, all) } : undefined };
  }).filter(item => item.used);
  table('T6: a forced replacement (the Relay recorded a `changed` or `open_item` window; other samples are not counted)', ['Arm', 'Condition', 'Samples (forced/used/all)', 'Rows marked', 'Rows re-keyed', 'Row-less states (max)', 'Draft changed', 'Focus lost (editor disabled while reconnecting)', 'Anchor lost', 'Anchor shift max (px)', 'Verdict'],
    // The crude path has no journal windows to name a replacement: every restart replaces the Controller's own epoch, so every sample counts.
    forced.map(({ entry, used: own }) => { const result = replacementResult(entry.arm.endsWith('-crude') ? own.kept.map(sample => ({ ...sample, replacementForced: true })) : own.kept); return [entry.arm, entry.name, `${result.forced}/${own.kept.length}/${own.all.length}`, result.rows, result.rekeyed, result.rowlessMax, result.composerChanged, result.focusLost, result.anchorLost, result.anchorShiftMaxPx, result.forced ? verdictOf(result.pass) : 'no replacement forced']; }));

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
  const p0Known = condition => p0(condition === '4x' ? 'p0-local-4x.json' : 'p0-local-1x-a.json')?.scenarios?.['open-known']?.reload;
  if (opens.length) {
    table('T1: a conversation opened before (reloads; criterion 0 opening-label states, 0 row-less states, content within 100 ms p95 at 4x CPU)', ['Arm', 'Condition', 'Samples used', 'Content since mount, ms', 'Content since navigation, ms', 'Opening-label states (max)', 'Opening-word states (max)', 'Row-less states since mount (max)'],
      [['P0', 'no emulation', cell(p0Known('1x')?.contentMs?.n), 'n/a', figure([], 1).replace(/max .*/, `${cell(p0Known('1x')?.contentMs?.p50)} / ${cell(p0Known('1x')?.contentMs?.p95)}`), 'n/a', 'n/a', 'n/a'],
        ['P0', '4x CPU', cell(p0Known('4x')?.contentMs?.n), 'n/a', `${cell(p0Known('4x')?.contentMs?.p50)} / ${cell(p0Known('4x')?.contentMs?.p95)}`, 'n/a', 'n/a', 'n/a'],
        ...opens.map(({ entry, used: own }) => [entry.arm, entry.name, sampleCount(own), figure(own.kept.map(sample => sample.contentSinceMountMs), 10), figure(own.kept.map(sample => sample.contentMs), 10),
          Math.max(0, ...own.kept.map(sample => sample.openingLabelFrames ?? 0)), Math.max(0, ...own.kept.map(sample => sample.openingWordFrames ?? 0)), Math.max(0, ...own.kept.map(sample => sample.rowlessFramesSinceMount ?? 0))])]);
  }

  const fresh = valid.map(entry => ({ entry, used: used(entry, 'open-fresh') })).filter(item => item.used);
  if (fresh.length) {
    const p0Fresh = (file, key) => p0(file)?.scenarios?.['open-fresh']?.summary?.[key];
    table('T2: a conversation opened on a device with no stored content (criterion 500 ms p50 and 1,500 ms p95 at 4x CPU and 100 ms; no slower than the control at p50; at least 20 journal-served samples)', ['Arm', 'Condition', 'Samples used (journal-served/all)', 'Content since navigation, ms (p50 / p95)', 'Content since attach, ms (p50 / p95)'],
      [['P0', '4x CPU', cell(p0Fresh('p0-local-4x.json', 'contentMs')?.n), `${cell(p0Fresh('p0-local-4x.json', 'contentMs')?.p50)} / ${cell(p0Fresh('p0-local-4x.json', 'contentMs')?.p95)}`, 'n/a'],
        ...fresh.map(({ entry, used: own }) => [entry.arm, entry.name, sampleCount(own), figure(own.kept.map(sample => sample.contentMs), 20), figure(own.kept.map(sample => sample.contentSinceAttachMs), 20)])]);
  }

  const returns = valid.flatMap(entry => ['hidden-short', 'hidden-long', 'hidden-dead'].map(name => ({ entry, name, used: used(entry, name) }))).filter(item => item.used);
  if (returns.length) {
    const p0Return = p0('p0-local-1x-a.json')?.scenarios?.['hidden-short']?.summary;
    table('Return: hidden, then shown again (criterion at most 2 HTTP requests while the sockets are alive, 0 opening-label states, current within 1 s p95; a dead socket is recorded without a budget)', ['Arm', 'Condition', 'Scenario', 'Samples used', 'HTTP API requests (min / max)', 'Requests by endpoint (largest sample)', 'Opening-label / word / row-less states (max)', 'Current, ms (p50 / p95)', 'Verdict'],
      [['P0', 'no emulation', 'hidden-short', cell(p0Return?.n), `${cell(p0Return?.httpApi?.p50)} / ${cell(p0Return?.httpApi?.max)}`, '14 on every return (see S4b plan section 4)', 'n/a', 'n/a', 'n/a'],
        ...returns.map(({ entry, name, used: own }) => {
          const counts = own.kept.map(sample => sample.requests?.httpApi).filter(Number.isFinite);
          const largest = [...own.kept].sort((a, b) => (b.requests?.httpApi ?? 0) - (a.requests?.httpApi ?? 0))[0];
          const endpoints = largest ? Object.entries(largest.requests.httpByEndpoint ?? {}).map(([endpoint, count]) => `${endpoint.replace('/u/:user/v1/', '')}${count > 1 ? ' x' + count : ''}`).join(', ') : '';
          const labels = Math.max(0, ...own.kept.map(sample => sample.openingLabelFrames ?? 0)), words = Math.max(0, ...own.kept.map(sample => sample.openingWordFrames ?? 0)), rowless = Math.max(0, ...own.kept.map(sample => sample.rowlessFrames ?? 0));
          const alive = name !== 'hidden-dead';
          return [entry.arm, entry.name, name, sampleCount(own), counts.length ? `${Math.min(...counts)} / ${Math.max(...counts)}` : 'n/a', endpoints || 'n/a', `${labels} / ${words} / ${rowless}`, figure(own.kept.map(sample => sample.currentMs), 10),
            !alive ? 'recorded' : own.kept.length ? verdictOf(Math.max(0, ...counts) <= 2 && labels === 0) : 'no samples'];
        })]);
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: summarize-p1d.mjs <directory of <arm>-<condition>.json files>'); process.exit(2); }
  console.log(summarize(process.argv[2]));
}
