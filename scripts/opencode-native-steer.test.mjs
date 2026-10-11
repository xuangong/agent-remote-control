import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(40); }
  throw new Error('Native boundary condition timed out.');
}

// Native HTTP proves the admission contract; the built adapter is then exercised against the same runtime.
test('native v2 inbox and adapter steer preserve history during model and tool execution', { skip: !executable, timeout: 75000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-steer-')));
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    OPENCODE_DISABLE_AUTO_UPDATE: '1',
    OPENCODE_PASSWORD: 'isolated-boundaries', ARC_FIXTURE_KEY: 'fixture-only',
  };
  let native;
  let diagnostics = '';
  let releaseFirst;
  const firstResponse = new Promise(resolve => { releaseFirst = resolve; });
  const requests = [];
  let cwd;
  let provider;
  let observationTask;
  let modelGate;
  let releaseAdapter = () => {};
  const model = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] })); return; }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body); requests.push(input);
      if (requests.length === 1) await firstResponse;
      if (modelGate) { const gate = modelGate; modelGate = undefined; await gate; }
      const text = JSON.stringify(input.messages);
      const toolRound = text.includes('TOOL_RUNNING') && !text.includes('ARC_TOOL_FINISHED');
      const toolName = input.tools?.some(tool => tool.function?.name === 'bash') ? 'bash' : 'shell';
      const deltas = toolRound ? [
        [{ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture_gate', type: 'function', function: { name: toolName, arguments: JSON.stringify({ command: `touch '${cwd}/tool-started'; for i in $(seq 1 200); do if test -e '${cwd}/tool-release'; then printf ARC_TOOL_FINISHED; exit 0; fi; sleep 0.05; done; exit 1`, description: 'Wait for isolated test release', timeout: 15000 }) } }] }, null], [{}, 'tool_calls'],
      ] : [[{ role: 'assistant', content: `NATIVE_REPLY_${requests.length}` }, null], [{}, 'stop']];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of deltas) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch { response.destroy(); }
  });
  const watchdog = setTimeout(() => { releaseFirst(); releaseAdapter(); native?.kill('SIGKILL'); model.closeAllConnections(); }, 70000);
  watchdog.unref();
  try {
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      env[name] = join(root, name.toLowerCase()); await mkdir(env[name]);
    }
    cwd = join(root, 'project'); await mkdir(cwd);
    const modelUrl = await listen(model);
    await promisify(execFile)('git', ['init', '--quiet'], { cwd, env, timeout: 10000 });
    const models = { fixture: { name: 'Fixture', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8192 } } };
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify({
      update: 'disable', model: { providerID: 'arc', model: 'fixture' },
      providers: { arc: { package: '@opencode/ai/providers/openai-compatible', name: 'ARC local fixture', env: ['ARC_FIXTURE_KEY'], settings: { baseURL: `${modelUrl}/v1`, apiKey: 'fixture-only', transport: 'http' }, models } },
    }));
    const allocator = createServer(); const base = await listen(allocator);
    await new Promise(resolve => allocator.close(resolve));
    native = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', new URL(base).port], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let spawnError; native.on('error', error => { spawnError = error; });
    for (const stream of [native.stdout, native.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
    const headers = { Authorization: `Basic ${Buffer.from('opencode:isolated-boundaries').toString('base64')}`, 'Content-Type': 'application/json' };
    async function request(path, method = 'GET', body, expected = 200) {
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      const text = await response.text();
      assert.equal(response.status, expected, `${method} ${path}: ${text}`);
      return text ? JSON.parse(text) : undefined;
    }
    await until(async () => {
      if (spawnError) throw spawnError;
      if (native.exitCode !== null) throw new Error(diagnostics);
      try { return (await fetch(base + '/api/info', { headers, signal: AbortSignal.timeout(300) })).ok; } catch { return false; }
    }, 30000);
    const health = await request('/api/info');
    assert.match(health.version, /^2\./);
    const location = `?location[directory]=${encodeURIComponent(cwd)}`;
    await until(async () => (await request('/api/model' + location)).data.some(model => model.providerID === 'arc' && model.id === 'fixture' && model.enabled), 15000);
    const session = (await request('/api/session', 'POST', { location: { directory: cwd }, model: { providerID: 'arc', id: 'fixture' }, permissions: [{ action: '*', resource: '*', effect: 'allow' }] })).data;
    const nativePath = `/api/session/${session.id}`;
    const prompt = (id, text) => request(nativePath + '/prompt', 'POST', { id, text, delivery: 'steer' });
    const messages = async () => (await request(nativePath + '/message?limit=200&order=asc')).data;
    const inactive = async () => !(await request('/api/session/active')).data[session.id];
    await prompt('msg_steer_first', 'ORIGINAL_CONTEXT FIRST_INPUT');
    await until(() => requests.length === 1);
    assert.ok(JSON.stringify(requests[0].messages).includes('ORIGINAL_CONTEXT'));
    assert.ok((await request('/api/session/active')).data[session.id]);
    await prompt('msg_steer_second', 'BUSY_FOLLOW_UP');
    assert.equal(requests.length, 1);
    releaseFirst();
    await until(() => requests.length >= 2);
    await until(inactive);
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('ORIGINAL_CONTEXT'));
    assert.ok(JSON.stringify(requests.at(-1).messages).includes('BUSY_FOLLOW_UP'));
    assert.ok((await messages()).some(message => message.type === 'user' && message.id === 'msg_steer_second'));
    await prompt('msg_tool_first', 'TOOL_RUNNING');
    await until(async () => { try { await access(join(cwd, 'tool-started')); return true; } catch { return false; } });
    await prompt('msg_tool_followup', 'BUSY_TOOL_FOLLOW_UP');
    await writeFile(join(cwd, 'tool-release'), 'release');
    await until(inactive);
    const afterTool = requests.slice(2);
    assert.ok(afterTool.some(input => JSON.stringify(input.messages).includes('BUSY_TOOL_FOLLOW_UP') && JSON.stringify(input.messages).includes('ARC_TOOL_FINISHED')));
    assert.ok(afterTool.every(input => JSON.stringify(input.messages).includes('ORIGINAL_CONTEXT')));
    const { OpenCodeAgentProvider } = await import('../packages/agent-provider-opencode/dist/index.js');
    provider = new OpenCodeAgentProvider({ serverUrl: base, password: 'isolated-boundaries' });
    const adapter = await provider.resumeSession({ providerId: 'opencode', sessionId: session.id, opaque: JSON.stringify({ cwd }) });
    const observations = [];
    observationTask = (async () => { for await (const item of adapter.observe()) observations.push(item); })();
    modelGate = new Promise(resolve => { releaseAdapter = resolve; });
    const beforeAdapter = requests.length;
    await adapter.sendMessage('ADAPTER_FIRST');
    await until(() => requests.length === beforeAdapter + 1);
    await until(async () => (await adapter.runtimeInfo()).status === 'running');
    await until(() => observations.some(item => item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'user_message' && item.event.item.text === 'ADAPTER_FIRST'));
    const start = observations.find(item => item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'user_message' && item.event.item.text === 'ADAPTER_FIRST')?.event.turnId;
    assert.ok(start, 'The native first prompt must establish a turn identity.');
    await adapter.steer('ADAPTER_STEER');
    releaseAdapter();
    await until(() => requests.length === beforeAdapter + 2);
    await until(async () => (await adapter.runtimeInfo()).status === 'idle');
    const lastModel = JSON.stringify(requests.at(-1).messages);
    assert.ok(lastModel.includes('ORIGINAL_CONTEXT') && lastModel.includes('ADAPTER_STEER'));
    const echoes = observations.filter(item => item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'user_message' && item.event.item.text === 'ADAPTER_STEER');
    assert.equal(echoes.length, 1, 'Steer gets exactly one native user echo.');
    assert.equal(observations.filter(item => item.type === 'observation' && item.event.type === 'turn_started').length, 1, 'Busy steering must not invent another execution start.');
    assert.ok(observations.some(item => item.type === 'observation' && item.event.type === 'turn_completed' && item.event.turnId === start), 'Busy steering completes the original native turn.');
    assert.ok(!observations.some(item => item.type === 'observation' && item.event.type === 'turn_failed'));
    console.log(JSON.stringify({ nativeVersion: health.version, modelRequests: requests.length, nativeBusyFollowUp: true, toolBusyFollowUp: true, adapterSteer: true, singleNativeEcho: true, originalContextPreserved: true }));

  } catch (error) {
    error.message += `\nNative diagnostics: ${diagnostics}`;
    throw error;
  } finally {
    releaseFirst(); releaseAdapter(); clearTimeout(watchdog);
    await provider?.close(); await observationTask;
    if (native && native.exitCode === null && native.signalCode === null) {
      const exited = once(native, 'exit').catch(() => undefined);
      native.kill('SIGTERM'); await Promise.race([exited, delay(2000)]);
      if (native.exitCode === null && native.signalCode === null) { native.kill('SIGKILL'); await Promise.race([exited, delay(2000)]); }
    }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
