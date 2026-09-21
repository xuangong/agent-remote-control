import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./create-host.sh', import.meta.url));
const hasPty = spawnSync('python3', ['-c', 'import pty']).status === 0;
const invitation = 'arc_' + 'a'.repeat(43);
async function execute(t, args = [], mode = '', input = invitation + '\n', answers) {
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
  const command = answers ? 'python3' : '/bin/bash';
  const commandArgs = answers ? [fileURLToPath(new URL('../fixtures/terminal-command.py', import.meta.url)), '/bin/bash', script, ...args] : [script, ...args];
  const child = spawn(command, commandArgs, { env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
    FIXTURE_MODE: mode, FIXTURE_EVENTS: join(root, 'events') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', answered = 0;
  function receive(data) {
    output += data;
    if (answers && answered < answers.length && output.includes(answers[answered].prompt)) {
      child.stdin.write(answers[answered++].value + '\n');
    }
  }
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  child.stdin.on('error', () => {});
  if (!answers) child.stdin.end(input);
  const timer = setTimeout(() => { output += '\nTerminal test deadline exceeded\n'; child.kill('SIGKILL'); }, 5000);
  const code = await new Promise(resolve => child.on('exit', (code, signal) => { if (signal) output += `\nTerminal process exited on ${signal}\n`; resolve(code); })); clearTimeout(timer);
  let events = []; try { events = (await readFile(join(root, 'events'), 'utf8')).trim().split('\n').map(JSON.parse); } catch {}
  return { code, output, events };
}
test('one invitation starts a persistent private Host without exposing the key in arguments', { timeout: 10000 }, async t => {
  const result = await execute(t, ['--name', 'arc-codex-host']);
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
  const result = await execute(t, ['--name', 'arc-codex-host'], 'existing', '');
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

const namePattern = /^(sunny|cloudy|rainy|snowy|windy|misty|stormy|frosty)-(hangzhou|chengdu|kyoto|oslo|lisbon|seattle|berlin|taipei)-[0-9a-f]{6}$/;
const created = result => result.events.find(event => event.args[0] === 'create')?.args;
test('piped keys stay intact while omitted options use defaults and a suggested name', { timeout: 10000 }, async t => {
  const result = await execute(t);
  assert.equal(result.code, 0, result.output);
  const args = created(result);
  assert.match(args[args.indexOf('--name') + 1], namePattern);
  assert.ok(args.includes('AGENT_HOST_SERVER=https://agents.xianliao.de5.net'));
  assert.ok(result.events.some(event => event.stdin.trim() === invitation));
});
test('interactive defaults explain each setting and keep the pairing key hidden', { timeout: 10000, skip: !hasPty && 'Python 3 is required for real terminal tests' }, async t => {
  const result = await execute(t, [], '', '', [
    {prompt:'Relay URL [',value:''}, {prompt:'Host name [',value:''},
    {prompt:'Controller image [',value:''}, {prompt:'Docker network [',value:''},
    {prompt:'Pairing key:',value:invitation},
  ]);
  assert.equal(result.code, 0, result.output);
  const args = created(result);
  assert.match(args[args.indexOf('--name') + 1], namePattern);
  assert.ok(args.includes('AGENT_HOST_SERVER=https://agents.xianliao.de5.net'));
  assert.match(result.output, /issued your pairing key/);
  assert.ok(!result.output.includes(invitation));
});
test('flags without values prompt interactively and explicit values skip their prompts', { timeout: 10000, skip: !hasPty && 'Python 3 is required for real terminal tests' }, async t => {
  const result = await execute(t, ['--server', '--name', '--image', 'custom/controller:dev', '--network', 'host'], '', '', [
    {prompt:'Relay URL [',value:'https://relay.example/'}, {prompt:'Host name [',value:'rainy-oslo-custom'},
    {prompt:'Pairing key:',value:invitation},
  ]);
  assert.equal(result.code, 0, result.output);
  const args = created(result);
  assert.ok(args.includes('AGENT_HOST_SERVER=https://relay.example'));
  assert.ok(args.includes('rainy-oslo-custom'));
  assert.ok(args.includes('custom/controller:dev'));
  assert.equal(args[args.indexOf('--network') + 1], 'host');
  assert.ok(!result.output.includes('Controller image ['));
  assert.ok(!result.output.includes('Docker network ['));
});

test('passes the selected native providers when creating a Host', { timeout: 10000 }, async t => {
  const result = await execute(t, ['--name', 'claude-host', '--providers', 'claude', '--image', 'custom/claude-controller:dev']);
  assert.equal(result.code, 0, result.output);
  assert.ok(created(result).includes('AGENT_HOST_PROVIDERS=claude'));
});
