import { createAgentHostRuntime } from '../../agent-host/src/host.js';
import { createCodexSessionDirectory } from '../../agent-host/src/directory.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { AgentSession, AgentStreamEvent, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { CodexAppServerProvider } from './provider.js';

const executable = process.env.AGENT_REMOTE_SHARED_CODEX_TEST_EXECUTABLE;

async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'arc-shared-'));
  const socketPath = join(home, 'server.sock');
  let ordinal = 0;
  let pendingResponse: (() => void) | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const id = ++ordinal;
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const input = body.input ?? [];
      const lastUser = input.findLastIndex((item: any) => item.role === 'user');
      const prompt = JSON.stringify(input[lastUser]);
      const answer = input.slice(lastUser + 1).find((item: any) => item.type === 'function_call_output');
      const item = !answer && prompt.includes('source reference') ? {
        type: 'function_call', call_id: `source-${id}`, name: 'read_source_session', arguments: JSON.stringify({ limit: 2 }),
      } : !answer && prompt.includes('question') ? {
        type: 'function_call', call_id: `question-${id}`, name: 'request_user_input',
        arguments: JSON.stringify({ questions: [{ id: 'choice', header: 'Choice', question: 'Choose one',
          options: [{ label: 'First', description: 'First option' }, { label: 'Second', description: 'Second option' }] }] }),
      } : { type: 'message', role: 'assistant', id: `message-${id}`,
        content: [{ type: 'output_text', text: answer ? 'ANSWER_RECEIVED' : 'SHARED_OK' }] };
      const events = [
        { type: 'response.created', response: { id: `response-${id}` } },
        { type: 'response.output_item.done', item },
        { type: 'response.completed', response: { id: `response-${id}`, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const finish = () => response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      if (prompt.includes('hold for controller upgrade')) pendingResponse = finish;
      else finish();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await writeFile(join(home, 'config.toml'), `model = "mock-model"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "read-only"
[features]
default_mode_request_user_input = true
[model_providers.fixture]
name = "Local shared runtime fixture"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
`);
  const env = { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: 'local-fixture' };
  let stderr = '';
  let daemon = launchDaemon();
  const sessions: AgentSession[] = [];
  function launchDaemon(): ChildProcessWithoutNullStreams {
    const child = spawn(executable!, ['app-server', '--listen', `unix://${socketPath}`], { env, stdio: 'pipe' });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.resume();
    return child;
  }
  async function waitForDaemon(): Promise<void> {
    const deadline = Date.now() + 8000;
    while (!await stat(socketPath).then(info => info.isSocket(), () => false)) {
      if (daemon.exitCode !== null || Date.now() > deadline) throw new Error(`Shared daemon unavailable: ${stderr}`);
      await delay(20);
    }
  }
  const restartDaemon = async () => {
    await rm(socketPath, { force: true });
    stderr = '';
    daemon = launchDaemon();
    await waitForDaemon();
  };
  const close = async () => {
    await Promise.allSettled(sessions.map(session => session.dispose()));
    await stop(daemon);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  };
  try {
    await waitForDaemon();
    const provider = () => new CodexAppServerProvider({ executable, env, connectionMode: 'shared', socketPath, requestTimeoutMs: 5000 });
    return { home, env, get hasPendingResponse() { return !!pendingResponse; }, releaseResponse() { pendingResponse?.(); pendingResponse = undefined; }, get daemon() { return daemon; }, sessions, provider, restartDaemon, close };
  } catch (error) { await close(); throw error; }
}

async function until(stream: AsyncIterator<ProviderStreamItem>, predicate: (event: AgentStreamEvent) => boolean) {
  const events: AgentStreamEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) throw new Error('Stream ended before expected event');
    if (next.value.type !== 'observation') continue;
    const event = next.value.event;
    events.push(event);
    if (predicate(event)) return events;
    if (event.type === 'turn_failed') throw new Error(JSON.stringify(event));
  }
}

it.runIf(executable)('shares a live native thread, accepts messages from both clients and keeps the other client alive after disposal', async () => {
  const f = await fixture();
  try {
    const desktop = await f.provider().createSession({ sessionId: 'desktop', cwd: f.home }); f.sessions.push(desktop);
    const desktopStream = desktop.observe()[Symbol.asyncIterator]();
    await desktopStream.next();
    await desktop.sendMessage('Hello from desktop');
    await until(desktopStream, event => event.type === 'turn_completed');
    const handle = (await desktop.runtimeInfo()).persistence!;
    const mobile = await f.provider().resumeSession(handle); f.sessions.push(mobile);
    const mobileStream = mobile.observe()[Symbol.asyncIterator]();
    const history: AgentStreamEvent[] = [];
    while (true) {
      const next = await mobileStream.next();
      if (next.done || next.value.type === 'history_boundary') break;
      history.push(next.value.event);
    }
    expect(history).toContainEqual(expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'SHARED_OK' }) }));
    await mobile.sendMessage('Hello from mobile');
    const both = await Promise.all([desktopStream, mobileStream].map(stream => until(stream, event => event.type === 'turn_completed')));
    for (const events of both) {
      expect(events).toContainEqual(expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'user_message', text: 'Hello from mobile' }) }));
    }
    await desktop.sendMessage('Both clients see desktop');
    const desktopEvents = await Promise.all([desktopStream, mobileStream].map(stream => until(stream, event => event.type === 'turn_completed')));
    for (const events of desktopEvents) expect(events).toContainEqual(expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'user_message', text: 'Both clients see desktop' }) }));
    await mobile.dispose();
    expect(f.daemon.exitCode).toBeNull();
    await desktop.sendMessage('Desktop continues');
    await until(desktopStream, event => event.type === 'turn_completed');
  } finally { await f.close(); }
}, 30000);

it.runIf(executable)('disconnects one question subscriber without interrupting the remaining client', async () => {
  const f = await fixture();
  try {
    const desktop = await f.provider().createSession({ sessionId: 'desktop', cwd: f.home }); f.sessions.push(desktop);
    const desktopStream = desktop.observe()[Symbol.asyncIterator]();
    await desktop.sendMessage('Ask a question');
    const question = (await until(desktopStream, event => event.type === 'interaction_requested')).at(-1)!;
    if (question.type !== 'interaction_requested') throw new Error('Expected question');
    const mobile = await f.provider().resumeSession((await desktop.runtimeInfo()).persistence!); f.sessions.push(mobile);
    await until(mobile.observe()[Symbol.asyncIterator](), event => event.type === 'interaction_requested');
    await mobile.dispose();
    await desktop.respondToInteraction!(question.request.requestId, { kind: 'question', answers: [{ questionId: 'choice', selectedValues: ['Second'] }] });
    const events = await until(desktopStream, event => event.type === 'turn_completed');
    expect(events).toContainEqual(expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'ANSWER_RECEIVED' }) }));
    expect(f.daemon.exitCode).toBeNull();
  } finally { await f.close(); }
}, 30000);

it.runIf(executable)('recovers the stable session after an isolated native daemon restart without accepting disconnected mutations', async () => {
  const f = await fixture();
  try {
    const session = await f.provider().createSession({ sessionId: 'desktop', cwd: f.home }); f.sessions.push(session);
    const stream = session.observe()[Symbol.asyncIterator]();
    while ((await stream.next()).value?.type !== 'history_boundary') { /* Drain bootstrap. */ }
    await session.sendMessage('Persist before restart');
    await until(stream, event => event.type === 'turn_completed');
    await stop(f.daemon);
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('reconnecting');
    await expect(session.sendMessage('Must not send')).rejects.toThrow(/reconnecting|restoring/i);
    await f.restartDaemon();
    while ((await stream.next()).value?.type !== 'timeline_replacement') { /* Drain recovery state. */ }
    await expect.poll(async () => (await session.runtimeInfo()).connection?.state).toBe('connected');
    await session.sendMessage('Continue after recovery');
    await expect(until(stream, event => event.type === 'turn_completed')).resolves.toContainEqual(
      expect.objectContaining({ type: 'timeline', item: expect.objectContaining({ type: 'assistant_message', text: 'SHARED_OK' }) }),
    );
  } finally { await f.close(); }
}, 30000);

it.runIf(executable)('replays a pending question to a joining client and resolves it on both clients when either answers', async () => {
  const f = await fixture();
  try {
    const desktop = await f.provider().createSession({ sessionId: 'desktop', cwd: f.home }); f.sessions.push(desktop);
    const desktopStream = desktop.observe()[Symbol.asyncIterator]();
    await desktop.sendMessage('Ask a question');
    const desktopQuestion = (await until(desktopStream, event => event.type === 'interaction_requested')).at(-1)!;
    expect(desktopQuestion.type).toBe('interaction_requested');
    const mobile = await f.provider().resumeSession((await desktop.runtimeInfo()).persistence!); f.sessions.push(mobile);
    const mobileStream = mobile.observe()[Symbol.asyncIterator]();
    const mobileQuestion = (await until(mobileStream, event => event.type === 'interaction_requested')).at(-1)!;
    if (mobileQuestion.type !== 'interaction_requested' || desktopQuestion.type !== 'interaction_requested') throw new Error('Expected questions');
    const answer = { kind: 'question' as const, answers: [{ questionId: 'choice', selectedValues: ['First'] }] };
    await mobile.respondToInteraction!(mobileQuestion.request.requestId, answer);
    const both = await Promise.all([desktopStream, mobileStream].map(stream => until(stream, event => event.type === 'turn_completed')));
    for (const events of both) expect(events.filter(event => event.type === 'interaction_resolved')).toHaveLength(1);
    await expect(desktop.respondToInteraction!(desktopQuestion.request.requestId, answer)).rejects.toThrow('No pending');
    await expect(mobile.respondToInteraction!(mobileQuestion.request.requestId, answer)).rejects.toThrow('No pending');
  } finally { await f.close(); }
}, 30000);


it.runIf(executable)('dispatches persisted dynamic source tools through a real daemon after restart', async () => {
  const f = await fixture();
  try {
    const source = await f.provider().createSession({ sessionId: 'source', cwd: f.home }); f.sessions.push(source);
    const sourceStream = source.observe()[Symbol.asyncIterator]();
    await source.sendMessage('Background decision: amber river.');
    await until(sourceStream, event => event.type === 'turn_completed');
    const sourceId = (await source.runtimeInfo()).sessionId!;
    await source.dispose();
    let calls = 0;
    const tools = [{ name: 'read_source_session', description: 'Read the granted source session.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
      execute: async () => { calls += 1; const page = await f.provider().readSessionHistory(sourceId, { limit: 2 }); expect(page.entries.some(entry => entry.text.includes('amber river'))).toBe(true); return JSON.stringify(page); } }];
    const first = await f.provider().createSession({ sessionId: 'side', cwd: f.home, tools, systemPrompt: 'Use read_source_session for background.' });
    f.sessions.push(first);
    const initial = first.observe()[Symbol.asyncIterator]();
    await first.sendMessage('Use the source reference.');
    await until(initial, event => event.type === 'turn_completed');
    expect(calls).toBe(1);
    const handle = (await first.runtimeInfo()).persistence!;
    const page = await f.provider().readSessionHistory(handle.sessionId, { limit: 2 });
    expect(page.entries.some(entry => entry.text.includes('ANSWER_RECEIVED'))).toBe(true);
    await first.dispose();
    await stop(f.daemon); await f.restartDaemon();
    const coldSearch = await f.provider().readSessionHistory(sourceId, { query: 'amber river', limit: 1 });
    expect(coldSearch.entries[0]?.text).toContain('amber river');
    const resumed = await f.provider().resumeSession(handle, { tools }); f.sessions.push(resumed);
    const stream = resumed.observe()[Symbol.asyncIterator]();
    while ((await stream.next()).value?.type !== 'history_boundary') { /* Drain saved history. */ }
    await resumed.sendMessage('Use the source reference again.');
    await until(stream, event => event.type === 'turn_completed');
    expect(calls).toBe(2);
  } finally { await f.close(); }
}, 30_000);


it.runIf(executable)('reconciles an unknown send and resumes after release while an independent native client keeps working', async () => {
  const f = await fixture();
  const provider = f.provider();
  const directory = createCodexSessionDirectory(provider, []);
  const host = createAgentHostRuntime({ registrations: [{ adapter: provider, directory }], idleGraceMs: 100, idleReconcileMs: 100 });
  try {
    const desktop = await f.provider().createSession({ sessionId: 'desktop', cwd: f.home }); f.sessions.push(desktop);
    const stream = desktop.observe()[Symbol.asyncIterator]();
    await desktop.sendMessage('History before mobile sleep');
    await until(stream, event => event.type === 'turn_completed');
    const id = (await desktop.runtimeInfo()).sessionId!;
    const attached = await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'mobile',
      body: JSON.stringify({ providerId: 'codex', nativeSessionId: id }) });
    expect(attached.status).toBe(200);
    const lease = await host.acquireSession('mobile');
    expect(lease).toBeDefined();
    const original = await directory.open(id);
    await expect.poll(() => provider.canReleaseSession(id)).toBe(true);
    const operation = { operationId: '01234567-1234-4234-8234-123456789abc', kind: 'send_message' as const,
      parameters: { text: 'Native message with lost acknowledgement' } };
    let dispatches = 0;
    const work = { dispatch: async () => {
      dispatches++;
      await lease!.agent.sendMessage('Native message with lost acknowledgement');
      throw new Error('Simulated lost acknowledgement after native dispatch');
    } };
    await expect(host.executeOperation('native-test')(lease!.agent, operation, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    await until(stream, event => event.type === 'turn_completed');
    lease!.release();
    await expect.poll(async () => (await original.runtimeInfo()).status).toBe('closed');
    expect(f.daemon.exitCode).toBeNull();
    await desktop.sendMessage('Desktop continues while mobile is detached');
    await until(stream, event => event.type === 'turn_completed');
    const restored = await host.acquireSession('mobile');
    expect(restored!.agent.snapshot().payload.runtimeInfo.sessionId).toBe(id);
    await expect(host.executeOperation('native-test')(restored!.agent, operation, work)).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(dispatches).toBe(1);
    const history = host.relay.requireAgent('mobile').fetchTimeline({ requestId: 'tail', agentId: 'mobile', direction: 'tail', limit: 100 });
    expect(JSON.stringify(history)).toContain('History before mobile sleep');
    expect(JSON.stringify(history)).toContain('Desktop continues while mobile is detached');
    await restored!.agent.sendMessage('Mobile resumes the same conversation');
    await until(stream, event => event.type === 'turn_completed');
    restored!.release();
  } finally { await host.close(); await f.close(); }
}, 30000);


it.runIf(executable)('keeps a running turn alive with no Controller subscriber during an upgrade', async () => {
  const f = await fixture();
  const provider = f.provider();
  const directory = createCodexSessionDirectory(provider, []);
  const host = createAgentHostRuntime({ registrations: [{ adapter: provider, directory, preservesWorkOnDisconnect: true }] });
  try {
    const native = await directory.create({ cwd: f.home });
    await host.control({ method: 'POST', path: '/remote/attach', sessionId: 'upgrade-session', body: JSON.stringify({ providerId: 'codex', nativeSessionId: native }) });
    const lease = await host.acquireSession('upgrade-session');
    await lease!.agent.sendMessage('Please hold for controller upgrade');
    await expect.poll(() => f.hasPendingResponse).toBe(true);
    const handle = (await (await directory.open(native)).runtimeInfo()).persistence!;
    expect(host.beginControllerRestart()).toBe(true);
    await host.close();
    expect(f.daemon.exitCode).toBeNull();
    f.releaseResponse();
    await expect.poll(async () => JSON.stringify(await f.provider().readSessionHistory(native, { limit: 2 })), { timeout: 8000 }).toContain('SHARED_OK');
    const restored = await f.provider().resumeSession(handle); f.sessions.push(restored);
    const stream = restored.observe()[Symbol.asyncIterator]();
    while ((await stream.next()).value?.type !== 'history_boundary') { /* Drain history. */ }
    await restored.sendMessage('Continue after controller upgrade');
    await until(stream, event => event.type === 'turn_completed');
    expect(f.daemon.exitCode).toBeNull();
  } finally { f.releaseResponse(); await host.close(); await f.close(); }
}, 30000);


it.runIf(executable && process.platform !== 'win32')('takes a private writer into shared with the same history and leaves other sessions alive', async () => {
  const f = await fixture();
  let privateProcess: ChildProcessWithoutNullStreams | undefined;
  const provider = new CodexAppServerProvider({env: f.env, spawn: () => {
    privateProcess = spawn(executable!, ['app-server'], {env: f.env, stdio: 'pipe'});
    return privateProcess;
  }});
  const directory = createCodexSessionDirectory(f.provider(), []);
  try {
    const original = await provider.createSession({sessionId: 'original', cwd: f.home}); f.sessions.push(original);
    const stream = original.observe()[Symbol.asyncIterator]();
    await original.sendMessage('Private history'); await until(stream, event => event.type === 'turn_completed');
    const id = (await original.runtimeInfo()).sessionId!;
    const shared = await f.provider().createSession({sessionId: 'unrelated', cwd: f.home}); f.sessions.push(shared);
    const failure: any = await directory.open(id).catch(error => error);
    expect(failure).toMatchObject({code: 'native_session_owned', owner: {kind: 'native_cli'}});
    expect(privateProcess!.exitCode).toBeNull(); expect(privateProcess!.signalCode).toBeNull();
    await expect(directory.open(id, {takeOver: '00000000-0000-4000-8000-000000000000'})).rejects.toMatchObject({code: 'native_owner_changed'});
    const resumed = await directory.open(id, {takeOver: failure.owner.generation});
    expect(privateProcess!.exitCode !== null || privateProcess!.signalCode !== null).toBe(true);
    expect(await resumed.runtimeInfo()).toMatchObject({sessionId: id});
    expect(resumed.capabilities.sessionControl).toBe('shared');
    const resumedStream = resumed.observe()[Symbol.asyncIterator]();
    const history: ProviderStreamItem[] = [];
    while (true) { const next = await resumedStream.next(); if (next.done || next.value.type === 'history_boundary') break; history.push(next.value); }
    expect(JSON.stringify(history)).toContain('Private history');
    await resumed.sendMessage('Shared continuation'); await until(resumedStream, event => event.type === 'turn_completed');
    expect(await directory.open(id)).toBe(resumed);
    expect(await f.provider().inspectSessionOwner(id)).toBeUndefined();
    const otherStream = shared.observe()[Symbol.asyncIterator]();
    await shared.sendMessage('Unrelated still works'); await until(otherStream, event => event.type === 'turn_completed');
    expect(f.daemon.exitCode).toBeNull();
  } finally { await directory.close(); await f.close(); if (privateProcess) await stop(privateProcess); }
}, 30000);


it.runIf(executable && process.platform !== 'win32')('does not offer process takeover when the private app-server owns another session', async () => {
  const f = await fixture();
  let child: ChildProcessWithoutNullStreams | undefined;
  const provider = new CodexAppServerProvider({env: f.env, spawn: () => {
    child = spawn(executable!, ['app-server'], {env: f.env, stdio: 'pipe'}); return child;
  }});
  const directory = createCodexSessionDirectory(f.provider(), []);
  try {
    const original = await provider.createSession({sessionId: 'original', cwd: f.home}); f.sessions.push(original);
    const stream = original.observe()[Symbol.asyncIterator]();
    await original.sendMessage('First writer'); await until(stream, event => event.type === 'turn_completed');
    const id = (await original.runtimeInfo()).sessionId!;
    const {createInterface} = await import('node:readline');
    const reader = createInterface({input: child!.stdout});
    try {
      const second = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Second native thread did not start')), 3000);
        reader.on('line', line => {const value = JSON.parse(line); if (value.id === 900001) {clearTimeout(timer); value.error ? reject(new Error(JSON.stringify(value.error))) : resolve(value.result);}});
      });
      child!.stdin.write(JSON.stringify({id: 900001, method: 'thread/start', params: {cwd: f.home}}) + '\n');
      await second;
    } finally { reader.close(); child!.stdout.resume(); }
    await expect(directory.open(id)).rejects.toMatchObject({name: 'AgentSessionInUseError'});
    expect(child!.exitCode).toBeNull(); expect(child!.signalCode).toBeNull();
    await original.sendMessage('Both writers were preserved'); await until(stream, event => event.type === 'turn_completed');
  } finally { await directory.close(); await f.close(); if (child) await stop(child); }
}, 30000);

it.runIf(executable && process.platform !== 'win32')('interrupts a working private session and continues only after explicit shared input', async () => {
  const f = await fixture();
  let child: ChildProcessWithoutNullStreams | undefined;
  const provider = new CodexAppServerProvider({env: f.env, spawn: () => {
    child = spawn(executable!, ['app-server'], {env: f.env, stdio: 'pipe'}); return child;
  }});
  const directory = createCodexSessionDirectory(f.provider(), []);
  try {
    const original = await provider.createSession({sessionId: 'working', cwd: f.home}); f.sessions.push(original);
    const stream = original.observe()[Symbol.asyncIterator]();
    await original.sendMessage('hold for controller upgrade');
    await until(stream, event => event.type === 'turn_started');
    const waitingUntil = Date.now() + 3000;
    while (!f.hasPendingResponse && Date.now() < waitingUntil) await delay(10);
    expect(f.hasPendingResponse).toBe(true);
    const id = (await original.runtimeInfo()).sessionId!;
    const failure: any = await directory.open(id).catch(error => error);
    expect(failure.code).toBe('native_session_owned');
    const resumed = await directory.open(id, {takeOver: failure.owner.generation});
    expect(await resumed.runtimeInfo()).toMatchObject({sessionId: id, status: 'idle'});
    f.releaseResponse();
    const events = resumed.observe()[Symbol.asyncIterator]();
    await resumed.sendMessage('Continue after takeover');
    await until(events, event => event.type === 'turn_completed');
    expect(f.daemon.exitCode).toBeNull();
  } finally { await directory.close(); await f.close(); if (child) await stop(child); }
}, 30000);
