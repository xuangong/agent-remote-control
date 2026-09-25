import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
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

// This tests the native contracts directly and does not require a built adapter.
test('OpenCode v1 and durable v2 execution keep separate histories even with one native session ID', { skip: !executable, timeout: 75000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-boundaries-')));
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
  const model = createServer(async (request, response) => {
    try {
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body); requests.push(input);
      if (requests.length === 1) await firstResponse;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'DURABLE_REPLY' }, null], [{}, 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch { response.destroy(); }
  });
  const watchdog = setTimeout(() => { releaseFirst(); native?.kill('SIGKILL'); model.closeAllConnections(); }, 70000);
  watchdog.unref();
  try {
    for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
      env[name] = join(root, name.toLowerCase()); await mkdir(env[name]);
    }
    const cwd = join(root, 'project'); await mkdir(cwd);
    const modelUrl = await listen(model);
    const models = { fixture: { name: 'Fixture', limit: { context: 128000, output: 8192 } } };
    await writeFile(join(cwd, 'opencode.json'), JSON.stringify({
      model: 'arc/fixture', enabled_providers: ['arc'],
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
    const durable = `/api/session/${session.id}`;
    await request(legacy + '/message' + suffix, 'POST', {
      noReply: true, model: { providerID: 'arc', modelID: 'fixture' }, parts: [{ type: 'text', text: 'LEGACY_ORIGINAL_CONTEXT' }],
    });
    await request(durable + '/model', 'POST', { model: { id: 'fixture', providerID: 'arc' } }, 204);
    const location = new URLSearchParams({ 'location[directory]': cwd });
    await until(async () => {
      const result = await request(`/api/model?${location}`);
      return result.data.some(model => model.providerID === 'arc' && model.id === 'fixture');
    });
    await request(durable + '/prompt', 'POST', { id: 'msg_boundary_first', prompt: { text: 'DURABLE_FIRST_INPUT' }, delivery: 'steer' });
    await until(() => requests.length === 1);
    assert.ok(!JSON.stringify(requests[0].messages).includes('LEGACY_ORIGINAL_CONTEXT'), 'Durable execution must not be mistaken for continuation of legacy history.');
    await request(durable + '/prompt', 'POST', { id: 'msg_boundary_steer', prompt: { text: 'DURABLE_BUSY_STEER' }, delivery: 'steer' });
    assert.equal(requests.length, 1, 'A busy steer does not interrupt the active model request.');
    releaseFirst();
    await until(async () => {
      const result = await request(durable + '/context');
      return result.data.filter(message => message.type === 'assistant' && message.finish === 'stop').length === 2;
    });
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1].messages).includes('DURABLE_BUSY_STEER'));
    assert.ok(requests[1].messages.some(message => message.role === 'assistant' && message.content === 'DURABLE_REPLY'));
    assert.ok(!JSON.stringify(requests[1].messages).includes('LEGACY_ORIGINAL_CONTEXT'));
    const legacyMessages = await request(legacy + '/message' + suffix);
    assert.deepEqual(legacyMessages.flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)), ['LEGACY_ORIGINAL_CONTEXT']);
    const context = await request(durable + '/context');
    assert.ok(!JSON.stringify(context).includes('LEGACY_ORIGINAL_CONTEXT'));
    const history = await request(durable + '/history');
    assert.equal(history.data.filter(event => event.type === 'session.next.prompt.admitted').length, 2);
    assert.equal(history.data.filter(event => event.type === 'session.next.step.ended').length, 2);
    const wait = await request(durable + '/wait', 'POST', {}, 503);
    assert.equal(wait.service, 'session.wait');
    await request(durable + '/interrupt', 'POST', {}, 204);
    console.log(JSON.stringify({ nativeVersion: health.version, legacyMessages: legacyMessages.length, durableModelRequests: requests.length, separateHistories: true, busySteerFollowsExistingModelStep: true }));
  } catch (error) {
    error.message += `\nNative diagnostics: ${diagnostics}`;
    throw error;
  } finally {
    releaseFirst(); clearTimeout(watchdog);
    if (native && native.exitCode === null && native.signalCode === null) {
      const exited = once(native, 'exit').catch(() => undefined);
      native.kill('SIGTERM'); await Promise.race([exited, delay(2000)]);
      if (native.exitCode === null && native.signalCode === null) { native.kill('SIGKILL'); await Promise.race([exited, delay(2000)]); }
    }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
