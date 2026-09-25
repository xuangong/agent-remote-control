import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
test('legacy native and adapter steer preserve history during model and tool execution', { skip: !executable, timeout: 75000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-steer-')));
  const env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    OPENCODE_DISABLE_AUTO_UPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_SERVER_PASSWORD: 'isolated-boundaries', ARC_FIXTURE_KEY: 'fixture-only',
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
    const models = { fixture: { name: 'Fixture', limit: { context: 128000, output: 8192 } } };
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify({
      model: 'arc/fixture', enabled_providers: ['arc'], permission: 'allow',
      provider: { arc: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${modelUrl}/v1`, apiKey: 'fixture-only' }, models } },
      providers: { arc: { env: ['ARC_FIXTURE_KEY'], api: { type: 'aisdk', package: '@ai-sdk/openai-compatible', url: `${modelUrl}/v1` }, models } },
    }));
    const allocator = createServer(); const base = await listen(allocator);
    await new Promise(resolve => allocator.close(resolve));
    native = spawn(executable, ['serve', '--print-logs', '--hostname', '127.0.0.1', '--port', new URL(base).port], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      try { return (await fetch(base + '/global/health', { headers, signal: AbortSignal.timeout(300) })).ok; } catch { return false; }
    }, 30000);
    const health = await request('/global/health');
    assert.equal(health.version, '1.18.18', 'Revalidate these version-specific boundaries before changing the pin.');
    const suffix = `?directory=${encodeURIComponent(cwd)}`;
    const session = await request('/session' + suffix, 'POST', {});
    const legacy = `/session/${session.id}`;
    await request(legacy + '/message' + suffix, 'POST', {
      noReply: true, model: { providerID: 'arc', modelID: 'fixture' }, parts: [{ type: 'text', text: 'ORIGINAL_CONTEXT' }],
    });
    await request(legacy + '/prompt_async' + suffix, 'POST', {
      messageID: 'msg_steer_first', model: { providerID: 'arc', modelID: 'fixture' }, parts: [{ type: 'text', text: 'FIRST_INPUT' }],
    }, 204);
    await until(() => requests.length === 1);
    assert.ok(JSON.stringify(requests[0].messages).includes('ORIGINAL_CONTEXT'));
    const status = await request('/session/status' + suffix);
    assert.equal(status[session.id]?.type, 'busy');
    await request(legacy + '/prompt_async' + suffix, 'POST', {
      messageID: 'msg_steer_second', model: { providerID: 'arc', modelID: 'fixture' }, parts: [{ type: 'text', text: 'BUSY_FOLLOW_UP' }],
    }, 204);
    assert.equal(requests.length, 1);
    releaseFirst();
    await until(() => requests.length === 2);
    await until(async () => {
      const messages = await request(legacy + '/message' + suffix);
      return messages.some(message => message.info.role === 'assistant' && message.info.parentID === 'msg_steer_second' && message.info.time.completed);
    });
    assert.ok(JSON.stringify(requests[1].messages).includes('ORIGINAL_CONTEXT'));
    assert.ok(JSON.stringify(requests[1].messages).includes('BUSY_FOLLOW_UP'));
    assert.ok(JSON.stringify(requests[1].messages).includes('NATIVE_REPLY_1'));
    await until(async () => (await request('/session/status' + suffix))[session.id]?.type !== 'busy');
    await request(legacy + '/prompt_async' + suffix, 'POST', {
      messageID: 'msg_tool_first', model: { providerID: 'arc', modelID: 'fixture' }, parts: [{ type: 'text', text: 'TOOL_RUNNING' }],
    }, 204);
    await until(async () => { try { await access(join(cwd, 'tool-started')); return true; } catch { return false; } });
    await request(legacy + '/prompt_async' + suffix, 'POST', {
      messageID: 'msg_tool_followup', model: { providerID: 'arc', modelID: 'fixture' }, parts: [{ type: 'text', text: 'BUSY_TOOL_FOLLOW_UP' }],
    }, 204);
    await writeFile(join(cwd, 'tool-release'), 'release');
    await until(async () => (await request(legacy + '/message' + suffix)).some(message => message.info.role === 'assistant' && message.info.parentID === 'msg_tool_followup' && message.info.time.completed));
    const afterTool = requests.slice(3);
    assert.ok(afterTool.some(input => JSON.stringify(input.messages).includes('BUSY_TOOL_FOLLOW_UP') && JSON.stringify(input.messages).includes('ARC_TOOL_FINISHED')));
    assert.ok(afterTool.every(input => JSON.stringify(input.messages).includes('ORIGINAL_CONTEXT')));
    await until(async () => (await request('/session/status' + suffix))[session.id]?.type !== 'busy');
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
    const start = observations.filter(item => item.type === 'observation' && item.event.type === 'turn_started').at(-1)?.event.turnId;
    await adapter.steer('ADAPTER_STEER');
    releaseAdapter();
    await until(() => requests.length === beforeAdapter + 2);
    await until(async () => (await adapter.runtimeInfo()).status === 'idle');
    const lastModel = JSON.stringify(requests.at(-1).messages);
    assert.ok(lastModel.includes('ORIGINAL_CONTEXT') && lastModel.includes('ADAPTER_STEER'));
    const echoes = observations.filter(item => item.type === 'observation' && item.event.type === 'timeline' && item.event.item.type === 'user_message' && item.event.item.text === 'ADAPTER_STEER');
    assert.equal(echoes.length, 1, 'Steer gets exactly one native user echo.');
    assert.ok(observations.some(item => item.type === 'observation' && item.event.type === 'turn_completed' && item.event.turnId === start), 'Busy steering completes the observed native work without an invented restart.');
    assert.ok(!observations.some(item => item.type === 'observation' && item.event.type === 'turn_failed'));
    console.log(JSON.stringify({ nativeVersion: health.version, legacyModelRequests: requests.length, legacyBusyFollowUp: true, toolBusyFollowUp: true, adapterSteer: true, singleNativeEcho: true, originalContextPreserved: true }));

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
