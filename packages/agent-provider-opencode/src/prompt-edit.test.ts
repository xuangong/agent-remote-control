import { createServer, type ServerResponse } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import type { SessionInfo, SessionMessageInfo } from '@opencode/client';
import { OpenCodeAgentProvider } from './provider.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error The native plugin is bundled separately.
import plugin from './bridge-plugin.mjs';
import { png } from './test-utils/v2-fixtures.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(callbacks = false) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-edit-callback-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const callbackConfigPath = join(directory, 'callback.json');
  const nativeTools: Record<string, any> = {};
  let pluginStarted = false;
  let serverUrl = '';
  const cwd = process.cwd();
  const session = (id: string, parentID?: string): SessionInfo => ({ id, location: { directory: cwd }, title: id, projectID: 'project',
    agent: id === 'source' ? 'build' : 'plan', model: { providerID: 'test', id: 'model' }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, ...(parentID ? { parentID } : {}), time: { created: 1, updated: 2 } });
  const user = (id: string, text: string, time: number): SessionMessageInfo => ({ id, type: 'user', time: { created: time }, text });
  const source: SessionMessageInfo[] = [user('msg_first', 'Earlier prompt', 1), { id: 'idle_first', type: 'idle', time: { created: 2 }, outcome: 'succeeded' },
    user('msg_edit', 'Replace this', 3), { id: 'idle_edit', type: 'idle', time: { created: 4 }, outcome: 'succeeded' },
    user('msg_later', 'Later prompt', 5), { id: 'idle_later', type: 'idle', time: { created: 6 }, outcome: 'succeeded' }];
  const sessions = new Map([['source', session('source')], ['child', session('child', 'source')], ['other', session('other')]]);
  const histories = new Map<string, SessionMessageInfo[]>([['source', source], ['child', []], ['other', []]]);
  const instructions = new Map<string, Array<{ key: string; value: unknown }>>();
  const active: Record<string, { type: 'running' }> = {};
  const reads: string[] = [];
  const writes: Array<{ path: string; body: unknown }> = []; let busy = false;
  const permissions: Array<{ id: string; sessionID: string }> = [];
  const forms: Array<{ id: string; sessionID: string }> = [];
  const inbox: Array<{ id: string; sessionID: string }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET') reads.push(url.pathname);
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(response); response.on('close', () => streams.delete(response));
      response.write('data: {"type":"server.connected","data":{}}\n\n'); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.method !== 'GET') writes.push({ path: `${request.method} ${url.pathname}`, body });
    if (url.pathname === '/api/session/active') return json({ data: { ...active, ...(busy ? { source: { type: 'running' } } : {}) } });
    if (url.pathname === '/api/plugin') {
      if (callbacks && !pluginStarted) {
        pluginStarted = true;
        const dispose = await plugin.setup({ options: { configPath: callbackConfigPath, serverUrl }, location: { directory: cwd },
          tool: { async transform(register: (editor: any) => void) { register({ add(value: any) { nativeTools[value.name] = value; } }); return { async dispose() {} }; } } });
        cleanups.push(dispose);
      }
      return json({ location: { directory: cwd }, data: [] });
    }
    if (url.pathname === '/api/form') return json({ location: { directory: cwd }, data: forms });
    if (url.pathname === '/api/permission/request') return json({ location: { directory: cwd }, data: permissions });
    if (url.pathname === '/api/model') return json({ location: { directory: cwd }, data: [{ providerID: 'test', id: 'model', modelID: 'model', name: 'Model', enabled: true, status: 'active', capabilities: {}, variants: [], limit: { context: 1000, output: 100 } }] });
    if (url.pathname === '/api/agent') return json({ location: { directory: cwd }, data: ['build', 'plan'].map(name => ({ id: name, name, mode: 'primary', hidden: false, permissions: [], request: {} })) });
    if (url.pathname === '/api/session') return json({ data: [...sessions.values()].filter(value => !url.searchParams.has('parentID') || value.parentID === url.searchParams.get('parentID')), cursor: {} });
    const match = /^\/api\/(?:experimental\/)?session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json({ message: `Unexpected ${url.pathname}` }, 404);
    const id = match[1]!; const operation = match[2];
    if (!sessions.has(id)) return json({ message: 'Session missing' }, 404);
    if (!operation) return json({ data: sessions.get(id) });
    if (operation === 'instructions/entries') return json({ data: instructions.get(id) ?? [] });
    if (operation?.startsWith('instructions/entries/')) {
      const key = decodeURIComponent(operation.split('/').at(-1)!);
      instructions.set(id, [...(instructions.get(id) ?? []).filter(entry => entry.key !== key), { key, value: body.value }]); response.writeHead(204).end(); return;
    }
    if (operation === 'permission') return json({ data: permissions.filter(value => value.sessionID === id) });
    if (operation === 'form') return json({ data: forms.filter(value => value.sessionID === id) });
    if (operation === 'inbox') return json({ data: inbox.filter(value => value.sessionID === id) });
    if (operation === 'message') {
      if (url.searchParams.has('cursor') && url.searchParams.has('order')) return json({ message: 'Cursor defines its own order' }, 400);
      const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit'));
      const data = [...histories.get(id)!].reverse().slice(offset, offset + limit);
      return json({ data, cursor: data.length ? { previous: String(offset), next: String(offset + data.length) } : {} });
    }
    if (operation === 'fork' && request.method === 'POST') {
      const index = histories.get(id)!.findIndex(value => value.id === body.before);
      if (index < 0) return json({ message: 'Invalid fork boundary' }, 400);
      const fork = session('fork'); sessions.set('fork', fork);
      histories.set('fork', structuredClone(histories.get(id)!.slice(0, index)));
      return json({ data: fork });
    }
    return json({ message: `Unexpected ${operation}` }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  serverUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider = new OpenCodeAgentProvider({ serverUrl, requestTimeoutMs: 1000, ...(callbacks ? { callbackConfigPath } : {}) });
  cleanups.push(() => provider.close());
  return { provider, source, histories, writes, reads, sessions, instructions, nativeTools, active, permissions, forms, inbox,
    event(type: string, data: unknown) { for (const stream of streams) stream.write(`data: ${JSON.stringify({ id: Math.random().toString(), type, created: Date.now(), data })}\n\n`); },
    disconnect() { for (const stream of streams) stream.destroy(); }, set busy(value: boolean) { busy = value; } };
}

const target = { nativeSessionId: 'source', turnId: 'msg_edit', messageId: 'msg_edit' };
test('forks before the selected prompt, preserving the source and native branch selections without reverting files', async () => {
  const f = await fixture(); const original = structuredClone(f.source);
  const branch = await f.provider.forkForPromptEdit(target);
  expect(await branch.runtimeInfo()).toMatchObject({ sessionId: 'fork', cwd: process.cwd(), mode: 'plan', model: 'test/model' });
  expect(f.histories.get('fork')!.map(value => value.id)).toEqual(['msg_first', 'idle_first']);
  expect(f.source).toEqual(original);
  expect(f.writes).toEqual([{ path: 'POST /api/session/source/fork', body: { before: 'msg_edit' } }]);
}, 10000);

test('editing the first prompt creates an empty independent native branch', async () => {
  const f = await fixture();
  const branch = await f.provider.forkForPromptEdit({ nativeSessionId: 'source', turnId: 'msg_first', messageId: 'msg_first' });
  expect((await branch.runtimeInfo()).sessionId).toBe('fork');
  expect(f.histories.get('fork')).toEqual([]); expect(f.source).toHaveLength(6);
}, 10000);

test('rejects invalid prompt identities and active source sessions before any native writes', async () => {
  const f = await fixture();
  await expect(f.provider.forkForPromptEdit({ ...target, turnId: 'wrong' })).rejects.toThrow(/identity/i);
  await expect(f.provider.forkForPromptEdit({ ...target, turnId: 'missing', messageId: 'missing' })).rejects.toThrow(/editable/i);
  f.busy = true;
  await expect(f.provider.forkForPromptEdit(target)).rejects.toThrow(/finish|busy|idle/i);
  expect(f.writes).toEqual([]);
}, 10000);

test('opens only verified direct children in the same canonical workspace', async () => {
  const f = await fixture(); const child = await f.provider.openChildSession('source', 'child');
  expect((await child.runtimeInfo()).sessionId).toBe('child');
  await expect(f.provider.openChildSession('source', 'other')).rejects.toThrow(/child/i);
  f.sessions.get('child')!.location.directory = '/';
  await expect(f.provider.openChildSession('source', 'child')).rejects.toThrow(/workspace|directory/i);
  expect(f.writes).toEqual([]);
}, 10000);

test('rejects prompt edits while permissions, forms or queued input remain pending, even when execution is idle', async () => {
  const f = await fixture();
  for (const pending of [f.permissions, f.forms, f.inbox]) {
    pending.push({ id: 'pending', sessionID: 'source' });
    await expect(f.provider.forkForPromptEdit(target)).rejects.toThrow(/pending|interaction|queued/i);
    pending.length = 0;
  }
  expect(f.writes).toEqual([]);
  f.forms.push({ id: 'other_form', sessionID: 'other' });
  await f.provider.forkForPromptEdit(target);
  expect(f.writes).toEqual([{ path: 'POST /api/session/source/fork', body: { before: 'msg_edit' } }]);
}, 10000);

test('rejects a mid-turn steer even when its first prompt is on an older native page', async () => {
  const f = await fixture();
  f.histories.set('source', [
    { type: 'user', id: 'first', text: 'Start the turn', time: { created: 1 } },
    ...Array.from({ length: 202 }, (_, index): SessionMessageInfo => ({ type: 'system', id: `internal-${index}`, text: 'Internal', time: { created: index + 2 } })),
    { type: 'user', id: 'steer', text: 'Continue in the same turn', time: { created: 204 } },
    { type: 'idle', id: 'idle', time: { created: 205 }, outcome: 'succeeded' },
  ]);
  await expect(f.provider.forkForPromptEdit({ nativeSessionId: 'source', turnId: 'steer', messageId: 'steer' })).rejects.toThrow(/first|steer|editable/i);
  expect(f.writes).toEqual([]);
  await f.provider.validatePromptEdit({ nativeSessionId: 'source', turnId: 'first', messageId: 'first' });
  expect(f.writes).toEqual([]);
}, 10000);

test('uses native history order rather than timestamps to identify a turn boundary', async () => {
  const f = await fixture();
  f.histories.set('source', [
    { type: 'user', id: 'first', text: 'First turn', time: { created: 10 } },
    { type: 'idle', id: 'idle', time: { created: 30 }, outcome: 'succeeded' },
    { type: 'user', id: 'next', text: 'Next turn', time: { created: 20 } },
  ]);
  await expect(f.provider.validatePromptEdit({ nativeSessionId: 'source', turnId: 'next', messageId: 'next' })).resolves.toBeUndefined();
  expect(f.writes).toEqual([]);
}, 10000);

test('rejects native child, staged revert, synthetic and unsupported bound inputs without mutation', async () => {
  const f = await fixture();
  f.sessions.get('source')!.parentID = 'parent';
  await expect(f.provider.forkForPromptEdit(target)).rejects.toThrow(/child/i);
  delete f.sessions.get('source')!.parentID;
  f.sessions.get('source')!.revert = { messageID: 'msg_edit' } as SessionInfo['revert'];
  await expect(f.provider.forkForPromptEdit(target)).rejects.toThrow(/revert/i);
  delete f.sessions.get('source')!.revert;
  for (const message of [
    { type: 'synthetic', id: 'msg_edit', text: 'Injected context', time: { created: 3 } },
    { type: 'user', id: 'msg_edit', text: 'Agent binding', agents: [{ name: 'special' }], time: { created: 3 } },
    { type: 'user', id: 'msg_edit', text: 'Skill binding', skills: [{ id: 'special', name: 'special' }], time: { created: 3 } },
    { type: 'user', id: 'msg_edit', text: 'Document', files: [{ mime: 'application/pdf', data: 'ZmlsZQ==', source: { type: 'inline' } }], time: { created: 3 } },
    { type: 'user', id: 'msg_edit', text: '', time: { created: 3 } },
  ]) {
    f.source[2] = message as SessionMessageInfo;
    await expect(f.provider.forkForPromptEdit(target)).rejects.toThrow(/editable|bindings/i);
  }
  expect(f.writes).toEqual([]);
}, 10000);

test('allows an ordinary first prompt with restorable image input during read-only validation', async () => {
  const f = await fixture();
  f.source[2] = { type: 'user', id: 'msg_edit', text: '', time: { created: 3 }, files: [{ mime: 'image/png', data: png.toString('base64'), source: { type: 'inline' } }] };
  await f.provider.validatePromptEdit(target);
  expect(f.writes).toEqual([]);
}, 10000);

test.each([true, false])('applies tools and both instruction extensions on the first attachment (first=%s)', async first => {
  const f = await fixture(true), original = structuredClone(f.source);
  const branch = await f.provider.forkForPromptEdit(first ? { nativeSessionId: 'source', turnId: 'msg_first', messageId: 'msg_first' } : target, {
    systemPrompt: 'Base instructions.', instructions: 'Team role instructions.', tools: [{ name: 'read_source_session', description: 'Read source', inputSchema: { type: 'object' }, execute: async () => 'source-proof' }],
  });
  expect(await f.nativeTools.arc_host_invoke.execute({ name: 'read_source_session', arguments: {} }, { sessionID: branch.nativeId })).toEqual({ content: 'source-proof' });
  expect(f.instructions.get('fork')).toEqual(expect.arrayContaining([{ key: 'arc.host.role', value: 'Team role instructions.' }]));
  expect(f.instructions.get('fork')!.find(entry => entry.key === 'arc.host.system')!.value).toContain('Base instructions.');
  expect(f.source).toEqual(original);
  expect(f.writes.some(write => /prompt|revert|interrupt/.test(write.path))).toBe(false);
}, 10000);
test('rejects missing Host callback support before any native fork', async () => {
  const f = await fixture();
  await expect(f.provider.forkForPromptEdit(target, { tools: [{ name: 'read_source_session', description: 'Read source', inputSchema: { type: 'object' }, execute: async () => 'proof' }] })).rejects.toThrow(/callback|plugin/i);
  expect(f.writes).toEqual([]);
}, 10000);
test.each([true, false])('verifies the complete native prefix independently of source suffixes (first=%s)', async first => {
  const f = await fixture();
  const selected = first ? { nativeSessionId: 'source', turnId: 'msg_first', messageId: 'msg_first' } : target;
  const branch = await f.provider.forkForPromptEdit(selected), handle = (await branch.runtimeInfo()).persistence!;
  f.source.push({ type: 'user', id: 'appended', text: 'Append', time: { created: 7 } });
  f.busy = true;
  const before = f.writes.length;
  await f.provider.verifyPromptEditBranch(selected, handle);
  expect(f.writes).toHaveLength(before);
  expect(f.reads).toContain('/api/session/fork/message');
}, 10000);
test.each(['corrupt', 'extra', 'provider', 'source', 'workspace', 'identity'])('rejects invalid prefix content or exact handle identity without writes (%s)', async corruption => {
  const f = await fixture(), branch = await f.provider.forkForPromptEdit(target);
  const handle = (await branch.runtimeInfo()).persistence!;
  if (corruption === 'corrupt') (f.histories.get('fork')![0] as any).text = 'Changed';
  if (corruption === 'extra') f.histories.get('fork')!.push(f.source[2]!);
  if (corruption === 'provider') handle.providerId = 'codex';
  if (corruption === 'source') handle.sessionId = 'source';
  if (corruption === 'workspace') handle.opaque = JSON.stringify({ cwd: '/' });
  if (corruption === 'identity') f.sessions.get('fork')!.id = 'wrong';
  const before = f.writes.length;
  await expect(f.provider.verifyPromptEditBranch(target, handle)).rejects.toThrow();
  expect(f.writes).toHaveLength(before);
}, 10000);
test('exposes independent prompt-edit readiness while generic evidence remains unavailable', async () => {
  const f = await fixture(), branch = await f.provider.forkForPromptEdit(target);
  const evidence = branch.promptEditEvidence!;
  expect(evidence.version).toBe(1);
  expect(branch.nativeEvidence.availability()).toMatchObject({ status: 'unavailable' });
  expect(await evidence.inspectReadiness()).toEqual({ cwd: process.cwd(), idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 });
  const token = evidence.captureValidity(); expect(evidence.isCurrent(token)).toBe(true);
  f.event('session.inbox.enqueued', { sessionID: 'fork', inboxID: 'new' });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(evidence.isCurrent(token)).toBe(false);
  for (const pending of [f.inbox, f.permissions, f.forms]) {
    pending.push({ id: 'pending', sessionID: 'fork' });
    const state = await evidence.inspectReadiness();
    expect(state.pendingInputs + state.pendingInteractions).toBeGreaterThan(0);
    expect(() => evidence.captureValidity()).toThrow(); pending.length = 0;
  }
  f.sessions.get('child')!.parentID = 'fork'; f.active.child = { type: 'running' };
  expect(await evidence.inspectReadiness()).toMatchObject({ activeChildren: 1 });
  expect(() => evidence.captureValidity()).toThrow();
  delete f.active.child;
  await evidence.inspectReadiness(); const closeToken = evidence.captureValidity();
  await branch.dispose(); expect(evidence.isCurrent(closeToken)).toBe(false);
  await expect(evidence.inspectReadiness()).rejects.toThrow();
}, 10000);
test('invalidates prompt-edit tokens on disconnect before recovery readback', async () => {
  const f = await fixture(), branch = await f.provider.forkForPromptEdit(target), evidence = branch.promptEditEvidence!;
  await evidence.inspectReadiness(); const token = evidence.captureValidity(); f.disconnect();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(evidence.isCurrent(token)).toBe(false);
  await expect(evidence.inspectReadiness()).rejects.toThrow();
}, 10000);

test('rejects foreign attachment tokens and invalidates active-child changes without timeline input', async () => {
  const f = await fixture(), branch = await f.provider.forkForPromptEdit(target), evidence = branch.promptEditEvidence!;
  const source = await f.provider.resumeSession({ providerId: 'opencode', sessionId: 'source', opaque: JSON.stringify({ cwd: process.cwd() }) });
  await evidence.inspectReadiness(); const token = evidence.captureValidity();
  expect(source.promptEditEvidence!.isCurrent(token)).toBe(false);
  f.sessions.get('child')!.parentID = 'fork';
  f.event('session.created', { sessionID: 'child', parentID: 'fork' });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(evidence.isCurrent(token)).toBe(false);
}, 10000);

test.each([false, true])('verifies older native input content across complete message pages (corrupt=%s)', async corrupt => {
  const f = await fixture();
  const older: SessionMessageInfo[] = Array.from({ length: 105 }, (_, index) => [
    { id: `older-user-${index}`, type: 'user' as const, text: `Earlier ${index}`, time: { created: index * 2 } },
    { id: `older-idle-${index}`, type: 'idle' as const, outcome: 'succeeded' as const, time: { created: index * 2 + 1 } },
  ]).flat();
  f.source.unshift(...older);
  const branch = await f.provider.forkForPromptEdit(target), handle = (await branch.runtimeInfo()).persistence!;
  if (corrupt) (f.histories.get('fork')![0] as any).text = 'Corrupted oldest input';
  const before = f.writes.length;
  const verification = f.provider.verifyPromptEditBranch(target, handle);
  if (corrupt) await expect(verification).rejects.toThrow(/prefix/i); else await verification;
  expect(f.writes).toHaveLength(before);
}, 10000);
