import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./create-host.sh', import.meta.url));
const invitation = 'arc_' + 'a'.repeat(43);
async function execute(t, args = [], mode = '', input = invitation + '\n') {
  const root = await mkdtemp(join(tmpdir(), 'arc-create-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin/docker'), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2), mode = process.env.FIXTURE_MODE;
const stdin = args[0] === 'run' ? fs.readFileSync(0, 'utf8') : '';
fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({args, stdin}) + '\\n');
if (args[0] === 'inspect' && args[2].includes('.State.Running')) console.log('true 2026-09-21T00:00:00Z');
else if (args[0] === 'inspect') {
  if (!['existing', 'unmanaged', 'different'].includes(mode)) process.exit(1);
  console.log(mode === 'unmanaged' ? 'other https://agents.xianliao.de5.net' : 'docker-host ' + (mode === 'different' ? 'https://other.example' : 'https://agents.xianliao.de5.net'));
} else if (args[0] === 'volume' && args[1] === 'inspect') process.exit(1);
else if (args[0] === 'image' && mode === 'missing-image') process.exit(1);
else if (args[0] === 'run' && mode === 'init-failed') process.exit(1);
else if (args[0] === 'logs') console.log(JSON.stringify({event:'uplink_registered'}));
`, { mode: 0o755 });
  const child = spawn('/bin/bash', [script, ...args], { env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
    FIXTURE_MODE: mode, FIXTURE_EVENTS: join(root, 'events') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const code = await new Promise(resolve => child.on('exit', resolve)); clearTimeout(timer);
  let events = []; try { events = (await readFile(join(root, 'events'), 'utf8')).trim().split('\n').map(JSON.parse); } catch {}
  return { code, output, events };
}
test('one invitation starts a persistent private Host without exposing the key in arguments', { timeout: 10000 }, async t => {
  const result = await execute(t);
  assert.equal(result.code, 0, result.output);
  assert.ok(result.events.some(event => event.args[0] === 'run' && event.stdin.trim() === invitation));
  const create = result.events.find(event => event.args[0] === 'create');
  assert.ok(create, result.output);
  assert.ok(create.args.includes('AGENT_HOST_REMOTE_KEY_FILE=/data/host/pairing-key'));
  assert.ok(create.args.includes('type=volume,src=arc-codex-host-state,dst=/data'));
  assert.ok(create.args.includes('nofile=8192:8192'));
  assert.ok(!JSON.stringify(result.events.map(event => event.args)).includes(invitation));
  assert.ok(!result.output.includes(invitation));
  assert.match(result.output, /ready/i);
});
test('reuses an existing Host without asking for another invitation', { timeout: 10000 }, async t => {
  const result = await execute(t, [], 'existing', '');
  assert.equal(result.code, 0, result.output);
  assert.ok(result.events.some(event => event.args[0] === 'start'));
  assert.ok(!result.events.some(event => ['run', 'create'].includes(event.args[0])));
});
for (const mode of ['unmanaged', 'different']) test(`preserves an existing ${mode} container`, { timeout: 10000 }, async t => {
  const result = await execute(t, [], mode);
  assert.equal(result.code, 1, result.output);
  assert.ok(!result.events.some(event => ['start', 'run', 'create'].includes(event.args[0])));
});
test('rejects invalid keys before creating persistent resources', { timeout: 10000 }, async t => {
  const result = await execute(t, [], '', 'bad-key\n');
  assert.equal(result.code, 1, result.output);
  assert.ok(!result.events.some(event => ['volume', 'run', 'create'].includes(event.args[0])));
});
test('reports an unavailable image without requesting credentials', { timeout: 10000 }, async t => {
  const result = await execute(t, [], 'missing-image', '');
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /image/i);
  assert.ok(!result.events.some(event => ['volume', 'run', 'create'].includes(event.args[0])));
});
test('does not start the Host if private credential delivery fails', { timeout: 10000 }, async t => {
  const result = await execute(t, [], 'init-failed');
  assert.equal(result.code, 1, result.output);
  assert.ok(!result.events.some(event => ['start', 'create'].includes(event.args[0])));
});
