import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { OpenCodeImages } from './images.js';
import type { AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import { OpenCodeAgentProvider } from './provider.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const streams = new Set<ServerResponse>();
  let connections = 0;
  const requests: Array<{ method: string; path: string; body: any }> = [];
  let messages: any[] = [];
  let historyBarrier: { arrive(): void; wait: Promise<void> } | undefined;
  let failHistoryReads = 0;
  let status: any = { type: 'idle' };
  let permissions: any[] = [];
  let questions: any[] = [];
  let rejectPrompt = false;
  let abortBarrier: { arrive(): void; wait: Promise<void> } | undefined;
  let promptStatus = 204;
  let health: unknown = { healthy: true, version: '1.18.31' };
  let title = 'Native title';
  let nativeSelection: any = {};
  let children: any[] = [];
  let connectedProviders = ['test'];
  let globalSessions: any[] | undefined;
  let globalListingStatus = 200;
  const native = () => ({ id: 'ses_test', title, ...nativeSelection, directory: process.cwd(), time: { created: 1000, updated: 2000 } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/global/event') {
      connections++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      streams.add(res); res.on('close', () => streams.delete(res));
      res.write(`data: ${JSON.stringify({ directory: process.cwd(), payload: { type: 'server.connected', properties: {} } })}\n\n`);
      return;
    }
    let data = ''; for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : undefined;
    requests.push({ method: req.method!, path: url.pathname, body });
    const json = (value: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/global/health') return json(health);
    if (url.pathname === '/experimental/session') {
      if (globalListingStatus !== 200) { res.writeHead(globalListingStatus); res.end(); return; }
      const cursor = url.searchParams.get('cursor'); const limit = Number(url.searchParams.get('limit') ?? 100);
      const eligible = (globalSessions ?? [native()]).filter(session => cursor === null || session.time.updated < Number(cursor));
      const page = eligible.slice(0, limit);
      if (eligible.length > limit) res.setHeader('X-Next-Cursor', String(page.at(-1).time.updated));
      return json(page);
    }
    if (url.pathname === '/session' && req.method === 'POST') return json(native());
    if (url.pathname === '/session') return json([native()]);
    if (url.pathname === '/session/status') return json({ ses_test: status });
    if (url.pathname === '/session/ses_test/children') return json(children);
    if (url.pathname === '/api/session/ses_test/model' || url.pathname === '/api/session/ses_test/agent') {
      Object.assign(nativeSelection, body); emit('session.updated', { info: native() }); res.writeHead(204); res.end(); return;
    }
    if (url.pathname === '/session/ses_test') { if (req.method === 'PATCH') title = body.title; return json(native()); }
    if (url.pathname === '/session/ses_test/message') {
      if (failHistoryReads-- > 0) { res.writeHead(500); res.end(); return; }
      const before = url.searchParams.get('before');
      const cursor = before ? JSON.parse(Buffer.from(before, 'base64url').toString()) : undefined;
      const eligible = cursor ? messages.filter(message => message.info.time.created < cursor.time || (message.info.time.created === cursor.time && message.info.id < cursor.id)) : messages;
      const limit = Number(url.searchParams.get('limit') ?? eligible.length);
      const snapshot = structuredClone(eligible.slice(-limit));
      if (eligible.length > limit && snapshot[0]) res.setHeader('X-Next-Cursor', Buffer.from(JSON.stringify({ id: snapshot[0].info.id, time: snapshot[0].info.time.created })).toString('base64url'));
      const barrier = historyBarrier; historyBarrier = undefined;
      if (barrier) { barrier.arrive(); await barrier.wait; }
      return json(snapshot);
    }
    if (url.pathname === '/session/ses_test/todo') return json([]);
    if (url.pathname === '/permission') return json(permissions);
    if (url.pathname === '/question') return json(questions);
    if (url.pathname === '/provider') return json({ all: [{ id: 'test', name: 'Test', models: { model: { id: 'model', name: 'Test model' } } }], connected: connectedProviders, default: { test: 'model' } });
    if (url.pathname === '/agent') return json([{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }]);
    if (url.pathname === '/command') return json([{ name: 'check', description: 'Check project' }]);
    if (url.pathname.endsWith('/abort') && abortBarrier) {
      const barrier = abortBarrier; abortBarrier = undefined; barrier.arrive(); await barrier.wait; return json(true);
    }
    if (url.pathname.endsWith('/prompt_async')) {
      if (rejectPrompt) return req.socket.destroy();
      if (promptStatus !== 204) { res.writeHead(promptStatus); res.end(); return; }
      messages.push({ info: { id: body.messageID, role: 'user', sessionID: 'ses_test', model: body.model, agent: body.agent, time: { created: Date.now() } }, parts: body.parts.map((p: any, i: number) => ({ ...p, id: `prt_${i}`, messageID: body.messageID, sessionID: 'ses_test' })) });
      res.writeHead(204); res.end();
      emit('message.updated', { info: messages.at(-1).info }); return;
    }
    return json(true);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const emit = (type: string, properties: any) => { for (const stream of streams) stream.write(`data: ${JSON.stringify({ directory: process.cwd(), payload: { type, properties } })}\n\n`); };
  cleanups.push(async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); server.close(); await once(server, 'close'); });
  return { set health(value: unknown) { health = value; }, url: `http://127.0.0.1:${(server.address() as any).port}`, requests, emit, native, set nativeSelection(value: any) { nativeSelection = value; }, set children(value: any[]) { children = value; }, set globalSessions(value: any[]) { globalSessions = value; }, set globalListingStatus(value: number) { globalListingStatus = value; }, set connectedProviders(value: string[]) { connectedProviders = value; }, get connections() { return connections; }, get activeConnections() { return streams.size; }, set failHistoryReads(value: number) { failHistoryReads = value; }, blockNextHistory() {
    let arrive!: () => void; let release!: () => void; const arrived = new Promise<void>(resolve => { arrive = resolve; });
    historyBarrier = { arrive, wait: new Promise<void>(resolve => { release = resolve; }) }; return { arrived, release };
  }, blockNextAbort() {
    let arrive!: () => void; let release!: () => void; const arrived = new Promise<void>(resolve => { arrive = resolve; });
    abortBarrier = { arrive, wait: new Promise<void>(resolve => { release = resolve; }) }; return { arrived, release };
  }, get messages() { return messages; }, set messages(value) { messages = value; }, get status() { return status; }, set status(value) { status = value; }, set permissions(value) { permissions = value; }, set questions(value) { questions = value; }, set rejectPrompt(value) { rejectPrompt = value; }, set promptStatus(value: number) { promptStatus = value; }, disconnect() { for (const stream of streams) stream.destroy(); } };
}
function observe(session: AgentSession) {
  const items: ProviderStreamItem[] = [];
  const task = (async () => { for await (const item of session.observe()) items.push(item); })();
  cleanups.push(async () => { await session.dispose(); await task; });
  return items;
}
async function waitFor(predicate: () => boolean) { await expect.poll(predicate, { timeout: 4000, interval: 10 }).toBe(true); }
function timeline(items: ProviderStreamItem[]) {
  let result: any[] = [];
  for (const item of items) {
    if (item.type === 'timeline_replacement') result = item.observations.flatMap(o => o.event.type === 'timeline' ? [o.event.item] : []);
    if (item.type === 'observation' && item.event.type === 'timeline') {
      const next = structuredClone(item.event.item); const last = result.at(-1);
      if (last?.type === next.type && (next.type === 'assistant_message' && last.messageId === next.messageId || next.type === 'reasoning')) last.text += next.text;
      else result.push(next);
    }
  }
  return result;
}
const assistant = (text: string) => ({ info: { id: 'msg_assistant', sessionID: 'ses_test', role: 'assistant', parentID: 'msg_user', time: { created: 3000 }, tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 1, write: 0 } }, cost: .01 }, parts: [{ type: 'text', id: 'prt_text', messageID: 'msg_assistant', sessionID: 'ses_test', text }] });

test('shares native sessions, emits a history boundary and native input echo, and never aborts on dispose', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() });
  expect(session.capabilities.sessionControl).toBe('shared');
  const items = observe(session);
  await waitFor(() => items.some(i => i.type === 'history_boundary'));
  await session.sendMessage('Hello');
  await waitFor(() => timeline(items).some(i => i.type === 'user_message' && i.text === 'Hello'));
  await session.dispose();
  expect(f.requests.filter(r => r.path.endsWith('/abort'))).toHaveLength(0);
}, 10000);

test('reconciles final text, duplicate notifications and missed events after reconnect without failing the turn', async () => {
  const f = await fixture(); f.messages = [assistant('Hel')]; f.status = { type: 'busy' };
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_test', opaque: JSON.stringify({ cwd: process.cwd() }) });
  const items = observe(session); await waitFor(() => timeline(items).length === 1);
  f.messages = [assistant('Hello')]; f.emit('message.part.updated', { part: f.messages[0].parts[0] });
  f.emit('message.part.updated', { part: f.messages[0].parts[0] });
  await waitFor(() => timeline(items)[0]?.text === 'Hello');
  f.disconnect(); f.messages = [assistant('Hello recovered')];
  await waitFor(() => timeline(items)[0]?.text === 'Hello recovered');
  expect(timeline(items)).toHaveLength(1);
  expect(items.some(i => i.type === 'observation' && i.event.type === 'turn_failed')).toBe(false);
}, 10000);

test('does not replay an uncertain prompt and rejects unsupported queued delivery', async () => {
  const f = await fixture(); const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  await expect(session.sendMessage('queued', { delivery: 'next_turn' })).rejects.toThrow();
  f.rejectPrompt = true; await expect(session.sendMessage('uncertain')).rejects.toThrow();
  expect(f.requests.filter(r => r.path.endsWith('/prompt_async'))).toHaveLength(1);
}, 10000);

test('lists and reads native sessions, verifies cwd, and skips same-title rename', async () => {
  const f = await fixture(); const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  expect(await provider.listSessions()).toEqual([{ id: 'ses_test', title: 'Native title', cwd: process.cwd(), createdAt: new Date(1000).toISOString(), updatedAt: new Date(2000).toISOString() }]);
  await provider.renameSession('ses_test', 'Native title');
  expect(f.requests.filter(r => r.method === 'PATCH')).toHaveLength(0);
  await provider.renameSession('ses_test', 'Changed'); expect((await provider.getSession('ses_test'))?.title).toBe('Changed');
  await expect(provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_test', opaque: JSON.stringify({ cwd: '/wrong' }) })).rejects.toThrow();
}, 10000);

test('streams keyed text deltas without fetching full history per token', async () => {
  const f = await fixture(); f.messages = [assistant('Start')];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => timeline(items).length === 1);
  const reads = () => f.requests.filter(r => r.path === '/session/ses_test/message').length;
  const before = reads();
  for (let i = 0; i < 20; i++) f.emit('message.part.delta', { sessionID: 'ses_test', messageID: 'msg_assistant', partID: 'prt_text', field: 'text', delta: '.' });
  await waitFor(() => timeline(items)[0]?.text === 'Start' + '.'.repeat(20));
  expect(reads()).toBe(before);
  expect(items.filter(i => i.type === 'timeline_replacement')).toHaveLength(0);
}, 10000);

test('hydrates pending interactions and maps local answers and remote permission decisions', async () => {
  const f = await fixture();
  f.questions = [{ id: 'question_1', sessionID: 'ses_test', questions: [{ header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }], custom: true }] }];
  f.permissions = [{ id: 'permission_1', sessionID: 'ses_test', permission: 'bash', patterns: ['pwd'], metadata: {}, always: [], tool: { callID: 'call_1', messageID: 'msg_assistant' } }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => items.filter(i => i.type === 'observation' && i.event.type === 'interaction_requested').length === 2);
  expect((await session.runtimeInfo()).status).toBe('waiting');
  await expect(session.respondToInteraction('question_1', { kind: 'question', answers: [{ questionId: '0', selectedValues: ['Invalid'] }] })).rejects.toThrow();
  await session.respondToInteraction('question_1', { kind: 'question', answers: [{ questionId: '0', selectedValues: [], customText: 'Custom' }] });
  expect(f.requests.find(r => r.path === '/question/question_1/reply')?.body).toEqual({ answers: [['Custom']] });
  f.emit('permission.replied', { sessionID: 'ses_test', requestID: 'permission_1', reply: 'once' });
  await waitFor(() => items.some(i => i.type === 'observation' && i.event.type === 'interaction_resolved' && i.event.requestId === 'permission_1'));
}, 10000);

test('recovers requests resolved elsewhere as invalidated instead of inventing an answer', async () => {
  const f = await fixture();
  f.questions = [{ id: 'question_1', sessionID: 'ses_test', questions: [{ header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }] }] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  f.disconnect(); f.questions = [];
  await waitFor(() => items.some(i => i.type === 'observation' && i.event.type === 'interaction_invalidated' && i.event.requestId === 'question_1'));
  await expect(session.respondToInteraction('question_1', { kind: 'question', answers: [], dismissed: true })).rejects.toThrow('no longer pending');
}, 10000);

test('maps reasoning, completed tool output, todos and usage and preserves todos through corrections', async () => {
  const f = await fixture(); const message = assistant('Answer');
  message.parts.unshift({ type: 'reasoning', id: 'prt_reason', messageID: 'msg_assistant', sessionID: 'ses_test', text: 'Thinking' } as any);
  message.parts.push({ type: 'tool', id: 'prt_tool', messageID: 'msg_assistant', sessionID: 'ses_test', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'pwd' }, output: '/work', title: 'pwd', metadata: {}, time: { start: 1, end: 3 } } } as any);
  f.messages = [message];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => timeline(items).length === 3);
  expect(timeline(items)[0]).toMatchObject({ type: 'reasoning', text: 'Thinking' });
  expect(timeline(items)[2]).toMatchObject({ type: 'tool_call', status: 'completed', result: { content: [{ type: 'text', text: '/work' }] } });
  f.emit('todo.updated', { sessionID: 'ses_test', todos: [{ content: 'Work', status: 'in_progress', priority: 'high' }] });
  await waitFor(() => timeline(items).some(i => i.type === 'todo'));
  const corrected = { ...message.parts[1], text: 'Corrected' }; f.emit('message.part.updated', { part: corrected });
  await waitFor(() => timeline(items).some(i => i.type === 'assistant_message' && i.text === 'Corrected'));
  expect(timeline(items).some(i => i.type === 'todo')).toBe(true);
  expect(items.some(i => i.type === 'observation' && i.event.type === 'usage_updated' && i.event.usage.outputTokens === 3)).toBe(true);
}, 10000);

test('cancels only explicitly and distinguishes canceled turns from failed turns', async () => {
  const f = await fixture(); f.messages = [assistant('Partial')]; f.status = { type: 'busy' };
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await session.cancel();
  expect(f.requests.filter(r => r.path.endsWith('/abort'))).toHaveLength(1);
  const failed = assistant('Partial'); (failed.info as any).error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };
  f.messages = [failed]; f.status = { type: 'idle' };
  f.emit('session.error', { sessionID: 'ses_test', error: (failed.info as any).error });
  f.emit('message.updated', { info: failed.info }); f.emit('session.idle', { sessionID: 'ses_test' });
  await waitFor(() => items.some(i => i.type === 'observation' && i.event.type === 'turn_canceled'));
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(items.filter(i => i.type === 'observation' && i.event.type === 'turn_canceled')).toHaveLength(1);
  expect(items.some(i => i.type === 'observation' && (i.event.type === 'turn_failed' || i.event.type === 'turn_completed'))).toBe(false);
}, 10000);

test('uses native catalog selections and commands and keeps credentials out of persistence', async () => {
  const f = await fixture(); const provider = new OpenCodeAgentProvider({ serverUrl: f.url, username: 'local-user', password: 'secret-password' }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  await session.setSessionSetting!('model', 'test/model'); await session.setPlanning!(true);
  expect((await session.listCommands!())[0]).toMatchObject({ id: 'check', name: 'check' });
  await session.executeCommand!('check', 'scope');
  expect(f.requests.find(r => r.path.endsWith('/command') && r.method === 'POST')?.body).toMatchObject({ command: 'check', arguments: 'scope' });
  await session.sendMessage('Plan');
  expect(f.requests.find(r => r.path.endsWith('/prompt_async'))?.body).toMatchObject({ model: { providerID: 'test', modelID: 'model' }, agent: 'plan' });
  const persisted = (await session.runtimeInfo()).persistence!;
  expect(JSON.parse(persisted.opaque)).toEqual({ cwd: process.cwd(), model: 'test/model', agent: 'plan' });
  expect(JSON.stringify(await session.runtimeInfo())).not.toContain('secret-password');
  expect(() => new OpenCodeAgentProvider({ serverUrl: f.url, restrictedNative: true })).toThrow('permissions');
}, 10000);

test('reconciles deltas buffered during ordinary snapshots without replaying already captured text', async () => {
  const f = await fixture(); f.messages = [assistant('A')];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => timeline(items)[0]?.text === 'A');
  const barrier = f.blockNextHistory(); f.messages = [assistant('AB')];
  f.emit('session.idle', { sessionID: 'ses_test' });
  await barrier.arrived;
  f.emit('message.part.delta', { sessionID: 'ses_test', messageID: 'msg_assistant', partID: 'prt_text', field: 'text', delta: 'B' });
  await new Promise(resolve => setTimeout(resolve, 20)); barrier.release();
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(timeline(items)[0]?.text).toBe('AB');
}, 10000);

test('retries failed recovery snapshots without poisoning future live event processing', async () => {
  const f = await fixture(); f.messages = [assistant('Before')];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  f.failHistoryReads = 1; f.disconnect(); f.messages = [assistant('After')];
  await waitFor(() => timeline(items)[0]?.text === 'After');
  f.emit('message.part.delta', { sessionID: 'ses_test', messageID: 'msg_assistant', partID: 'prt_text', field: 'text', delta: '!' });
  await waitFor(() => timeline(items)[0]?.text === 'After!');
  expect((await session.runtimeInfo()).connection?.state).toBe('connected');
  expect(items.some(i => i.type === 'observation' && i.event.type === 'turn_failed')).toBe(false);
}, 10000);

test('sends validated inline images and reads only their bounded native resource bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-images-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cVQAAAAASUVORK5CYII=', 'base64');
  const path = join(directory, 'pixel.png'); await writeFile(path, bytes);
  const f = await fixture(); const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await expect(session.sendMessageContent!([{ type: 'image', path, mediaType: 'image/png', sha256: 'bad', label: 'Bad' }])).rejects.toThrow('validation');
  await session.sendMessageContent!([{ type: 'image', path, mediaType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), label: 'Pixel' }]);
  expect(f.requests.find(r => r.path.endsWith('/prompt_async'))?.body.parts[0]).toEqual({ type: 'file', mime: 'image/png', filename: 'Pixel', url: `data:image/png;base64,${bytes.toString('base64')}` });
  await waitFor(() => timeline(items).some(i => i.type === 'user_message' && i.content?.[0]?.type === 'image'));
  const locator = timeline(items).find(i => i.type === 'user_message').content[0].locator;
  expect(await session.readResource!(locator)).toEqual({ status: 'available', bytes: Uint8Array.from(bytes), mediaType: 'image/png' });
  expect((await session.readResource!(`file://${path}`)).status).toBe('unavailable');
}, 10000);

test('normalizes native user compaction markers without fabricating empty user messages', async () => {
  const f = await fixture();
  f.messages = [{ info: { id: 'msg_compaction', sessionID: 'ses_test', role: 'user', time: { created: 3000 } }, parts: [{ type: 'compaction', id: 'prt_compact', messageID: 'msg_compaction', sessionID: 'ses_test', auto: true }] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => items.some(i => i.type === 'history_boundary'));
  expect(timeline(items)).toEqual([{ type: 'compaction', status: 'loading', trigger: 'auto' }]);
}, 10000);

test('preserves exactly one answered interaction in Relay before and after a timeline correction', async () => {
  const { AgentManager } = await import('../../agent-remote-relay/src/agent-manager.js');
  const f = await fixture(); f.messages = [assistant('Before')];
  f.questions = [{ id: 'question_1', sessionID: 'ses_test', questions: [{ header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }] }] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() });
  const manager = await AgentManager.attach({ agentId: 'test', provider: provider.descriptor, session, epoch: 'first' }); cleanups.push(() => manager.close()); await manager.ready;
  const rows = () => manager.fetchTimeline({ requestId: 'test', agentId: 'test', epoch: manager.timelineCursor().epoch, direction: 'tail', limit: 20 }).payload.entries.map(entry => entry.item);
  await session.respondToInteraction('question_1', { kind: 'question', answers: [{ questionId: '0', selectedValues: ['One'] }] });
  await waitFor(() => manager.snapshot().payload.pendingInteractions.length === 0);
  expect(rows().filter(item => item.type === 'interaction')).toHaveLength(1);
  f.emit('message.part.updated', { part: assistant('Corrected').parts[0] });
  await waitFor(() => rows().some(item => item.type === 'assistant_message' && item.text === 'Corrected'));
  expect(rows().filter(item => item.type === 'interaction')).toHaveLength(1);
}, 10000);

test('restores native model and agent from the latest user message when the handle only carries cwd', async () => {
  const f = await fixture();
  f.messages = [{ info: { id: 'msg_user', sessionID: 'ses_test', role: 'user', time: { created: 1000 }, model: { providerID: 'test', modelID: 'model' }, agent: 'plan' }, parts: [{ type: 'text', id: 'prt_user', messageID: 'msg_user', sessionID: 'ses_test', text: 'Plan' }] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_test', opaque: JSON.stringify({ cwd: process.cwd() }) }); observe(session);
  expect(await session.runtimeInfo()).toMatchObject({ model: 'test/model', mode: 'plan', planning: { active: true } });
  await session.sendMessage('Continue');
  expect(f.requests.find(r => r.path.endsWith('/prompt_async'))?.body).toMatchObject({ model: { providerID: 'test', modelID: 'model' }, agent: 'plan' });
}, 10000);

test('multiplexes one global SSE connection and keeps another observer live after detach', async () => {
  const f = await fixture(); f.messages = [assistant('Shared')];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const first = await provider.createSession({ sessionId: 'one', cwd: process.cwd() }); const one = observe(first);
  const second = await provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_test', opaque: JSON.stringify({ cwd: process.cwd() }) }); const two = observe(second);
  await waitFor(() => timeline(one)[0]?.text === 'Shared' && timeline(two)[0]?.text === 'Shared');
  expect(f.connections).toBe(1); expect(f.activeConnections).toBe(1);
  await first.dispose();
  f.emit('message.part.delta', { sessionID: 'ses_test', messageID: 'msg_assistant', partID: 'prt_text', field: 'text', delta: '!' });
  await waitFor(() => timeline(two)[0]?.text === 'Shared!');
  expect(timeline(one)[0]?.text).toBe('Shared');
  expect(f.requests.filter(r => r.path.endsWith('/abort'))).toHaveLength(0);
}, 10000);

test('tracks persisted native selections without letting older prompt metadata overwrite them', async () => {
  const f = await fixture(); const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd(), model: 'test/model', planning: true }); const items = observe(session);
  await session.sendMessage('First'); await waitFor(() => timeline(items).some(item => item.type === 'user_message'));
  const external = { id: 'msg_external', role: 'user', sessionID: 'ses_test', model: { providerID: 'test', modelID: 'model' }, agent: 'build', time: { created: Date.now() + 10 } };
  f.nativeSelection = { model: { providerID: 'test', id: 'model' }, agent: 'build' };
  f.emit('session.next.agent.switched', { sessionID: 'ses_test', agent: 'build', timestamp: new Date().toISOString(), messageID: 'switch_1' });
  f.messages.push({ info: external, parts: [] }); f.emit('message.updated', { info: external });
  await expect.poll(async () => (await session.runtimeInfo()).mode, { timeout: 4000 }).toBe('build');
  await session.setSessionSetting!('agent', 'plan');
  const later = { ...external, id: 'msg_later', time: { created: Date.now() + 20 } };
  f.messages.push({ info: later, parts: [] }); f.emit('message.updated', { info: later });
  await new Promise(resolve => setTimeout(resolve, 150));
  expect((await session.runtimeInfo()).mode).toBe('plan');
}, 10000);

test('bounds initial history and loads an older native page without changing live runtime', async () => {
  const f = await fixture();
  f.messages = Array.from({ length: 205 }, (_, index) => ({ info: { id: `msg_${String(index).padStart(4, '0')}`, role: 'user', sessionID: 'ses_test', time: { created: index + 1 } }, parts: [{ type: 'text', id: `prt_${index}`, messageID: `msg_${String(index).padStart(4, '0')}`, sessionID: 'ses_test', text: `Message ${index}` }] }));
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => items.some(i => i.type === 'history_boundary'));
  expect(timeline(items)).toHaveLength(200);
  const cursor = Buffer.from(JSON.stringify({ id: 'msg_0005', time: 6 })).toString('base64url');
  const boundary = items.find(i => i.type === 'history_boundary'); expect(boundary).toMatchObject({ olderCursor: cursor });
  const before = await session.runtimeInfo();
  const page = await session.readTimelineHistory!(cursor);
  expect(page.observations).toHaveLength(5); expect(page.nextCursor).toBeUndefined();
  expect(await session.runtimeInfo()).toEqual(before);
}, 10000);

test('marks compaction completed from its native summary message', async () => {
  const f = await fixture();
  const summary = assistant('Compacted context'); summary.info.parentID = 'msg_compaction'; (summary.info as any).summary = true; (summary.info.time as any).completed = 4000;
  f.messages = [{ info: { id: 'msg_compaction', sessionID: 'ses_test', role: 'user', time: { created: 2000 } }, parts: [{ type: 'compaction', id: 'prt_compact', messageID: 'msg_compaction', sessionID: 'ses_test', auto: false }] }, summary];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => items.some(i => i.type === 'history_boundary'));
  expect(timeline(items)[0]).toEqual({ type: 'compaction', status: 'completed', trigger: 'manual' });
}, 10000);

test('sanitizes timed out request errors without retrying sends', async () => {
  const f = await fixture(); const provider = new OpenCodeAgentProvider({ serverUrl: f.url, password: 'keep-local', requestTimeoutMs: 150 }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  const barrier = f.blockNextHistory();
  const history = provider.readSessionHistory('ses_test', {});
  await barrier.arrived;
  await expect(history).rejects.toThrow('OpenCode request did not complete');
  barrier.release();
  expect(f.requests.filter(r => r.path.endsWith('/prompt_async'))).toHaveLength(0);
}, 10000);

test('keeps native history readable when its previous model is no longer connected', async () => {
  const f = await fixture(); f.connectedProviders = [];
  f.messages = [{ info: { id: 'msg_user', sessionID: 'ses_test', role: 'user', time: { created: 1000 }, model: { providerID: 'old', modelID: 'removed' }, agent: 'plan' }, parts: [{ type: 'text', id: 'prt_user', messageID: 'msg_user', sessionID: 'ses_test', text: 'Earlier work' }] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.resumeSession({ providerId: 'opencode', sessionId: 'ses_test', opaque: JSON.stringify({ cwd: process.cwd() }) }); const items = observe(session);
  await waitFor(() => timeline(items).some(item => item.type === 'user_message' && item.text === 'Earlier work'));
  expect((await session.runtimeInfo()).model).toBe('old/removed');
}, 10000);

test('reports latest native token usage without claiming a total cost for a truncated history window', async () => {
  const f = await fixture();
  f.messages = Array.from({ length: 201 }, (_, index) => { const message = assistant(`Answer ${index}`); message.info.id = `msg_${String(index).padStart(4, '0')}`; message.info.time.created = index + 1; return message; });
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => items.some(i => i.type === 'history_boundary'));
  const usage = items.flatMap(i => i.type === 'observation' && i.event.type === 'usage_updated' ? [i.event.usage] : []).at(-1);
  expect(usage).toMatchObject({ inputTokens: 2, cachedInputTokens: 1, outputTokens: 3 });
  expect(usage).not.toHaveProperty('totalCostUsd');
}, 10000);

test('does not resurrect a canceled native turn while reconciling its retained error message', async () => {
  const f = await fixture();
  const user = { info: { id: 'msg_user', role: 'user', sessionID: 'ses_test', time: { created: 1000 } }, parts: [{ type: 'text', id: 'prt_user', messageID: 'msg_user', sessionID: 'ses_test', text: 'Work' }] };
  const canceled = assistant('Partial'); (canceled.info as any).error = { name: 'MessageAbortedError', data: { message: 'Aborted' } }; (canceled.info.time as any).completed = 4000;
  f.messages = [user, canceled];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await waitFor(() => items.some(i => i.type === 'history_boundary'));
  f.disconnect();
  await waitFor(() => f.connections === 2);
  await new Promise(resolve => setTimeout(resolve, 100));
  const runtime = items.flatMap(i => i.type === 'observation' && i.event.type === 'runtime_updated' ? [i.event] : []).at(-1);
  expect(runtime?.activeTurnId).toBeNull();
  expect(runtime?.runtimeInfo.status).toBe('idle');
}, 10000);

test('lists every native page across projects instead of the server current project only', async () => {
  const f = await fixture();
  f.globalSessions = Array.from({ length: 250 }, (_, index) => ({ id: `ses_${index}`, title: `Session ${index}`, directory: index < 200 ? '/project-one' : '/project-two', time: { created: 1000, updated: 5000 - index } }));
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const sessions = await provider.listSessions();
  expect(sessions).toHaveLength(250);
  expect(sessions.at(-1)).toMatchObject({ id: 'ses_249', cwd: '/project-two' });
  expect(f.requests.filter(request => request.path === '/experimental/session')).toHaveLength(2);
  expect(f.requests.filter(request => request.path === '/session')).toHaveLength(0);
}, 10000);

test('reports an unavailable global listing endpoint without falling back to an incomplete project listing', async () => {
  const f = await fixture(); f.globalListingStatus = 404;
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  await expect(provider.listSessions()).rejects.toThrow('HTTP 404');
  expect(f.requests.filter(request => request.path === '/session')).toHaveLength(0);
}, 10000);

test.each(['todo', 'receipt'])('keeps one Relay epoch when streaming after %s', async kind => {
  const { AgentManager } = await import('../../agent-remote-relay/src/agent-manager.js');
  const f = await fixture(); f.messages = [assistant('A')];
  if (kind === 'receipt') f.questions = [{ id: 'question_1', sessionID: 'ses_test', questions: [{ header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }] }] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() });
  const manager = await AgentManager.attach({ agentId: 'test', provider: provider.descriptor, session, epoch: 'initial' });
  cleanups.push(() => manager.close()); await manager.ready;
  const rows = () => manager.fetchTimeline({ requestId: 'test', agentId: 'test', epoch: manager.timelineCursor().epoch, direction: 'tail', limit: 20 }).payload.entries.map(entry => entry.item);
  if (kind === 'todo') {
    f.emit('todo.updated', { sessionID: 'ses_test', todos: [{ content: 'Work', status: 'in_progress', priority: 'high' }] });
    await waitFor(() => rows().some(item => item.type === 'todo'));
  } else {
    await session.respondToInteraction('question_1', { kind: 'question', answers: [{ questionId: '0', selectedValues: ['One'] }] });
    await waitFor(() => rows().some(item => item.type === 'interaction'));
  }
  const epoch = manager.timelineCursor().epoch;
  for (let i = 1; i <= 3; i++) {
    f.emit('message.part.delta', { sessionID: 'ses_test', messageID: 'msg_assistant', partID: 'prt_text', field: 'text', delta: 'B' });
    await waitFor(() => rows().filter(item => item.type === 'assistant_message').map(item => item.text).join('') === 'A' + 'B'.repeat(i));
    expect(manager.timelineCursor().epoch).toBe(epoch);
  }
}, 10000);

test('projects native child states and refreshes them after child interaction events', async () => {
  const f = await fixture();
  const child = { id: 'child_1', title: 'Child task', parentID: 'ses_test', directory: process.cwd(), time: { created: 1000, updated: 2000 } };
  f.children = [child];
  const parent = assistant('Delegating');
  parent.parts.push({ type: 'tool', id: 'task_part', messageID: 'msg_assistant', sessionID: 'ses_test', callID: 'task_call', tool: 'task', state: { status: 'running', input: { subagent_type: 'explore', description: 'Explore fixture' }, metadata: { parentSessionId: 'ses_test', sessionId: 'child_1' }, time: { start: 1 } } } as any);
  f.messages = [parent];
  f.questions = [{ id: 'child_question', sessionID: 'child_1', questions: [] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  expect((await session.runtimeInfo()).childSessions).toEqual([{ nativeSessionId: 'child_1', title: 'Child task', createdAt: new Date(1000).toISOString(), status: 'waiting', observation: 'live', parentTurnId: 'msg_user', parentCallId: 'task_call', role: 'explore', description: 'Explore fixture' }]);
  f.questions = []; f.emit('question.replied', { sessionID: 'child_1', requestID: 'child_question', answers: [] });
  await expect.poll(async () => (await session.runtimeInfo()).childSessions?.[0]?.status, { timeout: 4000 }).toBe('idle');
  f.children = []; f.emit('session.deleted', { info: child });
  await expect.poll(async () => (await session.runtimeInfo()).childSessions?.length, { timeout: 4000 }).toBe(0);
}, 10000);

test('admits native immediate input during work without aborting or advertising a next-turn queue', async () => {
  const f = await fixture(); f.status = { type: 'busy' }; f.messages = [assistant('Working')];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  await session.sendMessage('Follow up');
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(1);
  expect(f.requests.some(request => request.path.endsWith('/abort'))).toBe(false);
  expect(session.capabilities.steer).toBe(true);
  expect(session.capabilities.queueMessage).not.toBe(true);
  await expect(session.sendMessage('Queued', { delivery: 'next_turn' })).rejects.toThrow('queued');
}, 10000);

test('reserves native input admission through the acknowledgement-to-busy notification gap', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  await session.sendMessage('First');
  await expect(session.sendMessage('Second')).rejects.toThrow('Wait for');
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(1);
  f.status = { type: 'busy' }; f.emit('session.status', { sessionID: 'ses_test', status: f.status });
  await expect.poll(async () => (await session.runtimeInfo()).status, { timeout: 4000 }).toBe('running');
  f.status = { type: 'idle' }; f.emit('session.status', { sessionID: 'ses_test', status: f.status });
  await expect.poll(async () => (await session.runtimeInfo()).status, { timeout: 4000 }).toBe('idle');
  await session.sendMessage('After confirmed work');
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(2);
}, 10000);

test('releases input admission after definite rejection but retains unknown outcomes until cancellation', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  f.promptStatus = 400;
  await expect(session.sendMessage('Rejected')).rejects.toThrow('HTTP 400');
  f.promptStatus = 204; f.rejectPrompt = true;
  await expect(session.sendMessage('Unknown')).rejects.toThrow('unknown');
  f.rejectPrompt = false;
  await expect(session.sendMessage('Must not replay')).rejects.toThrow('Wait for');
  await expect(session.executeCommand!('check', '')).rejects.toThrow('Wait for');
  await session.cancel();
  await session.sendMessage('After cancellation');
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(3);
}, 10000);

test('reconciles completed input when the busy notification was missed', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  await session.sendMessage('First');
  const parentID = f.messages.at(-1).info.id;
  f.messages.push({ ...assistant('Done'), info: { ...assistant('Done').info, parentID, finish: 'stop', time: { created: Date.now() + 1, completed: Date.now() + 2 } } });
  const barrier = f.blockNextHistory();
  f.emit('session.idle', { sessionID: 'ses_test' });
  await barrier.arrived;
  barrier.release();
  await expect.poll(async () => { try { await session.sendMessage('After native completion'); return true; } catch { return false; } }, { timeout: 4000 }).toBe(true);
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(2);
}, 10000);

test('returns answered interactions on their older native page after a corrected tail', async () => {
  const f = await fixture(); f.messages = [assistant('Old answer')];
  f.questions = [{ id: 'old_question', sessionID: 'ses_test', questions: [{ header: 'Choice', question: 'Which?', options: [{ label: 'One', description: 'First' }] }] }];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  await session.respondToInteraction('old_question', { kind: 'question', answers: [{ questionId: '0', selectedValues: ['One'] }] });
  f.questions = [];
  for (let index = 0; index < 201; index++) {
    const message = assistant(`Tail ${index}`); const id = `msg_tail_${index}`;
    f.messages.push({ info: { ...message.info, id, time: { created: 4000 + index } }, parts: [{ ...message.parts[0], id: `prt_${index}`, messageID: id }] });
  }
  f.emit('session.idle', { sessionID: 'ses_test' });
  await waitFor(() => timeline(items).some(item => item.text === 'Tail 200'));
  f.emit('message.part.updated', { part: { ...f.messages.at(-1).parts[0], text: 'Corrected tail' } });
  await waitFor(() => items.some(item => item.type === 'timeline_replacement'));
  const replacement = items.findLast(item => item.type === 'timeline_replacement');
  if (replacement?.type !== 'timeline_replacement') throw new Error('Expected corrected native tail');
  expect(replacement.observations.some(item => item.event.type === 'timeline' && item.event.item.type === 'interaction')).toBe(false);
  expect(replacement.olderCursor).toBeTruthy();
  const page = await session.readTimelineHistory!(replacement.olderCursor!);
  expect(page.observations.map(item => item.event.type === 'timeline' ? item.event.item.type : item.event.type)).toEqual(['assistant_message', 'interaction', 'assistant_message']);
}, 10000);

test('reserves command admission during catalog discovery and releases rejected commands', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  const command = session.executeCommand!('check', '');
  await expect(session.sendMessage('Concurrent input')).rejects.toThrow('Wait for');
  await command;
  await expect(session.executeCommand!('unknown', '')).rejects.toThrow('Unknown OpenCode command');
  await session.sendMessage('After command');
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(1);
}, 10000);

test('steer requires active native work and does not replay an uncertain admission', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  await expect(session.steer!('Idle')).rejects.toThrow('active');
  f.status = { type: 'busy' }; f.emit('session.status', { sessionID: 'ses_test', status: f.status });
  await expect.poll(async () => (await session.runtimeInfo()).status).toBe('running');
  f.rejectPrompt = true;
  await expect(session.steer!('Unknown')).rejects.toThrow('unknown');
  f.rejectPrompt = false;
  await expect(session.steer!('Do not resend')).rejects.toThrow('Wait for');
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(1);
  const prompt = f.requests.find(request => request.path.endsWith('/prompt_async'))!.body;
  const info = { id: prompt.messageID, role: 'user', sessionID: 'ses_test', time: { created: Date.now() } };
  f.messages.push({ info, parts: [] }); f.emit('message.updated', { info });
  await expect.poll(async () => { try { await session.steer!('After confirmed native admission'); return true; } catch { return false; } }, { timeout: 4000 }).toBe(true);
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(2);
}, 10000);


test('retains uncertain idle-origin input across unrelated busy and error events', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  f.rejectPrompt = true;
  await expect(session.sendMessage('Unknown')).rejects.toThrow('unknown');
  f.rejectPrompt = false;
  f.status = { type: 'busy' }; f.emit('session.status', { sessionID: 'ses_test', status: f.status });
  await expect.poll(async () => (await session.runtimeInfo()).status).toBe('running');
  await expect(session.sendMessage('Do not duplicate')).rejects.toThrow('Wait for');
  f.emit('session.error', { sessionID: 'ses_test', error: { name: 'UnknownError', data: { message: 'Uncorrelated' } } });
  await expect.poll(async () => (await session.runtimeInfo()).status).toBe('failed');
  await expect(session.sendMessage('Still unknown')).rejects.toThrow('Wait for');
  expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(1);
}, 10000);

test('does not identify or release an input still being prepared from unrelated busy', async () => {
  const f = await fixture(); f.messages = [assistant('Existing work')];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); const items = observe(session);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const original = OpenCodeImages.prototype.input;
  const spy = vi.spyOn(OpenCodeImages.prototype, 'input').mockImplementationOnce(async function(parts) { await gate; return original.call(this, parts); });
  try {
    const sending = session.sendMessage('After preparation');
    void sending.catch(() => {});
    f.status = { type: 'busy' }; f.emit('session.status', { sessionID: 'ses_test', status: f.status });
    await expect.poll(async () => (await session.runtimeInfo()).status).toBe('running');
    const started = items.findLast(item => item.type === 'observation' && item.event.type === 'turn_started');
    expect(started).toMatchObject({ event: { turnId: 'msg_user' } });
    expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(0);
    release(); await sending;
    expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(1);
  } finally { release(); spy.mockRestore(); }
}, 10000);

test('does not release a newer uncertain steer when an older cancellation acknowledges', async () => {
  const f = await fixture(); f.status = { type: 'busy' }; f.messages = [assistant('Working')];
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url }); cleanups.push(() => provider.close());
  const session = await provider.createSession({ sessionId: 'local', cwd: process.cwd() }); observe(session);
  const barrier = f.blockNextAbort(); const canceling = session.cancel(); await barrier.arrived;
  try {
    f.rejectPrompt = true;
    await expect(session.steer!('New uncertain input')).rejects.toThrow('unknown');
    f.rejectPrompt = false;
    barrier.release(); await canceling;
    await expect(session.steer!('Must not duplicate')).rejects.toThrow('Wait for');
    expect(f.requests.filter(request => request.path.endsWith('/prompt_async'))).toHaveLength(1);
  } finally { barrier.release(); await canceling; }
}, 10000);


test('availability probes only server health and rejects unsupported or unhealthy services', async () => {
  const f = await fixture();
  const provider = new OpenCodeAgentProvider({ serverUrl: f.url });
  try {
    await provider.checkAvailability();
    for (const health of [{ healthy: true, version: '1.18.17' }, { healthy: false, version: '1.18.31' }, { healthy: true, version: 'dev' }]) {
      f.health = health;
      await expect(provider.checkAvailability()).rejects.toThrow('healthy and version');
    }
    expect(f.connections).toBe(0);
    expect(f.requests.map(({ method, path }) => `${method} ${path}`)).toEqual(Array(4).fill('GET /global/health'));
  } finally { await provider.close(); }
});
