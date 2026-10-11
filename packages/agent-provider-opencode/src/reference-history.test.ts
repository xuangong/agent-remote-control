import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import type { AgentHistoryQuery } from '@orchardworks/agent-provider-sdk';
import { OpenCodeTransport } from './transport.js';
import { readReferenceHistory } from './reference-history.js';
import type { NativeMessage } from './v2-native.js';
import { assistant, tool } from './test-utils/v2-fixtures.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function history(): NativeMessage[] {
  return [
    { id: 'u1', type: 'user', time: { created: 1 }, text: 'SQLite question' },
    { ...assistant('a1', [{ type: 'reasoning', text: 'private SQLite reasoning' }, { type: 'text', text: 'SQLite intermediate' },
      { ...tool('read'), state: { status: 'completed', input: { path: '/project/file' }, content: [{ type: 'text', text: 'tool result' }, { type: 'file', mime: 'image/png', uri: 'data:image/png;base64,SECRET_BINARY' }] } }]), time: { created: 2, completed: 2 }, finish: 'tool-calls' },
    { ...assistant('a2', [{ type: 'text', text: 'Use SQLite ' + 'x'.repeat(7000) }]), time: { created: 3, completed: 3 }, finish: 'stop' },
    { id: 'idle', type: 'idle', time: { created: 4 }, outcome: 'succeeded' },
    { id: 'u2', type: 'user', time: { created: 5 }, text: 'newest' },
  ];
}
async function fixture(messages = history()) {
  const requests: URL[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); requests.push(url);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method !== 'GET' || url.pathname !== '/api/session/source/message') return json({ message: 'Unexpected source mutation or route' }, 500);
    if (url.searchParams.has('cursor') && url.searchParams.has('order')) return json({ message: 'Cursor defines its own order' }, 400);
    const offset = Number(url.searchParams.get('cursor') ?? 0), limit = Number(url.searchParams.get('limit'));
    const data = [...messages].reverse().slice(offset, offset + limit);
    // Native v2 cursors identify both ends of every nonempty page, including the last page.
    json({ data, cursor: data.length ? { previous: String(offset), next: String(offset + data.length) } : {} });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const transport = new OpenCodeTransport({ serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requestTimeoutMs: 1000 });
  cleanup.push(() => transport.close());
  return { read: (query: AgentHistoryQuery) => readReferenceHistory(transport, 'source', '/project', query), requests };
}

it('reads newest-first with stable paging and bounded text, and returns tool context without reasoning or files', async () => {
  const f = await fixture(); const first = await f.read({ limit: 2 });
  expect(first.entries.map(entry => entry.id)).toEqual(['u2', 'a2']); expect(first.entries[1]!.text).toHaveLength(6000);
  const rest = await f.read({ cursor: first.nextCursor, limit: 2 });
  expect(rest.entries.map(entry => entry.role)).toEqual(['tool', 'assistant']); expect(rest.entries[0]!.text).toContain('tool result');
  expect(JSON.stringify(rest)).not.toContain('private SQLite reasoning'); expect(JSON.stringify(rest)).not.toContain('SECRET_BINARY');
  const turn = await f.read({ turnId: 'u1', limit: 10, textOffset: 6000 });
  expect(turn.entries[0]).toMatchObject({ textOffset: 6000, totalChars: 7011 }); expect(turn.entries[0]!.text).toHaveLength(1011);
}, 10000);

it('searches user and completed final assistant messages chronologically and scopes cursors to the query', async () => {
  const f = await fixture(); const found = await f.read({ query: 'sqlite', limit: 1 });
  expect(found.entries.map(entry => entry.id)).toEqual(['u1']);
  const second = await f.read({ query: 'sqlite', cursor: found.nextCursor, limit: 1 });
  expect(second.entries.map(entry => entry.id)).toEqual(['a2']); expect(second.entries[0]!.turnId).toBe('u1');
  await expect(f.read({ query: 'other', cursor: found.nextCursor })).rejects.toThrow(/cursor/);
  for (const query of [{ limit: 11 }, { textOffset: -1 }, { query: 'x', turnId: 'u1' }]) await expect(f.read(query)).rejects.toThrow(/query/);
}, 10000);

it('searches length-limited final responses, excluding streaming and native internal records', async () => {
  const messages: NativeMessage[] = [...history(),
    { ...assistant('length-final', [{ type: 'text', text: 'SQLite length-limited final' }]), time: { created: 6, completed: 6 }, finish: 'length' },
    { ...assistant('streaming', [{ type: 'text', text: 'SQLite streaming draft' }]), time: { created: 7 } },
    { type: 'system', id: 'system', text: 'SQLite system instructions', time: { created: 8 } },
    { type: 'skill', id: 'skill', skill: 'private', name: 'Private', text: 'SQLite skill instructions', time: { created: 9 } },
    { type: 'synthetic', id: 'synthetic', text: 'SQLite injected context', time: { created: 10 } },
  ];
  const f = await fixture(messages); const found = await f.read({ query: 'sqlite', limit: 10 });
  expect(found.entries.map(entry => entry.id)).toEqual(['u1', 'a2', 'length-final']);
  const recent = await f.read({ limit: 10 });
  expect(recent.entries.slice(0, 2).map(entry => entry.id)).toEqual(['streaming', 'length-final']);
  expect(JSON.stringify(recent)).not.toMatch(/system instructions|skill instructions|injected context|private SQLite reasoning|SECRET_BINARY/);
}, 10000);

it('reads across native pages before assigning a steer to the original turn', async () => {
  const messages: NativeMessage[] = [
    { type: 'user', id: 'turn', text: 'Original question', time: { created: 1 } },
    ...Array.from({ length: 202 }, (_, index): NativeMessage => ({ type: 'system', id: `internal-${index}`, text: 'Private', time: { created: index + 2 } })),
    { type: 'user', id: 'steer', text: 'A later instruction in the same turn', time: { created: 204 } },
    { ...assistant('final', [{ type: 'text', text: 'Final answer' }]), time: { created: 205, completed: 206 }, finish: 'stop' },
  ];
  const f = await fixture(messages); const page = await f.read({ turnId: 'turn', limit: 10 });
  expect(page.entries.map(entry => [entry.id, entry.turnId])).toEqual([['final', 'turn'], ['steer', 'turn'], ['turn', 'turn']]);
  expect(f.requests).toHaveLength(2); expect(f.requests[0]!.searchParams.get('order')).toBe('desc');
  expect(f.requests[1]!.searchParams.has('cursor')).toBe(true); expect(f.requests[1]!.searchParams.has('order')).toBe(false);
}, 10000);
