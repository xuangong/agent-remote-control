import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliDiagnostics, describeFailure, parseArguments, waitForDeployedRelay } from './deploy-readiness.mjs';

const DEPLOYED = Date.parse('2026-11-22T10:00:00Z');
const entry = (secondsAfterDeploy, workerVersionId, event = 'host_registered') => ({
  id: `d${secondsAfterDeploy}`, timestamp: new Date(DEPLOYED + secondsAfterDeploy * 1000).toISOString(), source: 'relay', hostId: 'h', relayInstanceId: 'r1', event, ...(workerVersionId ? { workerVersionId } : {}),
});

/** A clock that only moves when the wait sleeps, and a reader that answers each poll from a script. */
function harness(polls) {
  let time = DEPLOYED, reads = 0;
  const sleeps = [];
  return {
    sleeps, reads: () => reads,
    wait: (overrides = {}) => waitForDeployedRelay({
      workerVersionId: 'new', deployedAt: DEPLOYED, deadlineMs: 60_000, intervalMs: 10_000, now: () => time,
      sleep: async (ms) => { sleeps.push(ms); time += ms; },
      readDiagnostics: async () => { const poll = polls[Math.min(reads++, polls.length - 1)]; if (poll instanceof Error) throw poll; return poll; },
      ...overrides,
    }),
  };
}

test('is ready at once when a fresh entry names the deployed version, and returns the first such entry', async () => {
  const h = harness([[entry(-30, 'old'), entry(20, 'new', 'stream_ready'), entry(5, 'new')]]);
  const result = await h.wait();
  assert.equal(result.ready, true);
  assert.equal(result.entry.id, 'd5');
  assert.equal(result.polls, 1);
  assert.deepEqual(h.sleeps, []);
});

test('keeps polling while fresh entries still name the previous version, and is ready once the new one reports', async () => {
  const h = harness([[entry(2, 'old')], [entry(2, 'old'), entry(12, 'old')], [entry(2, 'old'), entry(25, 'new')]]);
  const result = await h.wait();
  assert.equal(result.ready, true);
  assert.equal(result.polls, 3);
  assert.deepEqual(h.sleeps, [10_000, 10_000]);
});

test('does not take an entry older than the deploy for evidence, even one naming the deployed version', async () => {
  const h = harness([[entry(-5, 'new'), entry(-60, 'new')]]);
  const result = await h.wait();
  assert.equal(result.ready, false);
  assert.equal(result.seen.stale, 2);
  assert.equal(result.seen.fresh, 0);
  assert.match(describeFailure(result, { workerVersionId: 'new', deployedAt: DEPLOYED }), /older than the deploy: no evidence/);
});

test('fails at the deadline and says the fresh entries are still on the previous version', async () => {
  const h = harness([[entry(3, 'old'), entry(8, 'old'), entry(9)]]);
  const result = await h.wait();
  assert.equal(result.ready, false);
  assert.deepEqual(result.seen.versions, { old: 2, none: 1 });
  assert.equal(h.sleeps.reduce((sum, ms) => sum + ms, 0), 60_000);
  const text = describeFailure(result, { workerVersionId: 'new', deployedAt: DEPLOYED });
  assert.match(text, /has not reported new since 2026-11-22T10:00:00.000Z/);
  assert.match(text, /old x2, none x1/);
  assert.match(text, /previous release/);
});

test('fails with a hint when nothing was read, and reports a read that failed without giving up early', async () => {
  const empty = await harness([[]]).wait();
  assert.match(describeFailure(empty, { workerVersionId: 'new', deployedAt: DEPLOYED }), /No diagnostics were read/);
  const h = harness([new Error('spawn agent-remote-controller ENOENT'), new Error('spawn agent-remote-controller ENOENT')]);
  const failed = await h.wait();
  assert.equal(failed.ready, false);
  assert.equal(failed.polls, 7);
  assert.match(describeFailure(failed, { workerVersionId: 'new', deployedAt: DEPLOYED }), /last read failed: spawn agent-remote-controller ENOENT/);
});

test('recovers from a failed read', async () => {
  const result = await harness([new Error('timeout'), [entry(4, 'new')]]).wait();
  assert.equal(result.ready, true);
  assert.equal(result.polls, 2);
});

test('refuses a missing version or an invalid deploy time', async () => {
  await assert.rejects(harness([[]]).wait({ workerVersionId: '' }), /workerVersionId is required/);
  await assert.rejects(harness([[]]).wait({ deployedAt: Number.NaN }), /valid time/);
});

test('reads through the CLI read-only, from the deploy time, and takes the server entries of its output', async () => {
  const calls = [];
  const exec = async (command, args, options) => { calls.push({ command, args, timeout: options.timeout }); return { stdout: JSON.stringify({ server: [entry(1, 'new')] }) }; };
  const entries = await cliDiagnostics({ command: 'agent-remote-controller', limit: 50, deployedAt: DEPLOYED, exec })();
  assert.equal(entries.length, 1);
  assert.deepEqual(calls, [{ command: 'agent-remote-controller', args: ['diagnostics', '--source', 'server', '--since', '2026-11-22T10:00:00.000Z', '--limit', '50'], timeout: 30_000 }]);
  await assert.rejects(cliDiagnostics({ command: 'x', limit: 1, deployedAt: DEPLOYED, exec: async () => ({ stdout: '{}' }) })(), /no server entries/);
});

test('parses its arguments and refuses incomplete ones', () => {
  const options = parseArguments(['--version', 'abc', '--deployed-at', '2026-11-22T10:00:00Z', '--deadline-seconds', '300']);
  assert.deepEqual({ ...options }, { command: 'agent-remote-controller', deadlineSeconds: 300, intervalSeconds: 10, limit: 50, version: 'abc', deployedAt: DEPLOYED });
  assert.throws(() => parseArguments(['--version', 'abc']), /Usage/);
  assert.throws(() => parseArguments(['--version', 'abc', '--deployed-at', 'soon']), /Usage/);
  assert.throws(() => parseArguments(['--bogus', '1']), /Unknown/);
  assert.throws(() => parseArguments(['--version', 'abc', '--deployed-at', '2026-11-22T10:00:00Z', '--limit', '0']), /limit/);
});
