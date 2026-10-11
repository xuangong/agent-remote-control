import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

export async function waitFor(check, signal, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { signal.throwIfAborted(); const result = await check(); if (result) return result; await delay(50); }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

/** Independent native profile, local model transport and owned-process-only cleanup. */
export async function makeOpenCodeNativeFixture(signal, report) {
  const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
  assert.ok(isAbsolute(executable ?? ''), 'Set an absolute AGENT_OPENCODE_TEST_EXECUTABLE.');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-evidence-')));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const env = { PATH: process.env.PATH, SHELL: process.env.SHELL ?? '/bin/sh', LANG: 'en_US.UTF-8',
    OPENCODE_DISABLE_AUTO_UPDATE: '1', OPENCODE_PASSWORD: 'isolated-evidence', ARC_FIXTURE_API_KEY: 'fixture-only' };
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TMPDIR']) {
    env[name] = join(root, name.toLowerCase()); await mkdir(env[name]);
  }
  await promisify(execFile)('git', ['init', '--quiet'], { cwd, env, timeout: 10000 });
  await promisify(execFile)('git', ['-c', 'user.name=ARC fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Native fixture'], { cwd, env, timeout: 10000 });
  let heldText, heldResponse, native, exited, diagnostics = '';
  report.requests = []; report.modelRequests = []; report.processes = [];
  const model = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] })); return; }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of request) { body += chunk; assert.ok(body.length < 1_000_000); }
      const input = JSON.parse(body);
      const hold = heldText && input.messages?.some(item => item.role === 'user' && JSON.stringify(item.content).includes(heldText));
      report.modelRequests.push({ model: input.model, held: !!hold, stream: input.stream, tools: (input.tools ?? []).map(tool => tool.function?.name) });
      if (hold) { heldResponse = response; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders(); return; }
      if (!input.stream) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Fixture complete' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })); return; }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Fixture complete' }, null], [{}, 'stop']])
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { report.modelError = error.message; response.destroy(error); }
  });
  const modelUrl = await listen(model);
  const allocator = createServer(); const serverUrl = await listen(allocator); await new Promise(resolve => allocator.close(resolve));
  const headers = { Authorization: `Basic ${Buffer.from('opencode:isolated-evidence').toString('base64')}` };
  await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ update: 'disable', default_agent: 'build', model: { providerID: 'arc', model: 'fixture' },
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    providers: { arc: { package: '@opencode/ai/providers/openai-compatible', name: 'ARC fixture', env: ['ARC_FIXTURE_API_KEY'], settings: { baseURL: `${modelUrl}/v1`, apiKey: 'fixture-only', transport: 'http' }, models: { fixture: { name: 'Fixture', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8192 } } } } } }));
  async function api(path) {
    const response = await fetch(serverUrl + path, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`); return response.json();
  }
  async function stop(kill = false) {
    if (!native || native.exitCode !== null || native.signalCode !== null) return;
    native.kill(kill ? 'SIGKILL' : 'SIGTERM');
    const timer = setTimeout(() => native.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  async function start() {
    native = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', new URL(serverUrl).port], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError;
    native.once('error', error => { spawnError = error; });
    const processInfo = { pid: native.pid }; report.processes.push(processInfo);
    exited = new Promise(resolve => native.once('close', (code, signal) => { processInfo.exit = { code, signal }; resolve(); }));
    for (const stream of [native.stdout, native.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
    await waitFor(async () => {
      if (spawnError) throw spawnError;
      if (native.exitCode !== null) throw new Error(`Native startup failed: ${diagnostics}`);
      try { report.identity = await api('/api/info'); return true; } catch { return false; }
    }, signal, 'authenticated native startup', 35000);
    assert.match(report.identity.version, /^2\./);
    await waitFor(async () => (await api(`/api/model?location[directory]=${encodeURIComponent(cwd)}`)).data.some(item => item.providerID === 'arc' && item.id === 'fixture' && item.enabled), signal, 'isolated model catalog', 20000);
  }
  async function cleanup() {
    await stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    report.cleanup = { ownedProcessesExited: report.processes.every(item => item.exit) };
    assert.ok(report.cleanup.ownedProcessesExited); await rm(root, { recursive: true, force: true });
  }
  report.executable = { path: await realpath(executable), sha256: createHash('sha256').update(await readFile(executable)).digest('hex') };
  return { cwd, serverUrl, api, start, stop, cleanup, hold: text => { heldText = text; }, held: () => !!heldResponse && !heldResponse.writableEnded,
    startHeldOutput: () => {
      assert.ok(heldResponse && !heldResponse.writableEnded);
      heldResponse.write(`data: ${JSON.stringify({ id: 'fixture-held', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Started fixture' }, finish_reason: null }] })}\n\n`);
    },
    adapterOptions: { serverUrl, password: 'isolated-evidence', requestTimeoutMs: 10000 }, diagnostics: () => diagnostics,
    sanitize: value => JSON.parse(JSON.stringify(value).replaceAll(root, '<isolated-root>')) };
}
