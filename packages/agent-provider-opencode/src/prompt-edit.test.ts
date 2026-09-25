import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { OpenCodeAgentProvider } from './provider.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const cwd = process.cwd();
  const session = (id: string, parentID?: string) => ({ id, directory: cwd, title: id, ...(parentID ? { parentID } : {}), time: { created: 1, updated: 2 } });
  const user = (id: string, text: string) => ({ info: { id, role: 'user', sessionID: 'source', time: { created: 1 }, model: { providerID: 'test', modelID: 'model' }, agent: 'plan' }, parts: [{ id: `part_${id}`, messageID: id, sessionID: 'source', type: 'text', text }] });
  const source = [user('msg_first', 'Earlier prompt'), user('msg_edit', 'Replace this'), user('msg_later', 'Later prompt')];
  const sessions = new Map([['source', session('source')], ['child', session('child', 'source')], ['other', session('other')]]);
  const histories = new Map<string, any[]>([['source', source], ['child', []], ['other', []]]);
  const writes: string[] = []; let busy = false;
  const permissions: any[] = []; const questions: any[] = [];
  const streams = new Set<import('node:http').ServerResponse>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const json = (value: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/global/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); streams.add(response); response.on('close', () => streams.delete(response));
      response.write(`data: ${JSON.stringify({ directory: cwd, payload: { type: 'server.connected', properties: {} } })}\n\n`); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (request.method !== 'GET') writes.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/session/status') return json(busy ? { source: { type: 'busy' } } : {});
    if (url.pathname === '/permission') return json(permissions);
    if (url.pathname === '/question') return json(questions);
    if (url.pathname === '/provider') return json({ all: [], connected: [], default: {} });
    if (url.pathname === '/agent') return json([]);
    const match = /^\/session\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json({}, 404);
    const id = match[1]!; const operation = match[2];
    if (!sessions.has(id)) return json({}, 404);
    if (!operation) return json(sessions.get(id));
    if (operation === 'message') return json(histories.get(id));
    if (operation.startsWith('message/')) return json(histories.get(id)!.find(value => value.info.id === operation.slice(8)) ?? {}, histories.get(id)!.some(value => value.info.id === operation.slice(8)) ? 200 : 404);
    if (operation === 'todo' || operation === 'children') return json([]);
    if (operation === 'fork') {
      const index = histories.get(id)!.findIndex(value => value.info.id === body.messageID);
      const fork = session('fork'); sessions.set('fork', fork);
      histories.set('fork', structuredClone(histories.get(id)!.slice(0, index < 0 ? undefined : index)).map((value, index) => ({ info: { ...value.info, sessionID: 'fork', id: `msg_fork${index}` }, parts: value.parts.map((part: any) => ({ ...part, sessionID: 'fork', messageID: `msg_fork${index}` })) })));
      return json(fork);
    }
    return json({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { for (const stream of streams) stream.destroy(); server.closeAllConnections(); server.close(); await once(server, 'close'); });
  const provider = new OpenCodeAgentProvider({ serverUrl: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}` });
  cleanups.push(() => provider.close());
  return { provider, source, histories, writes, sessions, permissions, questions, set busy(value: boolean) { busy = value; } };
}

test('forks before the selected user prompt while preserving the source history and avoiding filesystem revert', async () => {
  const f = await fixture(); const original = structuredClone(f.source);
  const branch = await f.provider.forkForPromptEdit({ nativeSessionId: 'source', turnId: 'msg_edit', messageId: 'msg_edit' });
  expect(await branch.runtimeInfo()).toMatchObject({ sessionId: 'fork', cwd: process.cwd(), mode: 'plan' });
  expect(f.histories.get('fork')!.map(value => value.parts[0].text)).toEqual(['Earlier prompt']);
  expect(f.source).toEqual(original);
  expect(f.writes).toEqual(['POST /session/source/fork']);
}, 10000);

test('editing the first user prompt creates an empty independent native branch', async () => {
  const f = await fixture();
  const branch = await f.provider.forkForPromptEdit({ nativeSessionId: 'source', turnId: 'msg_first', messageId: 'msg_first' });
  expect((await branch.runtimeInfo()).sessionId).toBe('fork');
  expect(f.histories.get('fork')).toEqual([]);
  expect(f.source).toHaveLength(3);
}, 10000);

test('rejects invalid prompt identities and busy source sessions before creating a branch', async () => {
  const f = await fixture();
  await expect(f.provider.forkForPromptEdit({ nativeSessionId: 'source', turnId: 'wrong', messageId: 'msg_edit' })).rejects.toThrow();
  await expect(f.provider.forkForPromptEdit({ nativeSessionId: 'source', turnId: 'missing', messageId: 'missing' })).rejects.toThrow();
  f.busy = true;
  await expect(f.provider.forkForPromptEdit({ nativeSessionId: 'source', turnId: 'msg_edit', messageId: 'msg_edit' })).rejects.toThrow(/finish|busy|idle/i);
  expect(f.writes).toEqual([]);
}, 10000);

test('opens only verified direct native children in the same canonical workspace', async () => {
  const f = await fixture();
  const child = await f.provider.openChildSession('source', 'child');
  expect((await child.runtimeInfo()).sessionId).toBe('child');
  await expect(f.provider.openChildSession('source', 'other')).rejects.toThrow(/child/i);
  f.sessions.get('child')!.directory = '/';
  await expect(f.provider.openChildSession('source', 'child')).rejects.toThrow(/workspace|directory/i);
  expect(f.writes).toEqual([]);
}, 10000);

test('rejects prompt edits while source permissions or questions remain pending even if status is idle', async () => {
  const f = await fixture();
  const target = { nativeSessionId: 'source', turnId: 'msg_edit', messageId: 'msg_edit' };
  f.permissions.push({ id: 'permission_pending', sessionID: 'source' });
  await expect(f.provider.forkForPromptEdit(target)).rejects.toThrow(/pending|interaction/i);
  f.permissions.length = 0;
  f.questions.push({ id: 'question_pending', sessionID: 'source' });
  await expect(f.provider.forkForPromptEdit(target)).rejects.toThrow(/pending|interaction/i);
  expect(f.writes).toEqual([]);
  f.questions[0].sessionID = 'other';
  await f.provider.forkForPromptEdit(target);
  expect(f.writes).toEqual(['POST /session/source/fork']);
}, 10000);
