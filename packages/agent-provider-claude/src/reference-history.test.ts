import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { readClaudeHistoryPage } from './reference-history.js';
import { ClaudeAgentProvider } from './provider.js';
import { createClaudeCatalog } from './catalog.js';

const source = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const row = (uuid: string, type: SessionMessage['type'], content: unknown): SessionMessage => ({
  type, uuid, session_id: source, parent_tool_use_id: null, parent_agent_id: null,
  message: { role: type, ...(type === 'assistant' ? { id: `native-${uuid}` } : {}), content },
});
const messages = () => [row('u1', 'user', 'Use SQLite'), row('a1', 'assistant', [
  { type: 'thinking', thinking: 'secret reasoning SQLite' }, { type: 'text', text: 'SQLite is suitable' },
  { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/work/schema' } },
]), row('r1', 'user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Tool-only SQLite detail' }]),
row('u2', 'user', 'Next question'), row('a2', 'assistant', [{ type: 'text', text: 'x'.repeat(7000) }])];
const catalog = (rows: SessionMessage[]) => ({
  info: async (id: string) => ({ sessionId: id, summary: 'fixture', lastModified: 1 }),
  messages: async (_id: string, options: { limit: number; offset: number }) => rows.slice(options.offset, options.offset + options.limit),
});

it('reads newest entries and chronological visible search without exposing reasoning or tool-only matches', async () => {
  const ports = catalog(messages());
  const recent = await readClaudeHistoryPage(ports, source, { limit: 2 });
  expect(recent.entries.map(entry => [entry.role, entry.turnId, entry.totalChars])).toEqual([
    ['assistant', '', 7000], ['user', '', 13],
  ]);
  expect(recent.entries[0]!.id).toContain('a2');
  expect(recent.entries[0]!.text).toHaveLength(6000);
  const rest = await readClaudeHistoryPage(ports, source, { limit: 2, textOffset: 6000 });
  expect(rest.entries[0]!.text).toHaveLength(1000);
  const search = await readClaudeHistoryPage(ports, source, { query: 'SQLITE', limit: 10 });
  expect(search.entries.map(entry => [entry.role, entry.turnId, entry.text])).toEqual([
    ['user', '', 'Use SQLite'], ['assistant', '', 'SQLite is suitable'],
  ]);
  expect(await readClaudeHistoryPage(ports, source, { query: 'secret reasoning' })).toEqual({ entries: [] });
  const context = await readClaudeHistoryPage(ports, source, { limit: 10 });
  expect(context.entries.some(entry => entry.role === 'tool' && entry.text.includes('Tool-only SQLite detail') && entry.text.includes('/work/schema'))).toBe(true);
  expect(JSON.stringify(context)).not.toContain('secret reasoning');
  await expect(readClaudeHistoryPage(ports, source, { turnId: 'u1' })).rejects.toThrow(/turn.*unsupported/i);
}, 10000);

it('uses only the bounded catalog history reader and rejects a catalog without that operation', async () => {
  const provider = new ClaudeAgentProvider({ query: () => { throw new Error('Must not start a model query'); }, catalog: {
    list: async () => [], info: catalog([]).info, messages: async () => { throw new Error('Must not transfer full history'); },
    history: (id, query) => readClaudeHistoryPage(catalog(messages()), id, query),
  } });
  expect((await provider.readSessionHistory(source, { query: 'SQLite' })).entries.map(entry => entry.text)).toEqual(['Use SQLite', 'SQLite is suitable']);
  const unavailable = new ClaudeAgentProvider({ catalog: { list: async () => [], info: catalog([]).info, messages: async () => [] } });
  await expect(unavailable.readSessionHistory(source, {})).rejects.toThrow(/unsupported/i);
  await expect(provider.readSessionHistory('../bad', {})).rejects.toThrow(/identity/i);
  await expect(createClaudeCatalog({}, 0).history!(source, {})).rejects.toThrow(/deadline/i);
}, 10000);

it('rejects a changing observation and excessive content-block projection work', async () => {
  let calls = 0;
  await expect(readClaudeHistoryPage({ info: catalog([]).info, messages: async () => [row('u1', 'user', `${++calls}`)] }, source, {})).rejects.toThrow(/changed during observation/i);
  await expect(readClaudeHistoryPage(catalog([row('a1', 'assistant', Array.from({ length: 257 }, () => ({ type: 'text', text: 'one' })))]), source, {})).rejects.toThrow(/projection.*limit/i);
}, 10000);

it('keeps media omissions visible without returning binary bytes or searching image labels', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'PRIVATE_BINARY_BYTES' } };
  const rows = [row('u1', 'user', [image]), row('a1', 'assistant', [{ type: 'tool_use', id: 'image-tool', name: 'Read', input: {} }]),
    row('r1', 'user', [{ type: 'tool_result', tool_use_id: 'image-tool', content: [image] }])];
  const recent = await readClaudeHistoryPage(catalog(rows), source, { limit: 10 });
  expect(JSON.stringify(recent)).not.toContain('PRIVATE_BINARY_BYTES');
  expect(recent.entries.some(entry => entry.role === 'tool' && entry.text.includes('Tool image unavailable'))).toBe(true);
  expect(recent.entries.some(entry => entry.role === 'user' && entry.text === '[image #1]')).toBe(true);
  expect(await readClaudeHistoryPage(catalog(rows), source, { query: 'image' })).toEqual({ entries: [] });
}, 10000);

it('preserves the normalized tool truncation marker through long-text continuation', async () => {
  const rows = [row('a1', 'assistant', [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }]),
    row('r1', 'user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 't'.repeat(70000) }])];
  const chunks: string[] = [];
  for (let textOffset = 0; textOffset < 72000; textOffset += 6000) {
    const page = await readClaudeHistoryPage(catalog(rows), source, { limit: 1, textOffset });
    chunks.push(page.entries[0]!.text);
    if (textOffset + 6000 >= page.entries[0]!.totalChars) break;
  }
  expect(JSON.parse(chunks.join('')).result).toMatchObject({ content: [{ type: 'text', text: 't'.repeat(65536) }], truncated: true });
}, 10000);

it('rejects unknown content and oversized normalized projection rather than omitting it', async () => {
  await expect(readClaudeHistoryPage(catalog([row('u1', 'user', [{ type: 'document', source: {} }])]), source, {})).rejects.toThrow(/unsupported.*content/i);
  const rows = [row('a1', 'assistant', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'x'.repeat(500000) } }]),
    ...Array.from({ length: 20 }, (_, index) => row(`r${index}`, 'user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }]))];
  await expect(readClaudeHistoryPage(catalog(rows), source, {})).rejects.toThrow(/normalized.*limit/i);
  await expect(readClaudeHistoryPage(catalog(rows), source, { query: 'not present' })).rejects.toThrow(/normalized.*limit/i);
}, 10000);

it('makes each continuation advance and rejects forged positions outside the observed result', async () => {
  const ports = catalog(messages()); const seen = new Set<string>(); let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await readClaudeHistoryPage(ports, source, { limit: 1, ...(cursor ? { cursor } : {}) });
    ids.push(...page.entries.map(entry => entry.id));
    cursor = page.nextCursor;
    if (cursor) { expect(seen.has(cursor)).toBe(false); seen.add(cursor); }
  } while (cursor);
  expect(ids).toHaveLength(6); expect(new Set(ids).size).toBe(6);
  const first = await readClaudeHistoryPage(ports, source, { limit: 1 });
  const forged = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString());
  forged.position = 1000;
  await expect(readClaudeHistoryPage(ports, source, { limit: 1, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') })).rejects.toThrow(/cursor position/i);
}, 10000);

it('pins source, query, bounds and content across continuations while allowing repeated text reads', async () => {
  const rows = messages(); const ports = catalog(rows);
  const first = await readClaudeHistoryPage(ports, source, { limit: 1 });
  expect(first.nextCursor).toBeTypeOf('string');
  const second = await readClaudeHistoryPage(ports, source, { limit: 1, cursor: first.nextCursor });
  expect(second.entries[0]!.text).toBe('Next question');
  expect(await readClaudeHistoryPage(ports, source, { limit: 1, cursor: first.nextCursor, textOffset: 4 })).toMatchObject({ entries: [{ text: ' question' }] });
  for (const query of [{ limit: 2 }, { query: 'SQLite', limit: 1 }]) {
    await expect(readClaudeHistoryPage(ports, source, { ...query, cursor: first.nextCursor })).rejects.toThrow(/cursor/i);
  }
  await expect(readClaudeHistoryPage(ports, other, { limit: 1, cursor: first.nextCursor })).rejects.toThrow(/cursor/i);
  rows[0] = row('u1', 'user', 'Edited SQLite');
  await expect(readClaudeHistoryPage(ports, source, { limit: 1, cursor: first.nextCursor })).rejects.toThrow(/changed/i);
}, 10000);

it('rejects unavailable, foreign, repeated and over-budget native rows explicitly', async () => {
  await expect(readClaudeHistoryPage({ ...catalog([]), info: async () => undefined }, source, {})).rejects.toThrow(/unavailable/i);
  await expect(readClaudeHistoryPage(catalog([{ ...row('u1', 'user', 'text'), session_id: other }]), source, {})).rejects.toThrow(/identity/i);
  await expect(readClaudeHistoryPage(catalog([row('u1', 'user', 'one'), row('u1', 'user', 'two')]), source, {})).rejects.toThrow(/repeat/i);
  expect(await readClaudeHistoryPage(catalog([row('a1', 'assistant', 'unanchored')]), source, {})).toMatchObject({ entries: [{ turnId: '', text: 'unanchored' }] });
  await expect(readClaudeHistoryPage(catalog(Array.from({ length: 2049 }, (_, index) => row(`u${index}`, 'user', 'text'))), source, {})).rejects.toThrow(/scan.*limit/i);
  await expect(readClaudeHistoryPage(catalog([row('u1', 'user', 'x'.repeat(8 * 1024 * 1024))]), source, {})).rejects.toThrow(/byte.*limit/i);
  for (const query of [{ query: '', turnId: 'u1' }, { limit: 11 }, { textOffset: -1 }, { cursor: 'junk' }]) {
    await expect(readClaudeHistoryPage(catalog([]), source, query)).rejects.toThrow(/invalid|cursor/i);
  }
}, 10000);
