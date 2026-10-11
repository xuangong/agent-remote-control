import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeAgentProvider, setupOpenCodeCallbacks } from '../packages/agent-provider-opencode/dist/index.js';

const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function until(check, milliseconds = 15000) { const end = Date.now() + milliseconds; while (Date.now() < end) { if (await check()) return; await delay(30); } throw new Error('Native callback condition timed out.'); }

test('native plugin executes only bound callbacks and reconnects after Controller restart', { skip: !executable, timeout: 90000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-callbacks-')));
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENCODE_DISABLE_AUTO_UPDATE: '1', OPENCODE_PASSWORD: 'fixture-password', ARC_FIXTURE_KEY: 'fixture' };
  let native, provider; let diagnostics = ''; let calls = 0; let round = 0; let callbackName = 'read_source_session';
  const model = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const input = JSON.parse(text); round++;
      if (!input.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Callback fixture' }, finish_reason: 'stop' }] }));
        return;
      }
      const lastUser = input.messages.findLastIndex(message => message.role === 'user');
      const hasResult = !input.tools?.length || input.messages.slice(lastUser + 1).some(message => message.role === 'tool');
      if (input.tools?.length) assert.ok(input.tools.some(tool => tool.function.name === 'arc_host_invoke'), `Missing callback tool: ${JSON.stringify(input.tools.map(tool => tool.function.name))}`);
      const delta = hasResult ? { role: 'assistant', content: 'CALLBACK_COMPLETED' } : { role: 'assistant', tool_calls: [{ index: 0, id: `call_${round}`, type: 'function', function: { name: 'arc_host_invoke', arguments: JSON.stringify({ name: callbackName, arguments: { limit: 1 } }) } }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [value, finish_reason] of [[delta, null], [{}, hasResult ? 'stop' : 'tool_calls']]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { diagnostics += String(error); response.destroy(); }
  });
  const watchdog = setTimeout(() => { native?.kill('SIGKILL'); model.closeAllConnections(); }, 85000); watchdog.unref();
  try {
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) { env[name] = join(root, name.toLowerCase()); await mkdir(env[name], { recursive: true }); }
    const cwd = join(root, 'project'); await mkdir(cwd);
    const portServer = createServer(); const base = await listen(portServer); await new Promise(resolve => portServer.close(resolve));
    const { configPath, nativeConfigPath } = await setupOpenCodeCallbacks(join(root, 'callbacks'), base);
    env.OPENCODE_CONFIG = nativeConfigPath;
    const baseModel = await listen(model);
    const models = { fixture: { name: 'Fixture', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8192 } } };
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ update: 'disable', default_agent: 'build', model: 'arc/fixture', permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      providers: { arc: { package: '@opencode/ai/providers/openai-compatible', env: ['ARC_FIXTURE_KEY'], settings: { baseURL: `${baseModel}/v1`, apiKey: 'fixture', transport: 'http' }, models } },
    }));
    const providerOptions = { serverUrl: base, password: 'fixture-password', callbackConfigPath: configPath, requestTimeoutMs: 4000 };
    provider = new OpenCodeAgentProvider(providerOptions);
    native = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', new URL(base).port], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [native.stdout, native.stderr]) stream.on('data', data => { diagnostics = (diagnostics + data).slice(-12000); });
    const headers = { Authorization: `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`, 'Content-Type': 'application/json' };
    async function request(path, method = 'GET', body) { const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) }); const text = await res.text(); assert.equal(res.status, 200, text); return JSON.parse(text); }
    await until(async () => { if (native.exitCode !== null) throw new Error(diagnostics); try { return (await fetch(base + '/api/info', { headers, signal: AbortSignal.timeout(200) })).ok; } catch { return false; } }, 35000);
    const tools = () => [{ name: callbackName, description: 'Read a fixed source.', inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } } }, execute: async () => { calls++; return 'TRUSTED_FIXED_SOURCE'; } }];
    assert.equal(await provider.supportsHostCallbacks(cwd), true, diagnostics);
    assert.equal(provider.nativeEvidence.availability().status, 'unavailable');
    let session = await provider.createSession({ sessionId: 'local', cwd, model: 'arc/fixture', tools: tools(), systemPrompt: 'Read the fixed source using the Host callback.' });
    const handle = (await session.runtimeInfo()).persistence;
    await session.sendMessage('CALL_THE_HOST');
    const completed = value => value.data.some(message => message.type === 'assistant' && message.content.some(content => content.type === 'text' && content.text === 'CALLBACK_COMPLETED'));
    await until(async () => completed(await request(`/api/session/${handle.sessionId}/message`)));
    assert.equal(calls, 1);
    await provider.close(); provider = new OpenCodeAgentProvider(providerOptions);
    session = await provider.resumeSession(handle, { tools: tools() });
    assert.equal(await provider.supportsHostCallbacks(cwd), true);
    await session.sendMessage('CALL_THE_RESTORED_HOST');
    await until(() => calls === 2);
    await until(async () => !(await request('/api/session/active')).data[handle.sessionId]);
    // New callback names need only a Host binding; the independently running native plugin remains loaded.
    callbackName = 'read_another_source';
    const second = await provider.createSession({ sessionId: 'second', cwd, model: 'arc/fixture', tools: tools() });
    const secondId = (await second.runtimeInfo()).sessionId;
    const emptyHistory = (await request(`/api/session/${secondId}/message`)).data;
    assert.ok(emptyHistory.every(message => message.type !== 'user' && message.type !== 'assistant'));
    assert.equal(calls, 2, 'Empty creation and callback binding cannot execute a task.');
    assert.equal(second.nativeEvidence.availability().status, 'unavailable');
    await assert.rejects(second.nativeEvidence.prepareInput([{ type: 'text', text: 'UNSUPPORTED_PREPARED_INPUT' }]), { code: 'native_evidence_unsupported' });
    assert.deepEqual((await request(`/api/session/${secondId}/message`)).data, emptyHistory);
    await second.sendMessage('CALL_THE_NEW_HOST_TOOL');
    await until(async () => completed(await request(`/api/session/${secondId}/message`)));
    assert.equal(calls, 3);
    assert.equal((await request(`/api/session/${secondId}/message`)).data.filter(message => message.type === 'user' && message.text === 'CALL_THE_NEW_HOST_TOOL').length, 1);
    const unbound = (await request('/api/session', 'POST', { location: { directory: cwd }, agent: 'build', model: { providerID: 'arc', id: 'fixture' } })).data;
    await request(`/api/session/${unbound.id}/prompt`, 'POST', { text: 'CALLBACK_WITHOUT_GRANT', delivery: 'queue' });
    await until(async () => completed(await request(`/api/session/${unbound.id}/message`)));
    await until(async () => !(await request('/api/session/active')).data[unbound.id]);
    assert.equal(calls, 3, 'An unbound native session must never execute a Host callback.');
    console.log(JSON.stringify({ version: (await request('/api/info')).version, callbacks: calls, controllerRestored: true, emptySessionBound: true, preparedInputUnavailable: true, ordinaryInputNotReplayed: true, unboundDenied: true }));
  } catch (error) { error.message += `\n${diagnostics}`; throw error; }
  finally {
    clearTimeout(watchdog); await provider?.close().catch(() => undefined);
    if (native && native.exitCode === null) { const exited = once(native, 'exit'); native.kill('SIGKILL'); await exited; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
