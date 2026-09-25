import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (args.includes('--help')) {
  console.log('Usage: node scripts/opencode-debug-scenario.mjs [--executable PATH] [--output FILE.jsonl] [--keep] [--hold-ms 1800000]');
  process.exit(0);
}
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--keep') continue;
  if (['--executable', '--output', '--hold-ms'].includes(args[index]) && args[index + 1]) { index++; continue; }
  throw new Error(`Unknown or incomplete argument: ${args[index]}`);
}
const execute = promisify(execFile);
const executable = option('--executable') ?? process.env.AGENT_OPENCODE_TEST_EXECUTABLE ?? 'opencode';
const holdMs = Number(option('--hold-ms') ?? 1800000);
assert.ok(Number.isSafeInteger(holdMs) && holdMs > 0 && holdMs <= 43200000, 'hold-ms must be between 1 and 43200000');
const recordingPath = resolve(option('--output') ?? join('.tmp/opencode-debug', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`));
const evidencePath = `${recordingPath}.evidence.json`;
const nativeLogPath = `${recordingPath}.native.log`;
const stop = new AbortController();
const scenarioDeadline = setTimeout(() => stop.abort(new Error('OpenCode debug scenario exceeded 180 seconds.')), 180000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort(new Error(`Received ${signal}.`)));
const evidence = { recordingPath, evidencePath, nativeLogPath, nativeVersion: '', checks: {}, modelRequests: [], interactions: [], connection: [] };
let native, model, workspace, runtime, root, captureId, releaseModel, modelHeld = false, diagnostics = '', completed = false;

async function until(check, description, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { stop.signal.throwIfAborted(); if (await check()) return; await sleep(40, undefined, { signal: stop.signal }); }
  throw new Error(`Timed out: ${description}`);
}
async function within(promise, timeout, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function json(url, body) {
  const response = await fetch(url, { ...(body === undefined ? {} : { method: 'POST', headers: { Origin: workspace.url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]) });
  const text = await response.text(); assert.ok(response.ok, `${response.status} ${url}: ${text}`); return JSON.parse(text);
}
function contentText(value) {
  return typeof value === 'string' ? value : Array.isArray(value) ? value.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';
}
function modelAnswer(input, cwd) {
  const tools = (input.tools ?? []).map(tool => tool.function?.name);
  const messages = input.messages ?? [];
  const lastUser = messages.map(message => message.role).lastIndexOf('user');
  const prompt = contentText(messages[lastUser]?.content);
  const replies = messages.slice(lastUser + 1).filter(message => message.role === 'tool').length;
  const question = { name: 'question', args: { questions: [{ question: 'Which verification should the isolated OpenCode session record?', header: 'Verification', options: [{ label: 'Record success', description: 'Confirm the real native question round trip.' }, { label: 'Inspect again', description: 'Keep the same deterministic test data.' }], multiple: false }] } };
  const shell = tools.includes('shell') ? 'shell' : 'bash';
  const sequence = prompt.includes('ARC_DEBUG_SOURCE') ? [
    { name: 'arc_host_discover', args: {} },
    { name: 'arc_host_invoke', args: { name: 'read_source_session', arguments: { query: 'ARC_SOURCE_UPDATED' } } },
  ] : prompt.includes('ARC_DEBUG_QUESTION') ? [question] : prompt.includes('ARC_DEBUG_SCENARIO') ? [
    { name: shell, args: { command: "printf 'ARC_SHELL_OK\\n'", description: 'Print deterministic smoke marker', workdir: cwd } },
    { name: 'read', args: { filePath: join(cwd, 'fixture.ts') } },
    { name: 'edit', args: { filePath: join(cwd, 'fixture.ts'), oldString: 'export const result = "before";', newString: 'export const result = "after";' } },
    question,
  ] : [];
  const step = sequence[replies];
  if (step && tools.includes(step.name)) return { tool: step };
  if (step) throw new Error(`Native model request did not expose required tool ${step.name}. Available: ${tools.join(', ')}`);
  if (prompt.includes('ARC_DEBUG_SOURCE')) {
    assert.ok(messages.slice(lastUser + 1).some(message => message.role === 'tool' && contentText(message.content).includes('ARC_SOURCE_UPDATED')), 'The native callback must read source content written after the Ask session was created.');
    return { text: 'ARC_SOURCE_COMPLETE: fresh source history reached the native agent through the Host callback.' };
  }
  return { text: prompt.includes('ARC_DEBUG_STEER') ? 'ARC_STEER_COMPLETE: live follow-up retained the original context.' : prompt.includes('ARC_DEBUG_SCENARIO') ? 'ARC_SCENARIO_COMPLETE: shell, file edit, permissions, and question ran through native OpenCode.' : prompt.includes('ARC_DEBUG_QUESTION') ? 'ARC_QUESTION_COMPLETE: the browser answer reached native OpenCode.' : 'ARC_NATIVE_REPLY: isolated deterministic model response.' };
}
try {
  await mkdir(dirname(recordingPath), { recursive: true });
  const version = await execute(executable, ['--version'], { timeout: 10000 });
  evidence.nativeVersion = version.stdout.trim();
  assert.equal(evidence.nativeVersion, '1.18.18', 'This deterministic native fixture is pinned to OpenCode 1.18.18.');
  root = await realpath(await mkdtemp(join(tmpdir(), 'arc-opencode-debug-')));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(OPENCODE_|OPENAI_|ANTHROPIC_|CODEX_|COPILOT_|GITHUB_TOKEN|GH_TOKEN)/.test(key)) delete env[key];
  for (const [name, folder] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state' })) {
    env[name] = join(root, folder); await mkdir(env[name], { recursive: true });
  }
  const { setupOpenCodeCallbacks } = await import('../packages/agent-provider-opencode/dist/index.js');
  const { configPath, nativeConfigPath } = await setupOpenCodeCallbacks(join(root, 'callbacks'));
  env.OPENCODE_CONFIG = nativeConfigPath;
  if (process.env.AGENT_OPENCODE_TEST_PLUGIN_PREFIX) await cp(process.env.AGENT_OPENCODE_TEST_PLUGIN_PREFIX, join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
  else await execute('npm', ['install', '--prefix', join(env.XDG_CONFIG_HOME, 'opencode'), '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${process.env.AGENT_OPENCODE_TEST_REGISTRY ?? 'https://registry.npmjs.org'}`, '@opencode-ai/plugin@1.18.18'], {
    timeout: 120000, env: { PATH: process.env.PATH, HOME: env.HOME, npm_config_cache: join(root, 'npm-cache') },
  });
  const cwd = join(root, 'project'); await mkdir(cwd); evidence.cwd = cwd;
  await execute('git', ['init', '--quiet'], { cwd, env, timeout: 10000 });
  await writeFile(join(cwd, 'fixture.ts'), 'export const result = "before";\n');
  await execute('git', ['add', 'fixture.ts'], { cwd, env, timeout: 10000 });
  await execute('git', ['-c', 'user.name=ARC fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Isolated debugger fixture'], { cwd, env, timeout: 10000 });
  await cp(join(env.XDG_CONFIG_HOME, 'opencode'), join(cwd, '.opencode'), { recursive: true });
  await mkdir(join(cwd, '.opencode/skills/arc-debug'), { recursive: true });
  await writeFile(join(cwd, '.opencode/skills/arc-debug/SKILL.md'), '---\nname: arc-debug\ndescription: Verify a deterministic isolated debugger session.\n---\n\nRead fixture.ts and report the current result value.\n');
  model = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/models') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture', object: 'model' }] })); return; }
      if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8 * 1024 * 1024) throw new Error('Fixture request exceeds 8 MiB.'); }
      const input = JSON.parse(body);
      const answer = input.stream && (input.tools?.length ?? 0) > 0 ? modelAnswer(input, cwd) : { text: 'ARC_NATIVE_SUMMARY: deterministic context summary.' };
      const userPrompt = contentText((input.messages ?? []).filter(message => message.role === 'user').at(-1)?.content);
      if (input.stream && input.tools?.length && userPrompt.startsWith('ARC_DEBUG_HOLD')) {
        modelHeld = true;
        await within(new Promise(resolve => { releaseModel = resolve; }), 20000, 'Held model response was not released.');
      }
      if (input.tools?.length && userPrompt.startsWith('ARC_DEBUG_STEER')) assert.ok(JSON.stringify(input.messages).includes('ARC_DEBUG_HOLD'), 'Steer must preserve previous native context.');
      evidence.modelRequests.push({ prompt: userPrompt, at: new Date().toISOString(), stream: !!input.stream, model: input.model, tool: answer.tool?.name, tools: (input.tools ?? []).map(tool => tool.function?.name), reasoningEffort: input.reasoning_effort });
      if (!input.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: answer.text }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } })); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const id = randomUUID();
      const chunk = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      chunk({ role: 'assistant', content: '' });
      if (answer.tool) {
        chunk({ tool_calls: [{ index: 0, id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: answer.tool.name, arguments: JSON.stringify(answer.tool.args) } }] });
        chunk({}, 'tool_calls');
      } else {
        const words = answer.text.split(' ');
        for (const [index, word] of words.entries()) { chunk({ content: `${index ? ' ' : ''}${word}` }); await sleep(30); }
        chunk({}, 'stop');
      }
      chunk({}, null, { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 });
      response.end('data: [DONE]\n\n');
    } catch (error) { evidence.modelError = String(error); response.writeHead(500).end(JSON.stringify({ error: { message: String(error) } })); }
  });
  const modelUrl = await listen(model);
  await writeFile(join(cwd, 'opencode.json'), JSON.stringify({ model: 'arc/fixture', enabled_providers: ['arc'], permission: { '*': 'ask', read: 'allow', question: 'allow', arc_host_discover: 'allow', arc_host_invoke: 'allow' }, provider: { arc: { npm: '@ai-sdk/openai-compatible', name: 'ARC isolated model', options: { baseURL: `${modelUrl}/v1`, apiKey: 'fixture-only' }, models: { fixture: { name: 'Deterministic fixture', limit: { context: 128000, output: 8192 }, variants: { concise: { reasoningEffort: 'low' }, thorough: { reasoningEffort: 'high' } } } } } } }));
  env.OPENCODE_DISABLE_AUTO_UPDATE = '1'; env.OPENCODE_DISABLE_DEFAULT_PLUGINS = '1';
  const password = randomUUID(); env.OPENCODE_SERVER_PASSWORD = password;
  const allocator = createServer(); const serverUrl = await listen(allocator); await new Promise(done => allocator.close(done));
  native = spawn(executable, ['serve', '--print-logs', '--hostname', '127.0.0.1', '--port', new URL(serverUrl).port], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  native.stdout.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-1024 * 1024); });
  native.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-1024 * 1024); });
  let spawnError; native.on('error', error => { spawnError = error; });
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
  await until(async () => {
    if (spawnError) throw spawnError;
    if (native.exitCode !== null) throw new Error(`Native server exited: ${diagnostics}`);
    try { return (await fetch(`${serverUrl}/global/health`, { headers, signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, 'native server health', 45000);
  const [{ OpenCodeAgentProvider }, { createReplayServer }, { createDebuggerRuntime }, { parseRecording }] = await Promise.all([
    import('../packages/agent-provider-opencode/dist/index.js'), import('../packages/agent-remote-debugger/dist/replay-server.js'),
    import('../packages/agent-remote-debugger/dist/runtime.js'), import('../packages/agent-remote-debugger/dist/recording.js'),
  ]);
  const { sourceSessionExtensions } = await import('../packages/agent-host/dist/session-reference.js');
  async function nativeRequest(path, body) {
    const response = await fetch(`${serverUrl}${path}?directory=${encodeURIComponent(cwd)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const text = await response.text(); assert.ok(response.ok, `Native ${path}: ${response.status} ${text}`); return JSON.parse(text);
  }
  const source = await nativeRequest('/session', {});
  await nativeRequest(`/session/${source.id}/message`, { noReply: true, parts: [{ type: 'text', text: 'ARC_SOURCE_INITIAL' }] });
  evidence.sourceSessionId = source.id;
  workspace = await createReplayServer({ directory: dirname(recordingPath), loadProvider: async provider => {
    assert.equal(provider, 'opencode');
    const adapter = new OpenCodeAgentProvider({ serverUrl, password, callbackConfigPath: configPath, requestTimeoutMs: 20000 });
    const create = adapter.createSession.bind(adapter);
    adapter.createSession = config => create({ ...config, ...sourceSessionExtensions(source.id, (id, query) => adapter.readSessionHistory(id, query)) });
    return adapter;
  } });
  const session = await json(`${workspace.url}/__ardb/live/start`, { provider: 'opencode', cwd });
  evidence.url = workspace.url; evidence.agentId = session.agentId; evidence.nativeSessionId = session.nativeSessionId;
  console.log(JSON.stringify({ event: 'debugger_ready', url: workspace.url, agentId: session.agentId, cwd, recordingPath }));
  captureId = (await json(`${workspace.url}/__ardb/recording/start`, {})).id;
  runtime = await createDebuggerRuntime(session.agentId, { relayUrl: workspace.url, origin: workspace.url, operationTimeoutMs: 20000, signal: stop.signal,
    protocolObserver: ({ direction, message }) => {
      if (['negotiated', 'session_control', 'protocol_error'].includes(message.type)) evidence.connection.push({ at: Date.now(), direction, type: message.type, access: message.payload?.access, code: message.payload?.code, message: message.payload?.message });
    },
  });
  runtime.client.subscribeStatus(status => { evidence.connection.push({ at: Date.now(), status }); });
  await runtime.ready(15000);
  await runtime.client.setSessionSetting('model', 'arc/fixture');
  const settings = () => runtime.replica.getState().agent?.runtimeInfo.settings ?? [];
  await until(() => settings().some(setting => setting.id === 'model' && setting.value === 'arc/fixture'), 'selected model');
  if (settings().some(setting => setting.id === 'variant' && setting.options.some(choice => choice.value === 'concise'))) {
    await runtime.client.setSessionSetting('variant', 'concise');
    await until(() => settings().some(setting => setting.id === 'variant' && setting.value === 'concise'), 'selected model variant');
    evidence.checks.variant = true;
  } else throw new Error('Native model variant was not exposed by the adapter.');
  const progress = runtime.captureProgress();
  await runtime.client.sendMessage('ARC_DEBUG_SCENARIO: demonstrate the native shell, edit the fixture, and ask the verification question.');
  const answered = new Set();
  await until(async () => {
    const state = runtime.replica.getState();
    for (const request of state.pendingInteractions) {
      if (answered.has(request.requestId)) continue;
      assert.ok(['tool_approval', 'question'].includes(request.kind), `Unexpected native interaction ${request.kind}`);
      evidence.interactions.push({ kind: request.kind, requestId: request.requestId, toolName: request.toolName, questions: request.questions });
      const response = request.kind === 'tool_approval' ? { kind: 'tool_approval', decision: 'allow', scope: 'once' } : { kind: 'question', answers: request.questions.map(question => ({ questionId: question.questionId, selectedValues: [question.options[0].value] })) };
      await runtime.ready(15000);
      await runtime.client.respondToInteraction(request.requestId, response); answered.add(request.requestId);
    }
    return JSON.stringify(state.timeline).includes('ARC_SCENARIO_COMPLETE: shell');
  }, 'native tool and interaction scenario', 90000);
  await runtime.waitFor('idle', 20000, progress);
  const rendered = JSON.stringify(runtime.replica.getState().timeline);
  assert.ok(rendered.includes('ARC_SHELL_OK'), 'Shell output must reach the real product replica.');
  const items = runtime.replica.getState().timeline.entries.map(entry => entry.item);
  const shellResult = items.find(item => item.type === 'tool_call' && ['shell', 'bash'].includes(item.name))?.result;
  assert.equal(shellResult?.exitCode, 0, 'Native shell exit code must reach the product replica.');
  assert.ok(shellResult.durationMs >= 0, 'Native shell duration must reach the product replica.');
  const files = items.filter(item => item.type === 'tool_call').flatMap(item => item.result?.content ?? []).filter(block => block.type === 'json' && block.value?.format === 'file_changes').flatMap(block => block.value.files);
  assert.ok(files.some(file => file.path.endsWith('fixture.ts') && file.diff.includes('-export const result = "before";') && file.diff.includes('+export const result = "after";')), 'Native edit diff must reach the product file_changes renderer.');
  await until(() => runtime.replica.getState().agent?.lastUsage?.contextWindowMaxTokens === 128000, 'native model context capacity');
  evidence.usage = runtime.replica.getState().agent.lastUsage;
  assert.ok(evidence.usage.contextWindowUsedTokens > 0, 'Native context usage must be populated.');
  evidence.checks.usage = true;
  assert.ok(evidence.interactions.some(item => item.kind === 'tool_approval'), 'A real native permission must be answered.');
  assert.ok(evidence.interactions.some(item => item.kind === 'question'), 'A real native question must be answered.');
  assert.match(await readFile(join(cwd, 'fixture.ts'), 'utf8'), /result = "after"/);
  const nativeHistory = await fetch(`${serverUrl}/session/${session.nativeSessionId}/message?directory=${encodeURIComponent(cwd)}`, { headers, signal: AbortSignal.timeout(10000) });
  assert.equal(nativeHistory.status, 200);
  evidence.nativeTools = (await nativeHistory.json()).flatMap(message => message.parts.filter(part => part.type === 'tool').map(part => ({ tool: part.tool, state: part.state })));
  Object.assign(evidence.checks, { text: true, shell: true, fileDiff: true, permission: true, question: true });
  if (settings().some(setting => setting.id === 'permission:*')) {
    await runtime.client.setSessionSetting('permission:*', 'ask');
    await until(() => settings().some(setting => setting.id === 'permission:*' && setting.value === 'ask'), 'permission setting round trip');
    evidence.checks.permissionSetting = true;
  } else throw new Error('Native session permission settings were not exposed.');
  const commands = await runtime.client.listCommands(); evidence.commands = commands;
  evidence.checks.skillCatalog = commands.some(command => command.name === 'arc-debug' || command.id.includes('arc-debug'));
  assert.ok(evidence.checks.skillCatalog, 'Native fixture skill must appear in the command catalog.');
  await nativeRequest(`/session/${source.id}/message`, { noReply: true, parts: [{ type: 'text', text: 'ARC_SOURCE_UPDATED: appended after the Ask session opened.' }] });
  const sourceProgress = runtime.captureProgress();
  await runtime.client.sendMessage('ARC_DEBUG_SOURCE: discover and read the latest source update.');
  await until(() => JSON.stringify(runtime.replica.getState().timeline).includes('ARC_SOURCE_COMPLETE:'), 'dynamic source callback through ARDB');
  await runtime.waitFor('idle', 20000, sourceProgress);
  evidence.checks.dynamicSourceRead = true;
  const steerProgress = runtime.captureProgress();
  await runtime.client.sendMessage('ARC_DEBUG_HOLD: keep this context while a live follow-up arrives.');
  await until(() => modelHeld, 'native model request held during work');
  await runtime.client.steer('ARC_DEBUG_STEER: continue with the preserved context.');
  releaseModel();
  await until(() => JSON.stringify(runtime.replica.getState().timeline).includes('ARC_STEER_COMPLETE:'), 'native steer through ARDB');
  await runtime.waitFor('idle', 20000, steerProgress);
  const steerEchoes = runtime.replica.getState().timeline.entries.filter(entry => entry.item.type === 'user_message' && entry.item.text.includes('ARC_DEBUG_STEER'));
  assert.equal(steerEchoes.length, 1, 'The real replica must contain exactly one native steer echo.');
  evidence.checks.steer = true;
  const compact = commands.find(command => command.id === 'opencode:compact' || command.name === 'compact');
  if (compact) {
    const compactProgress = runtime.captureProgress();
    await within(runtime.client.executeCommand(compact.id, ''), 30000, 'Native compact command timed out.');
    await until(() => JSON.stringify(runtime.replica.getState().timeline).includes('compaction'), 'native compaction timeline');
    await runtime.waitFor('idle', 30000, compactProgress);
    evidence.checks.compaction = true;
  } else throw new Error('Native compact command was not exposed.');
  await json(`${workspace.url}/__ardb/recording/stop`, { id: captureId });
  const exported = await fetch(`${workspace.url}/__ardb/recording/export?id=${encodeURIComponent(captureId)}`, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]) });
  assert.equal(exported.status, 200);
  const jsonl = await exported.text(); const recording = parseRecording(jsonl);
  assert.equal(recording.agentId, session.agentId); assert.ok(recording.events.length > 10);
  assert.ok(recording.events.some(event => event.record.kind === 'interaction_requested'));
  assert.ok(!recording.warnings.some(warning => warning.includes('completion is unknown')));
  await writeFile(recordingPath, jsonl, { flag: 'wx' });
  evidence.recording = { events: recording.events.length, duration: recording.duration, warnings: recording.warnings };
  evidence.replicaDiagnostics = runtime.replica.getState().diagnostics;
  assert.ok(!evidence.connection.some(item => item.status === 'disconnected'), 'The native scenario must not break its Remote connection.');
  assert.equal(evidence.modelError, undefined, 'The deterministic model fixture must complete without hidden handler failures.');
  evidence.checks.recording = true; completed = true;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ event: 'scenario_complete', url: workspace.url, agentId: session.agentId, recordingPath, evidencePath, checks: evidence.checks, usage: evidence.usage, recording: evidence.recording, modelRequests: evidence.modelRequests.length }));
  clearTimeout(scenarioDeadline);
  if (args.includes('--keep')) {
    console.log(JSON.stringify({ event: 'kept_alive', url: workspace.url, milliseconds: holdMs, browserPrompt: 'ARC_DEBUG_QUESTION', replayFile: recordingPath }));
    await sleep(holdMs, undefined, { signal: stop.signal }).catch(error => { if (!stop.signal.aborted) throw error; });
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.stack : String(error);
  if (runtime) evidence.replicaDiagnostics = runtime.replica.getState().diagnostics;
  if (workspace && captureId && !completed) {
    try {
      const stopped = await fetch(`${workspace.url}/__ardb/recording/stop`, { method: 'POST', headers: { Origin: workspace.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: captureId }), signal: AbortSignal.timeout(5000) });
      assert.ok(stopped.ok);
      const exported = await fetch(`${workspace.url}/__ardb/recording/export?id=${encodeURIComponent(captureId)}`, { signal: AbortSignal.timeout(5000) });
      assert.ok(exported.ok);
      await writeFile(recordingPath, await exported.text(), { flag: 'wx' });
      evidence.partialRecording = true;
    } catch (captureError) { evidence.captureError = String(captureError); }
  }
  console.error(JSON.stringify({ event: 'scenario_failed', error: evidence.error, url: workspace?.url, modelError: evidence.modelError, modelRequests: evidence.modelRequests }));
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2), { flag: 'wx' }).catch(() => {});
  process.exitCode = 1;
  if (args.includes('--keep') && workspace && !stop.signal.aborted) {
    clearTimeout(scenarioDeadline);
    console.log(JSON.stringify({ event: 'kept_failure', url: workspace.url, milliseconds: holdMs, evidencePath, recordingPath }));
    await sleep(holdMs, undefined, { signal: stop.signal }).catch(holdError => { if (!stop.signal.aborted) throw holdError; });
  }
} finally {
  clearTimeout(scenarioDeadline);
  releaseModel?.();
  runtime?.close();
  await workspace?.close().catch(error => console.error(`Debugger close: ${error}`));
  if (native && native.exitCode === null) {
    native.kill(); await within(new Promise(done => native.once('exit', done)), 4000, 'Native server shutdown timed out.').catch(() => {});
    if (native.exitCode === null) native.kill('SIGKILL');
  }
  if (model) { model.closeAllConnections(); await new Promise(done => model.close(done)); }
  await writeFile(nativeLogPath, diagnostics, { flag: 'wx' }).catch(() => {});
  if (root) await rm(root, { recursive: true, force: true });
  if (completed) console.log(JSON.stringify({ event: 'cleaned_up', recordingPath, evidencePath }));
}
