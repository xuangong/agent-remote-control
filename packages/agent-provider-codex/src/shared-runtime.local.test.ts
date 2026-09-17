import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import type { AgentSession, AgentStreamEvent, ProviderStreamItem } from '@agent-remote-controller/agent-provider-sdk';
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
      const item = !answer && prompt.includes('question') ? {
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
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
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
    return { home, get daemon() { return daemon; }, sessions, provider, restartDaemon, close };
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
