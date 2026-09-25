import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeAgentProvider, setupOpenCodeCallbacks } from '../packages/agent-provider-opencode/dist/index.js';

const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function until(check, milliseconds = 5000) { const end = Date.now() + milliseconds; while (Date.now() < end) { if (await check()) return; await delay(30); } throw new Error('Native callback condition timed out.'); }

// Native plugin initialization installs its official plugin SDK even for a bundled local plugin.
// Prepare that dependency in isolated storage before the 15-second behavior test starts.
const preparedRoot = executable ? await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-callbacks-'))) : undefined;
if (preparedRoot) {
  const prefix = join(preparedRoot, 'xdg_config_home/opencode');
  await mkdir(prefix, { recursive: true });
  try {
  if (process.env.AGENT_OPENCODE_TEST_PLUGIN_PREFIX) await cp(process.env.AGENT_OPENCODE_TEST_PLUGIN_PREFIX, prefix, { recursive: true });
  else await promisify(execFile)('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${process.env.AGENT_OPENCODE_TEST_REGISTRY ?? 'https://registry.npmjs.org'}`, '@opencode-ai/plugin@1.18.18'], {
    timeout: 120000, env: { PATH: process.env.PATH, HOME: preparedRoot, npm_config_cache: join(preparedRoot, 'npm-cache') },
  });
  } catch (error) { await rm(preparedRoot, { recursive: true, force: true }); throw error; }
}

test('native plugin executes only bound callbacks and reconnects after Controller restart', { skip: !executable, timeout: 15000 }, async () => {
  const root = preparedRoot;
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENCODE_DISABLE_AUTO_UPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_SERVER_PASSWORD: 'fixture-password', ARC_FIXTURE_KEY: 'fixture' };
  let native, provider; let diagnostics = ''; let calls = 0; let round = 0; let callbackName = 'read_source_session';
  const model = createServer(async (request, response) => {
    try {
      let text = ''; for await (const chunk of request) text += chunk;
      const input = JSON.parse(text); round++;
      const lastUser = input.messages.findLastIndex(message => message.role === 'user');
      const hasResult = input.messages.slice(lastUser + 1).some(message => message.role === 'tool');
      assert.ok(input.tools.some(tool => tool.function.name === 'arc_host_invoke'));
      const delta = hasResult ? { role: 'assistant', content: 'CALLBACK_COMPLETED' } : { role: 'assistant', tool_calls: [{ index: 0, id: `call_${round}`, type: 'function', function: { name: 'arc_host_invoke', arguments: JSON.stringify({ name: callbackName, arguments: { limit: 1 } }) } }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [value, finish_reason] of [[delta, null], [{}, hasResult ? 'stop' : 'tool_calls']]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { diagnostics += String(error); response.destroy(); }
  });
  const watchdog = setTimeout(() => { native?.kill('SIGKILL'); model.closeAllConnections(); }, 14500); watchdog.unref();
  try {
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) { env[name] = join(root, name.toLowerCase()); await mkdir(env[name], { recursive: true }); }
    const cwd = join(root, 'project'); await mkdir(cwd);
    const { configPath, nativeConfigPath } = await setupOpenCodeCallbacks(join(root, 'callbacks'));
    env.OPENCODE_CONFIG = nativeConfigPath;
    const baseModel = await listen(model);
    const models = { fixture: { name: 'Fixture', limit: { context: 128000, output: 8192 } } };
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ model: 'arc/fixture', enabled_providers: ['arc'], permission: 'allow',
      provider: { arc: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${baseModel}/v1`, apiKey: 'fixture' }, models } },
      providers: { arc: { env: ['ARC_FIXTURE_KEY'], api: { type: 'aisdk', package: '@ai-sdk/openai-compatible', url: `${baseModel}/v1` }, models } },
    }));
    const portServer = createServer(); const base = await listen(portServer); await new Promise(resolve => portServer.close(resolve));
    const providerOptions = { serverUrl: base, password: 'fixture-password', callbackConfigPath: configPath, requestTimeoutMs: 4000 };
    provider = new OpenCodeAgentProvider(providerOptions);
    native = spawn(executable, ['serve', '--print-logs', '--hostname', '127.0.0.1', '--port', new URL(base).port], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [native.stdout, native.stderr]) stream.on('data', data => { diagnostics = (diagnostics + data).slice(-12000); });
    const headers = { Authorization: `Basic ${Buffer.from('opencode:fixture-password').toString('base64')}`, 'Content-Type': 'application/json' };
    async function request(path, method = 'GET', body) { const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000) }); assert.equal(res.status, 200); return res.json(); }
    await until(async () => { if (native.exitCode !== null) throw new Error(diagnostics); try { return (await fetch(base + '/global/health', { headers, signal: AbortSignal.timeout(200) })).ok; } catch { return false; } }, 7000);
    const tools = () => [{ name: callbackName, description: 'Read a fixed source.', inputSchema: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } } }, execute: async () => { calls++; return 'TRUSTED_FIXED_SOURCE'; } }];
    assert.equal(await provider.supportsHostCallbacks(cwd), true, diagnostics);
    let session = await provider.createSession({ sessionId: 'local', cwd, model: 'arc/fixture', tools: tools(), systemPrompt: 'Read the fixed source using the Host callback.' });
    const handle = (await session.runtimeInfo()).persistence;
    await session.sendMessage('CALL_THE_HOST');
    const suffix = `?directory=${encodeURIComponent(cwd)}`;
    await until(async () => (await request(`/session/${handle.sessionId}/message${suffix}`)).some(message => message.parts.some(part => part.type === 'text' && part.text === 'CALLBACK_COMPLETED')));
    assert.equal(calls, 1);
    await provider.close(); provider = new OpenCodeAgentProvider(providerOptions);
    session = await provider.resumeSession(handle, { tools: tools() });
    assert.equal(await provider.supportsHostCallbacks(cwd), true);
    await session.sendMessage('CALL_THE_RESTORED_HOST');
    await until(() => calls === 2);
    await until(async () => (await request('/session/status' + suffix))[handle.sessionId]?.type !== 'busy');
    // New callback names need only a Host binding; the independently running native plugin remains loaded.
    callbackName = 'read_another_source';
    const second = await provider.createSession({ sessionId: 'second', cwd, model: 'arc/fixture', tools: tools() });
    const secondId = (await second.runtimeInfo()).sessionId;
    await second.sendMessage('CALL_THE_NEW_HOST_TOOL');
    await until(async () => (await request(`/session/${secondId}/message${suffix}`)).some(message => message.parts.some(part => part.type === 'text' && part.text === 'CALLBACK_COMPLETED')));
    assert.equal(calls, 3);
    const unbound = await request(`/session${suffix}`, 'POST', {});
    await request(`/session/${unbound.id}/message${suffix}`, 'POST', { model: { providerID: 'arc', modelID: 'fixture' }, parts: [{ type: 'text', text: 'CALLBACK_WITHOUT_GRANT' }] });
    assert.equal(calls, 3, 'An unbound native session must never execute a Host callback.');
    console.log(JSON.stringify({ version: (await request('/global/health')).version, callbacks: calls, controllerRestored: true, unboundDenied: true }));
  } catch (error) { error.message += `\n${diagnostics}`; throw error; }
  finally {
    clearTimeout(watchdog); await provider?.close().catch(() => undefined);
    if (native && native.exitCode === null) { const exited = once(native, 'exit'); native.kill('SIGKILL'); await exited; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
