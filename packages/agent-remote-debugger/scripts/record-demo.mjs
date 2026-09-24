#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { open, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Deterministic stdio Agent, real Adapter/Relay/CLI transports, no provider credentials.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const adapter = fileURLToPath(new URL('../src/fixtures/stdio-adapter.mjs', import.meta.url));
const destination = resolve(process.argv[2] ?? 'session.jsonl');
const file = await open(destination, 'wx');
const temporary = await mkdtemp(join(tmpdir(), 'ardb-record-'));
const run = promisify(execFile);
const pause = ms => new Promise(done => setTimeout(done, ms));
let output = ''; let errors = ''; let buffer = ''; let ready;
const child = spawn(process.execPath, [cli, 'server', '--adapter', adapter, '--cwd', temporary, '--jsonl'], { stdio: ['ignore', 'pipe', 'pipe'] });
let writes = Promise.resolve();
const closed = new Promise((done, reject) => { child.once('exit', (code, signal) => done({ code, signal })); child.once('error', reject); });
const deadline = setTimeout(() => child.kill('SIGKILL'), 45000);
child.stdout.on('data', chunk => {
  output += chunk; buffer += chunk;
  writes = writes.then(() => file.write(chunk));
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n'); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try { const record = JSON.parse(line); if (record.kind === 'server_ready') ready = record; } catch { /* Final validation reports damaged output. */ }
  }
});
child.stderr.on('data', chunk => { errors += chunk; });
async function waitFor(predicate) {
  const end = Date.now() + 10000;
  while (!predicate()) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Recorder exited early: ${errors}`);
    if (Date.now() > end) throw new Error('Recording step timed out.');
    await pause(25);
  }
}
async function command(...args) {
  await run(process.execPath, [cli, ...args, '--relay', ready.url, '--origin', ready.url, '--json', '--timeout', '5000'], { timeout: 8000 });
}
try {
  await waitFor(() => ready);
  await pause(800);
  await command('send', ready.agentId, 'Hello! This recording follows a real stdio transport.');
  await waitFor(() => output.includes('STDIO reply: Hello!'));
  await pause(1600);
  await command('settings', 'set', ready.agentId, 'reasoning', 'high');
  await pause(1200);
  await command('send', ready.agentId, 'approve');
  await waitFor(() => output.includes('interaction_requested'));
  await pause(2200);
  const response = join(temporary, 'approval.json');
  await writeFile(response, JSON.stringify({ kind: 'tool_approval', decision: 'allow', scope: 'once' }));
  await command('interaction', 'respond', ready.agentId, 'fixture-approval', '--response-file', response);
  await waitFor(() => output.includes('Approval received'));
  await pause(1600);
  await command('send', ready.agentId, 'hold');
  await pause(1800);
  await command('cancel', ready.agentId);
  await pause(1000);
  await command('send', ready.agentId, 'Replay complete. You can pause, seek, change speed, or restart.');
  await waitFor(() => output.includes('STDIO reply: Replay complete.'));
  await pause(1600);
  child.kill('SIGTERM');
  const result = await closed;
  if (result.code !== 0) throw new Error(`Recorder failed: ${JSON.stringify(result)} ${errors}`);
  await writes;
  const { parseRecording } = await import('../dist/recording.js');
  const recording = parseRecording(output);
  if (recording.warnings.length) throw new Error(recording.warnings.join('\n'));
  console.log(`Recorded ${recording.events.length} events, ${(recording.duration / 1000).toFixed(1)} seconds: ${destination}`);
  console.log(`Replay: node ${JSON.stringify(cli)} replay ${JSON.stringify(destination)} --open`);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await closed; await writes; } finally { clearTimeout(kill); clearTimeout(deadline); await file.close(); await rm(temporary, { recursive: true, force: true }); }
}
