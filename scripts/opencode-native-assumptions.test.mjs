import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * The native assumption checks of OpenCode (step B5, section 4.4 of docs/superpowers/specs/2026-11-21-requirements-vs-external-dependencies.md):
 * the adapter's declaration re-verified against the installed server, in an isolated home with a local model. Run with
 * `pnpm test:native:opencode`. A difference fails loudly and names the declared field it contradicts.
 */
const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
const execute = promisify(execFile);
const listen = async server => { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return `http://127.0.0.1:${server.address().port}`; };
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(40); }
  throw new Error('Native OpenCode condition timed out.');
}

test('the installed OpenCode server is the version the declaration was verified on, and two turns send no event of a type the adapter does not know', { skip: !executable, timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-assumptions-')));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(AGENT_HOST_|AGENT_REMOTE_|OPENCODE_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_|COPILOT_|GITHUB_TOKEN|GATEWAY_|RELAY_)/.test(key)) delete env[key];
  for (const [name, directory] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' })) {
    env[name] = join(root, directory); await mkdir(env[name], { recursive: true });
  }
  const cwd = join(root, 'project'); await mkdir(cwd);
  await execute('git', ['init', '--quiet'], { cwd, env, timeout: 10000 });
  await execute('git', ['-c', 'user.name=ARC fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Isolated project'], { cwd, env, timeout: 10000 });
  const model = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    if (!JSON.parse(body).stream) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Native fixture reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: '' }); chunk({ content: 'Native fixture ' }); chunk({ content: 'reply' }); chunk({}, 'stop'); response.end('data: [DONE]\n\n');
  });
  const modelUrl = await listen(model);
  await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ update: 'disable', model: { providerID: 'arc', model: 'fixture' }, providers: { arc: { package: '@opencode/ai/providers/openai-compatible', name: 'ARC local fixture', env: ['ARC_FIXTURE_API_KEY'], settings: { baseURL: `${modelUrl}/v1`, apiKey: 'fixture-only', transport: 'http' }, models: { fixture: { name: 'Fixture', capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 128000, output: 8192 } } } } } }));
  env.OPENCODE_DISABLE_AUTO_UPDATE = '1'; env.OPENCODE_PASSWORD = 'isolated-assumptions'; env.ARC_FIXTURE_API_KEY = 'fixture-only';
  const allocator = createServer(); const serverUrl = await listen(allocator);
  await new Promise(resolve => allocator.close(resolve));
  let native, provider;
  try {
    native = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', new URL(serverUrl).port], { cwd, env, stdio: ['ignore', 'ignore', 'ignore'] });
    const headers = { Authorization: `Basic ${Buffer.from('opencode:isolated-assumptions').toString('base64')}` };
    await until(async () => { try { return (await fetch(`${serverUrl}/api/info`, { headers, signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 35000);
    const { version } = await (await fetch(`${serverUrl}/api/info`, { headers, signal: AbortSignal.timeout(5000) })).json();
    const { OpenCodeAgentProvider } = await import('../packages/agent-provider-opencode/dist/index.js');
    const diagnostics = [];
    provider = new OpenCodeAgentProvider({ serverUrl, password: 'isolated-assumptions', requestTimeoutMs: 15000, onDiagnostic: line => diagnostics.push(line) });
    assert.equal(version, provider.descriptor.behaviour.verifiedVersion,
      `verifiedVersion ${provider.descriptor.behaviour.verifiedVersion}: the server is OpenCode ${version}. Run these checks against it and update verifiedVersion in behaviour.ts`);
    const session = await provider.createSession({ sessionId: 'arc-native-assumptions', cwd, model: 'arc/fixture' });
    const events = []; const watching = (async () => { for await (const item of session.observe()) events.push(item); })();
    await until(() => events.some(item => item.type === 'history_boundary'));
    for (const [at, text] of ['Reply with the local fixture text.', 'And once more.'].entries()) {
      await session.sendMessage(text);
      await until(() => events.filter(item => item.type === 'observation' && item.event.type === 'turn_completed').length === at + 1, 35000);
    }
    assert.deepEqual(diagnostics.filter(line => line.includes('native_event_unknown')), [], 'events of a type the adapter does not know (gap 10): add each to native-kinds.ts once its meaning is known');
    await session.dispose(); await watching;
  } finally {
    await provider?.close();
    if (native && native.exitCode === null) {
      native.kill(); await Promise.race([new Promise(resolve => native.once('exit', resolve)), sleep(5000)]);
      if (native.exitCode === null) native.kill('SIGKILL');
    }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
