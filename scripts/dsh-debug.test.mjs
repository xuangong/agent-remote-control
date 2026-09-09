import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNPM_VERSION, parseOptions, requestJson, waitFor, startProcess } from './lib/dsh-debug-runtime.mjs';

test('defaults to a persistent isolated home and keeps CLI paths as literal arguments', () => {
  const options = parseOptions(['--yes', '--workspace', '/tmp/project with spaces', '--dsh', '/tmp/tool $(literal)'], '/repo', '/cwd');
  assert.equal(options.home, '/repo/.runtime/dsh-debug/home');
  assert.equal(options.workspace, '/tmp/project with spaces');
  assert.equal(options.dsh, '/tmp/tool $(literal)');
  assert.equal(options.serverUrl, 'http://127.0.0.1:5910');
  assert.equal(options.registry, 'https://mirrors.cloud.tencent.com/npm/');
  assert.equal(options.yes, true);
});

test('rejects invalid options before setup changes any files', () => {
  for (const args of [['--dsh-port', '0'], ['--dsh-port', 'hello'], ['--unknown'], ['--home'], ['--server-url', 'http://user:secret@localhost'], ['--server-url', 'file:///tmp/server']]) {
    assert.throws(() => parseOptions(args, '/repo', '/cwd'));
  }
});

test('reports an HTTP failure instead of accepting a pairing response as a key', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Host service unavailable' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(requestJson(`http://127.0.0.1:${server.address().port}/v1/remote/pairings`, { method: 'POST', body: '{}' }), /503.*Host service unavailable/);
});

test('readiness waits have a deadline and support cancellation', async () => {
  await assert.rejects(waitFor(() => false, { timeoutMs: 30, intervalMs: 5 }), /Timed out/);
  const controller = new AbortController();
  const waiting = waitFor(() => false, { timeoutMs: 5000, intervalMs: 5, signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, /abort/i);
});

test('child output redacts a pairing key even when the child splits it across writes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-debug-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = [];
  const process = startProcess(globalThis.process.execPath, ['-e', "process.stdout.write('arc_'); setTimeout(() => console.log('private-key'), 10)"], {
    logFile: join(directory, 'run.log'), secrets: ['arc_private-key'], output: (line) => output.push(line),
  });
  t.after(() => process.stop());
  assert.equal((await process.finished).code, 0);
  assert.deepEqual(output, ['[redacted]']);
  assert.equal((await readFile(join(directory, 'run.log'), 'utf8')).trim(), '[redacted]');
});

test('stopping a managed process leaves an independently started service running', async (t) => {
  const options = { output: () => undefined };
  const unrelated = startProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
  const owned = startProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
  t.after(() => unrelated.stop());
  t.after(() => owned.stop());
  await owned.stop();
  assert.equal(owned.running, false);
  assert.equal(unrelated.running, true);
});

test('guided setup installs into one home, pairs, starts, and preserves a reused workbench on exit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-setup-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let host;
  let installation;
  const key = 'arc_workflow-private';
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/remote/pairings') response.end(JSON.stringify({ key }));
    else if (request.url === '/v1/remote/hosts') response.end(JSON.stringify({ hosts: host ? [host] : [] }));
    else if (request.url === '/v1/remote/hosts/native/workspaces') response.end(JSON.stringify({ workspaces: [] }));
    else if (request.url === '/installed') { installation = body; response.end('{}'); }
    else if (request.url === '/register') {
      assert.equal(body.key, key);
      assert.equal(body.home, join(directory, 'home'));
      host = { id: 'native', name: body.name, online: true }; response.end('{}');
    } else { response.statusCode = 404; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((accept) => server.close(accept)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const pnpmDir = join(directory, 'tools', PNPM_VERSION, 'node_modules/.bin');
  await mkdir(pnpmDir, { recursive: true });
  await writeFile(join(pnpmDir, 'pnpm'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  const dsh = join(directory, 'dsh');
  await writeFile(dsh, `#!${process.execPath}
const http = require('node:http');
const args = process.argv.slice(2);
const post = (path, body) => fetch(process.env.TEST_SERVER + path, {method:'POST', body:JSON.stringify(body)});
(async () => {
  if (args[0] === '--version') { console.log('0.1.2-rc.1'); return; }
  if (args[0] === 'plugin') { await post('/installed', {args, home:process.env.DSH_HOME, cwd:process.cwd()}); return; }
  const port = Number(args[args.indexOf('--port') + 1]);
  http.createServer((_,response) => response.end('<html>DSH</html>')).listen(port, '127.0.0.1');
  await post('/register', {key:process.env.AGENT_REMOTE_ACCESS_KEY, name:process.env.AGENT_REMOTE_INSTANCE_NAME, home:process.env.DSH_HOME});
  console.log('dsh web: http://127.0.0.1:' + port);
  console.log(process.env.AGENT_REMOTE_ACCESS_KEY);
  console.log('Agent Remote Control Agent Remote uplink registered.');
})();
`, { mode: 0o755 });
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise((accept) => portProbe.close(accept));
  const output = [];
  const child = startProcess(process.execPath, [fileURLToPath(new URL('./dsh-debug.mjs', import.meta.url)), '--yes', '--dsh', dsh, '--state-dir', directory, '--workspace', directory, '--server-url', url, '--console-url', url, '--dsh-port', String(port)], { env: { ...process.env, TEST_SERVER: url }, output: (line) => output.push(line) });
  t.after(() => child.stop());
  await waitFor(async () => {
    assert.equal(child.running, true, output.join('\n'));
    try { return JSON.parse(await readFile(join(directory, 'last-run.json'), 'utf8')); } catch { return false; }
  }, { timeoutMs: 5000, intervalMs: 20 });
  assert.equal(installation.home, join(directory, 'home'));
  assert.equal(installation.cwd, await realpath(directory));
  assert.deepEqual(installation.args.slice(0, 4), ['plugin', '--profile', 'web', 'add']);
  assert.match(installation.args[4], /^file:.*\.tgz$/);
  assert.ok(output.some((line) => line.startsWith('Ready:')));
  assert.ok(!output.join('\n').includes(key));
  const record = JSON.parse(await readFile(join(directory, 'last-run.json'), 'utf8'));
  assert.ok(!(await readFile(record.logFile, 'utf8')).includes(key));
  await child.stop();
  assert.deepEqual(await requestJson(`${url}/v1/remote/hosts`), { hosts: [host] });
});
