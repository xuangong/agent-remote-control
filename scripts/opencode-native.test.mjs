import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, realpath, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const executable = process.env.AGENT_OPENCODE_TEST_EXECUTABLE;
const execute = promisify(execFile);
async function initializeProject(cwd, env, name) {
  await execute('git', ['init', '--quiet'], { cwd, env, timeout: 10000 });
  await execute('git', ['-c', 'user.name=ARC fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', name], { cwd, env, timeout: 10000 });
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(40); }
  throw new Error('Native OpenCode smoke condition timed out.');
}

test('native OpenCode serves shared normalized sessions with isolated local model transport', { skip: !executable, timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-smoke-')));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENCODE_|OPENAI_|ANTHROPIC_|CODEX_|COPILOT_|GITHUB_TOKEN)/.test(key)) delete env[key];
  for (const [name, directory] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' })) {
    env[name] = join(root, directory); await mkdir(env[name], { recursive: true });
  }
  const cwd = join(root, 'project'); await mkdir(cwd);
  await initializeProject(cwd, env, 'First isolated project');
  let requests = 0;
  const model = createServer(async (request, response) => {
    if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] })); return; }
    if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests++;
    if (!input.stream) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Native fixture reply' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: 'assistant', content: '' }); chunk({ content: 'Native fixture ' });
    await sleep(80); chunk({ content: 'reply' }); chunk({}, 'stop'); response.end('data: [DONE]\n\n');
  });
  const modelUrl = await listen(model);
  await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ model: 'arc/fixture', enabled_providers: ['arc'], provider: { arc: { npm: '@ai-sdk/openai-compatible', name: 'ARC local fixture', options: { baseURL: `${modelUrl}/v1`, apiKey: 'fixture-only' }, models: { fixture: { name: 'Fixture', limit: { context: 128000, output: 8192 } } } } } }));
  env.OPENCODE_DISABLE_AUTO_UPDATE = '1'; env.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
  env.OPENCODE_SERVER_PASSWORD = 'isolated-smoke';
  const allocator = createServer(); const serverUrl = await listen(allocator);
  await new Promise(resolve => allocator.close(resolve));
  let native;
  let provider;
  let diagnostics = '';
  const sessions = [];
  try {
    native = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', new URL(serverUrl).port], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    native.stdout.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
    native.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
    let spawnError; native.on('error', error => { spawnError = error; });
    const headers = { Authorization: `Basic ${Buffer.from('opencode:isolated-smoke').toString('base64')}` };
    await until(async () => {
      if (spawnError) throw spawnError;
      if (native.exitCode !== null) throw new Error(`OpenCode exited: ${diagnostics}`);
      try { return (await fetch(`${serverUrl}/global/health`, { headers, signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, 35000);
    const { OpenCodeAgentProvider } = await import('../packages/agent-provider-opencode/dist/index.js');
    provider = new OpenCodeAgentProvider({ serverUrl, password: 'isolated-smoke', requestTimeoutMs: 15000 });
    const session = await provider.createSession({ sessionId: 'arc-native-smoke', cwd, model: 'arc/fixture' }); sessions.push(session);
    const events = []; const watching = (async () => { for await (const item of session.observe()) events.push(item); })();
    await until(() => events.some(item => item.type === 'history_boundary'));
    assert.equal(session.capabilities.sessionControl, 'shared');
    await session.sendMessage('Reply with the local fixture text.');
    await until(() => events.some(item => item.type === 'observation' && item.event.type === 'turn_completed'), 35000);
    assert.ok(requests > 0, 'the real native runtime must call the isolated model transport');
    assert.ok(JSON.stringify(events).includes('Native fixture'), JSON.stringify(events));
    assert.ok(!events.some(item => item.type === 'observation' && item.event.type === 'turn_failed'), JSON.stringify(events));
    const runtime = await session.runtimeInfo(); assert.ok(runtime.persistence);
    const messagesUrl = `${serverUrl}/session/${runtime.sessionId}/message?directory=${encodeURIComponent(cwd)}&limit=1`;
    const latestPage = await fetch(messagesUrl, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(latestPage.status, 200);
    const latestMessages = await latestPage.json();
    const nativeCursor = latestPage.headers.get('x-next-cursor');
    assert.ok(nativeCursor, 'native history must return an opaque next-page cursor');
    const olderPage = await fetch(`${messagesUrl}&before=${encodeURIComponent(nativeCursor)}`, { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(olderPage.status, 200, 'native history accepts its response cursor unchanged');
    const olderMessages = await olderPage.json();
    assert.equal(olderMessages.length, 1);
    assert.notEqual(olderMessages[0].info.id, latestMessages[0].info.id);
    await session.sendMessage('Second prompt for native fork verification.');
    await until(() => events.filter(item => item.type === 'observation' && item.event.type === 'turn_completed').length === 2);
    const historyUrl = `${serverUrl}/session/${runtime.sessionId}/message?directory=${encodeURIComponent(cwd)}`;
    const sourceMessages = await (await fetch(historyUrl, { headers, signal: AbortSignal.timeout(5000) })).json();
    const selectedPrompt = sourceMessages.filter(message => message.info.role === 'user').at(-1).info;
    await writeFile(join(cwd, 'preserve.txt'), 'Keep current workspace contents.');
    const fork = await provider.forkForPromptEdit({ nativeSessionId: runtime.sessionId, messageId: selectedPrompt.id, turnId: selectedPrompt.id }); sessions.push(fork);
    const forkId = (await fork.runtimeInfo()).sessionId;
    const forkMessages = await (await fetch(`${serverUrl}/session/${forkId}/message?directory=${encodeURIComponent(cwd)}`, { headers, signal: AbortSignal.timeout(5000) })).json();
    assert.equal(forkMessages.length, sourceMessages.findIndex(message => message.info.id === selectedPrompt.id));
    assert.ok(JSON.stringify(forkMessages).includes('Reply with the local fixture text.'));
    assert.ok(!JSON.stringify(forkMessages).includes('Second prompt for native fork verification.'));
    assert.equal((await (await fetch(historyUrl, { headers, signal: AbortSignal.timeout(5000) })).json()).length, sourceMessages.length);
    assert.equal(await readFile(join(cwd, 'preserve.txt'), 'utf8'), 'Keep current workspace contents.');
    await fork.dispose();
    const childResponse = await fetch(`${serverUrl}/session?directory=${encodeURIComponent(cwd)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ parentID: runtime.sessionId, title: 'Native child fixture' }), signal: AbortSignal.timeout(5000) });
    assert.equal(childResponse.status, 200);
    const nativeChild = await childResponse.json();
    await until(async () => (await session.runtimeInfo()).childSessions?.some(child => child.nativeSessionId === nativeChild.id));
    const child = await provider.openChildSession(runtime.sessionId, nativeChild.id); sessions.push(child);
    assert.equal((await child.runtimeInfo()).sessionId, nativeChild.id);
    await assert.rejects(() => provider.openChildSession(nativeChild.id, runtime.sessionId));
    await child.dispose();
    await provider.renameSession(runtime.sessionId, 'ARC native rename');
    assert.equal((await provider.getSession(runtime.sessionId)).title, 'ARC native rename');
    assert.ok((await provider.listSessions()).some(item => item.id === runtime.sessionId));
    const secondDirectory = join(root, 'other-project'); await mkdir(secondDirectory);
    await initializeProject(secondDirectory, env, 'Second isolated project');
    await copyFile(join(cwd, 'opencode.json'), join(secondDirectory, 'opencode.json'));
    const otherSession = await provider.createSession({ sessionId: 'arc-other-project', cwd: secondDirectory, model: 'arc/fixture' }); sessions.push(otherSession);
    const otherRuntime = await otherSession.runtimeInfo();
    const listed = await provider.listSessions();
    assert.ok(listed.some(item => item.id === runtime.sessionId && item.cwd === cwd));
    assert.ok(listed.some(item => item.id === otherRuntime.sessionId && item.cwd === secondDirectory), 'global listing must include another project');
    await otherSession.dispose();
    await session.dispose(); await watching;
    assert.equal((await fetch(`${serverUrl}/global/health`, { headers })).status, 200);
    const resumed = await provider.resumeSession(runtime.persistence); sessions.push(resumed);
    const history = []; const resumedWatch = (async () => { for await (const item of resumed.observe()) history.push(item); })();
    await until(() => history.some(item => item.type === 'history_boundary'));
    assert.ok(JSON.stringify(history).includes('Native fixture'));
    await resumed.dispose(); await resumedWatch;
    await provider.close();
    assert.equal((await fetch(`${serverUrl}/global/health`, { headers })).status, 200, 'closing adapter must preserve the independently owned server');
    const { createDebuggerServer } = await import('../packages/agent-remote-debugger/dist/server.js');
    const { createDebuggerRuntime } = await import('../packages/agent-remote-debugger/dist/runtime.js');
    const debuggerServer = await createDebuggerServer({ adapter: new OpenCodeAgentProvider({ serverUrl, password: 'isolated-smoke' }), config: { cwd, model: 'arc/fixture' } });
    const clients = [];
    try {
      for (let i = 0; i < 2; i++) {
        const client = await createDebuggerRuntime(debuggerServer.agentId, { relayUrl: debuggerServer.url, origin: debuggerServer.url });
        clients.push(client); await client.ready(10000);
      }
      await clients[0].client.sendMessage('From the first browser.');
      await until(() => JSON.stringify(clients[1].replica.getState().timeline).includes('Native fixture reply'));
      await until(async () => (await (await fetch(`${serverUrl}/session/status?directory=${encodeURIComponent(cwd)}`, { headers })).json())[debuggerServer.session.nativeSessionId]?.type !== 'busy');
      await until(() => clients.every(client => client.replica.getState().agent?.runtimeInfo.status === 'idle'));
      await clients[1].client.sendMessage('From the second browser.');
      await until(() => JSON.stringify(clients[0].replica.getState().timeline).includes('From the second browser.'));
      await until(() => (JSON.stringify(clients[0].replica.getState().timeline).match(/Native fixture reply/g) ?? []).length >= 2);
    } finally { for (const client of clients) client.close(); await debuggerServer.close(); }
    assert.equal((await fetch(`${serverUrl}/global/health`, { headers })).status, 200);
    console.log(JSON.stringify({ ardbSharedClients: 2, native: 'OpenCode', model: 'isolated HTTP fixture', requests, observations: events.length, nativeSessionId: runtime.sessionId, rename: true, resume: true, nativePromptFork: true, nativeChildNavigation: true, nativeHistoryPagination: true, crossProjectListing: true, sharedServerSurvivedDispose: true }));
  } finally {
    for (const session of sessions) await session.dispose().catch(() => {});
    await provider?.close().catch(() => {});
    if (native && native.exitCode === null) {
      native.kill(); await Promise.race([new Promise(resolve => native.once('exit', resolve)), sleep(5000)]);
      if (native.exitCode === null) native.kill('SIGKILL');
    }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
