// `pnpm smoke [scenario ...] [--seed N] [--quick] [--rounds N]`: runs the smoke scenarios against this checkout's local instance
// and writes `.arc-local/smoke/<date>/report.json`, `summary.txt` and the wire transcripts. It reports; it never gates a task.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { findingsFromFailures } from './findings.js';
import { createRunContext } from './lib/run-context.js';
import { scenarioStatus, summarize, writeReport, type RunReport, type ScenarioReport } from './report.js';
import { deferredScenarios, scenarios } from './scenarios/index.js';

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const quick = args.includes('--quick');
const seed = Number(option('--seed') ?? Date.now() % 100_000);
const named = args.filter((arg, at) => !arg.startsWith('--') && !['--seed', '--out', '--rounds', '--condition'].includes(args[at - 1] ?? ''));
const checkout = resolve(process.cwd());
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDirectory = resolve(option('--out') ?? join(checkout, '.arc-local/smoke', stamp));
const log = (message: string) => process.stderr.write(`[smoke ${new Date().toISOString().slice(11, 19)}] ${message}\n`);

const selected = named.length > 0 ? scenarios.filter(item => named.includes(item.id)) : quick ? scenarios.filter(item => item.quick) : scenarios;
if (named.length > 0 && selected.length === 0 && !deferredScenarios.some(item => named.includes(item.id))) throw new Error(`No scenario matches ${named.join(', ')}.`);

const scenarioDeadlineMs = (quick ? 8 : 40) * 60_000;
const withDeadline = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
};
const outerDeadlineMs = (quick ? 15 : 90) * 60_000;
const timer = setTimeout(() => { log(`outer deadline of ${outerDeadlineMs / 60_000} minutes reached`); process.exit(2); }, outerDeadlineMs);
timer.unref();

const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { cwd: checkout, encoding: 'utf8' }).trim();
const { context, close } = await createRunContext({ checkout, seed, quick, runDirectory, log });
const info = JSON.parse(execFileSync('agent-remote-controller-dev', ['--build-info'], { cwd: checkout, encoding: 'utf8' }));
const run: RunReport = { format: 'arc-smoke-report-1', startedAt: new Date().toISOString(), mode: quick ? 'quick' : 'full', commit: git('rev-parse', '--short=12', 'HEAD'),
  build: `running ${String(info.build?.revision).slice(0, 12)}${info.build?.dirty ? ' (dirty)' : ''}`, node: process.version, scenarios: [], sessions: [] };
const transcripts: Record<string, string> = {};
try {
  for (const scenario of selected) {
    log(`${scenario.id} ${scenario.title}: start`);
    const started = Date.now();
    const base = { scenario: scenario.id, title: scenario.title, seed, startedAt: new Date(started).toISOString(), schedule: [], measurements: {}, invariants: [], findings: [] };
    let report: ScenarioReport;
    try {
      const outcome = await withDeadline(scenario.run(context), scenarioDeadlineMs, `${scenario.id} exceeded its ${scenarioDeadlineMs / 60_000} minute deadline`);
      const transcriptName = outcome.transcript ? `${scenario.id}.transcript.jsonl` : undefined;
      if (outcome.transcript && transcriptName) transcripts[transcriptName] = outcome.transcript.toJsonLines();
      report = { ...base, status: scenarioStatus(outcome.invariants), durationMs: Date.now() - started, schedule: outcome.schedule, measurements: outcome.measurements, invariants: outcome.invariants,
        ...(transcriptName ? { transcript: transcriptName } : {}), findings: [...findingsFromFailures(scenario.id, seed, outcome.invariants, transcriptName), ...(outcome.findings ?? [])], ...(outcome.note ? { note: outcome.note } : {}) };
    } catch (error) {
      report = { ...base, status: 'errored', durationMs: Date.now() - started, note: (error as Error).stack?.split('\n').slice(0, 4).join(' | ') ?? String(error) };
    }
    run.scenarios.push(report);
    log(`${scenario.id}: ${report.status} in ${Math.round(report.durationMs / 1000)} s`);
  }
  for (const item of deferredScenarios) {
    if (quick || (named.length > 0 && !named.includes(item.id))) continue;
    run.scenarios.push({ scenario: item.id, title: item.title, status: 'deferred', seed, startedAt: new Date().toISOString(), durationMs: 0, schedule: [], measurements: {}, invariants: [], findings: [], note: item.reason });
  }
} finally {
  await close();
  run.sessions = context.pool.sessions.map(session => ({ address: session.address, provider: session.provider, released: session.provider !== 'codex' || session.released }));
  const path = writeReport(runDirectory, run, transcripts);
  process.stdout.write(summarize(run));
  log(`report written to ${path}`);
}
process.exitCode = run.scenarios.some(item => item.status === 'errored') ? 1 : 0;
