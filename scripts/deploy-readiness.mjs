#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/**
 * Post-deploy readiness of the Relay. Cloudflare propagates the Worker and the Durable Object independently, so a deployment can be
 * live while the Relay object still runs the previous release. The object reports its `workerVersionId` in the diagnostics it
 * delivers to a registered Host; the Relay is ready when an entry written after the deploy names the deployed version.
 *
 * With `code_update_strategy` set to `immediate` in the Wrangler configs the object adopts the deployed code when the deploy completes
 * and a Controller reconnects within seconds, so a wait near the default deadline means the deploy did not apply the strategy
 * (see docs/current/agent-remote/deployment.md, "How a deploy reaches the Relay Durable Object").
 *
 * It only reads: the owner's installed `agent-remote-controller diagnostics --source server`. Entries older than the deploy time are
 * not evidence, whatever version they name.
 *
 *   node scripts/deploy-readiness.mjs --version <workerVersionId> --deployed-at <ISO time> [--deadline-seconds 600]
 *     [--interval-seconds 10] [--limit 50] [--command agent-remote-controller]
 *
 * Exit status 0 when ready (the first fresh entry of the deployed version is printed), 1 at the deadline (what was seen is printed).
 */
const run = promisify(execFile);
const CLI_DEADLINE_MS = 30_000;

/**
 * Polls `readDiagnostics()` (the server entries, as the CLI prints them) until a fresh entry names `workerVersionId`.
 * `now()` is milliseconds since the epoch and `sleep(ms)` waits, so a caller can run it on a fake clock.
 * Resolves `{ ready: true, entry, polls }` or, at the deadline, `{ ready: false, polls, seen, lastError }` where `seen` says what the
 * fresh entries named: `{ fresh, stale, versions }`.
 */
export async function waitForDeployedRelay({ workerVersionId, deployedAt, deadlineMs, intervalMs, readDiagnostics, now = Date.now, sleep }) {
  if (!workerVersionId) throw new Error('A deployed workerVersionId is required.');
  if (!Number.isFinite(deployedAt)) throw new Error('The deploy time must be a valid time.');
  const deadline = now() + deadlineMs;
  let polls = 0, seen = { fresh: 0, stale: 0, versions: {} }, lastError;
  for (;;) {
    polls += 1;
    try {
      const entries = await readDiagnostics();
      lastError = undefined;
      const result = examine(entries, workerVersionId, deployedAt);
      if (result.entry) return { ready: true, entry: result.entry, polls };
      seen = result.seen;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    if (now() + intervalMs > deadline) return { ready: false, polls, seen, lastError };
    await sleep(intervalMs);
  }
}

function examine(entries, workerVersionId, deployedAt) {
  const seen = { fresh: 0, stale: 0, versions: {} };
  let entry;
  for (const candidate of Array.isArray(entries) ? entries : []) {
    const time = Date.parse(candidate?.timestamp);
    if (!Number.isFinite(time) || time < deployedAt) { seen.stale += 1; continue; }
    seen.fresh += 1;
    const version = typeof candidate.workerVersionId === 'string' ? candidate.workerVersionId : 'none';
    seen.versions[version] = (seen.versions[version] ?? 0) + 1;
    if (version === workerVersionId && (!entry || time < Date.parse(entry.timestamp))) entry = candidate;
  }
  return { entry, seen };
}

/** What a failed wait tells the person deploying: what the Relay reported and what that means for the next step. */
export function describeFailure(result, { workerVersionId, deployedAt }) {
  const since = new Date(deployedAt).toISOString();
  const lines = [`The Relay has not reported ${workerVersionId} since ${since} (${result.polls} polls).`];
  const versions = Object.entries(result.seen.versions);
  if (versions.length) lines.push(`Fresh entries name: ${versions.map(([version, count]) => `${version} x${count}`).join(', ')}.`, 'The Durable Object may still run the previous release; wait and run this again before activating a Controller.');
  else if (result.seen.stale) lines.push(`${result.seen.stale} entries, all older than the deploy: no evidence. Is a Host registered and online to deliver diagnostics?`);
  else lines.push('No diagnostics were read. Is a Host registered and online to deliver diagnostics?');
  if (result.lastError) lines.push(`The last read failed: ${result.lastError}`);
  return lines.join('\n');
}

/** Reads the server diagnostics through the installed CLI, read-only. */
export function cliDiagnostics({ command, limit, deployedAt, exec = run }) {
  return async () => {
    const args = ['diagnostics', '--source', 'server', '--since', new Date(deployedAt).toISOString(), '--limit', String(limit)];
    const { stdout } = await exec(command, args, { timeout: CLI_DEADLINE_MS, maxBuffer: 16 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed?.server)) throw new Error('The diagnostics output has no server entries.');
    return parsed.server;
  };
}

export function parseArguments(argv) {
  const options = { command: 'agent-remote-controller', deadlineSeconds: 600, intervalSeconds: 10, limit: 50 };
  const names = { '--version': 'version', '--deployed-at': 'deployedAt', '--deadline-seconds': 'deadlineSeconds', '--interval-seconds': 'intervalSeconds', '--limit': 'limit', '--command': 'command' };
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]], value = argv[index + 1];
    if (!name || value === undefined) throw new Error(`Unknown or incomplete option: ${argv[index]}`);
    options[name] = ['deadlineSeconds', 'intervalSeconds', 'limit'].includes(name) ? Number(value) : value;
  }
  const deployedAt = Date.parse(options.deployedAt);
  if (!options.version || !Number.isFinite(deployedAt)) throw new Error('Usage: deploy-readiness.mjs --version ID --deployed-at ISO [--deadline-seconds N] [--interval-seconds N] [--limit 1..1000] [--command PATH]');
  if (!(options.deadlineSeconds > 0) || !(options.intervalSeconds > 0) || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) throw new Error('Deadline and interval must be positive; limit must be 1 to 1000.');
  return { ...options, deployedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  const result = await waitForDeployedRelay({
    workerVersionId: options.version, deployedAt: options.deployedAt, deadlineMs: options.deadlineSeconds * 1000, intervalMs: options.intervalSeconds * 1000,
    readDiagnostics: cliDiagnostics(options), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (result.ready) { console.log(`The Durable Object reported ${options.version} at ${result.entry.timestamp} (event ${result.entry.event}, instance ${result.entry.relayInstanceId}).`); }
  else { console.error(describeFailure(result, { workerVersionId: options.version, deployedAt: options.deployedAt })); process.exit(1); }
}
