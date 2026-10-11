import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CopilotAgentProvider } from './provider.js';
import { readCopilotHistoryPage } from './reference-history.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const event = (type: string, data: object) => ({ id: randomUUID(), timestamp: new Date(0).toISOString(), parentId: null, type, data });
async function history() {
  const root = await mkdtemp(join(tmpdir(), 'copilot-reference-')); roots.push(root);
  const id = randomUUID(), directory = join(root, 'session-state', id); await mkdir(directory, { recursive: true });
  const rows = [event('session.start', { sessionId: id }), event('user.message', { content: 'Use SQLite' }),
    event('assistant.message', { messageId: randomUUID(), content: 'SQLite is suitable' }),
    event('tool.execution_start', { toolCallId: 'tool', toolName: 'bash', arguments: { command: 'echo SQLite' } }),
    event('tool.execution_complete', { toolCallId: 'tool', success: true, result: { content: 'SQLite' } })];
  const path = join(directory, 'events.jsonl');
  const save = () => writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); await save();
  const provider = new CopilotAgentProvider({ executable: '/not-started-for-source-read', env: { COPILOT_HOME: root } });
  return { root, id, path, rows, save, provider };
}

it('reads cold native source history without starting a runtime and searches only visible messages', async () => {
  const f = await history();
  expect(f.provider.readSessionHistory, 'Copilot must expose real source history before Host registration advertises it').toBeTypeOf('function');
  const search = await f.provider.readSessionHistory(f.id, { query: 'sqlite' });
  expect(search.entries.map(entry => [entry.role, entry.text, entry.turnId])).toEqual([
    ['user', 'Use SQLite', ''], ['assistant', 'SQLite is suitable', ''],
  ]);
  const recent = await f.provider.readSessionHistory(f.id, { limit: 1 });
  expect(recent.entries[0]?.role).toBe('tool'); expect(recent.nextCursor).toBeTypeOf('string');
  const next = await f.provider.readSessionHistory(f.id, { limit: 1, cursor: recent.nextCursor });
  expect(next.entries[0]?.text).toBe('SQLite is suitable');
});

it('binds cursors to source, query, page size and the observed history', async () => {
  const f = await history(), first = await f.provider.readSessionHistory(f.id, { limit: 1 });
  for (const query of [{ cursor: first.nextCursor, limit: 2 }, { cursor: first.nextCursor, limit: 1, query: 'SQLite' }]) {
    await expect(f.provider.readSessionHistory(f.id, query)).rejects.toThrow(/cursor/);
  }
  f.rows.push(event('user.message', { content: 'A new requirement' })); await f.save();
  await expect(f.provider.readSessionHistory(f.id, { limit: 1, cursor: first.nextCursor })).rejects.toThrow(/changed/);
  await expect(f.provider.readSessionHistory(f.id, { turnId: 'invented-turn' })).rejects.toThrow(/turn.*unsupported/i);
});

it('supports bounded text slices and rejects malformed, incomplete and oversized native history', async () => {
  const f = await history(); f.rows.push(event('user.message', { content: 'x'.repeat(7000) })); await f.save();
  expect((await f.provider.readSessionHistory(f.id, { limit: 1, textOffset: 6000 })).entries[0]).toMatchObject({ text: 'x'.repeat(1000), textOffset: 6000, totalChars: 7000 });
  await writeFile(f.path, JSON.stringify(f.rows[0]));
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/incomplete/);
  await writeFile(f.path, '{invalid}\n');
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/invalid/);
  await writeFile(f.path, 'x'.repeat(8 * 1024 * 1024 + 1));
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/limit/);
});

it('rejects foreign identities, missing histories and symlink escapes without opening a native session', async () => {
  const f = await history();
  await expect(f.provider.readSessionHistory('../other', {})).rejects.toThrow(/identity/);
  await expect(f.provider.readSessionHistory(randomUUID(), {})).rejects.toThrow(/unavailable/);
  f.rows[0]!.data = { sessionId: randomUUID() }; await f.save();
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/identity/);
  const other = await history(); await rm(f.path); await symlink(other.path, f.path);
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/unavailable|scope/);
});

it('uses bounded durable SDK pagination for an existing attachment and excludes child activity', async () => {
  const f = await history(), requests: unknown[] = [];
  const child = { ...event('user.message', { content: 'Child SQLite' }), agentId: 'child' };
  const page = await readCopilotHistoryPage('/unreadable-profile', f.id, { query: 'SQLite' }, async request => {
    requests.push(request);
    return { events: request.cursor ? [...f.rows.slice(2), child] : f.rows.slice(0, 2), cursor: request.cursor ? 'end' : 'next', hasMore: !request.cursor, cursorStatus: 'ok' } as never;
  });
  expect(page.entries.map(entry => entry.text)).toEqual(['Use SQLite', 'SQLite is suitable']);
  expect(requests).toHaveLength(4);
  expect(requests[0]).toEqual({ cursor: undefined, max: 256, waitMs: 0, agentScope: 'primary', includeEphemeral: false });
});

it('rejects expired, nonadvancing, changing or over-limit SDK history instead of publishing partial results', async () => {
  const f = await history();
  const response = { events: f.rows, cursor: 'next', hasMore: false, cursorStatus: 'ok' };
  await expect(readCopilotHistoryPage(f.root, f.id, {}, async () => ({ ...response, cursorStatus: 'expired' }) as never)).rejects.toThrow(/changed/);
  await expect(readCopilotHistoryPage(f.root, f.id, {}, async () => ({ ...response, hasMore: true }) as never)).rejects.toThrow(/advance/);
  let reads = 0;
  await expect(readCopilotHistoryPage(f.root, f.id, {}, async () => ({ ...response, events: ++reads === 1 ? f.rows : [...f.rows, event('user.message', { content: 'New' })] }) as never)).rejects.toThrow(/changed/);
  await expect(readCopilotHistoryPage(f.root, f.id, {}, async () => ({ ...response, events: Array.from({ length: 257 }, () => event('user.message', { content: 'row' })) }) as never)).rejects.toThrow(/limit/);
});

it('fails closed on record exhaustion, duplicate identities and invalid message content', async () => {
  const f = await history();
  const initial = f.rows[0]!;
  await writeFile(f.path, [initial, ...Array.from({ length: 4096 }, () => event('user.message', { content: 'row' }))].map(row => JSON.stringify(row)).join('\n') + '\n');
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/limit/);
  f.rows.push(f.rows[1]!); await f.save();
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/identity/);
  f.rows.pop(); f.rows[1]!.data = { content: {} }; await f.save();
  await expect(f.provider.readSessionHistory(f.id, {})).rejects.toThrow(/unsupported/);
});
