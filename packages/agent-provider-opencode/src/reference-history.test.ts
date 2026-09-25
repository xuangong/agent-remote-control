import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { OpenCodeTransport } from './transport.js';
import { readReferenceHistory } from './reference-history.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(finalStates = false) {
  const messages = [
    { info: { id: 'u1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'SQLite question' }] },
    { info: { id: 'a1', role: 'assistant', parentID: 'u1', time: { created: 2 }, finish: 'tool-calls' }, parts: [{ type: 'reasoning', text: 'private SQLite reasoning' }, { type: 'text', text: 'SQLite intermediate' }, { id: 't1', type: 'tool', tool: 'read', state: { status: 'completed', input: {}, output: 'tool result' } }] },
    { info: { id: 'a2', role: 'assistant', parentID: 'u1', time: { created: 3, completed: 3 }, finish: 'stop' }, parts: [{ type: 'text', text: 'Use SQLite ' + 'x'.repeat(7000) }] },
    { info: { id: 'u2', role: 'user', time: { created: 4 } }, parts: [{ type: 'text', text: 'newest' }, { type: 'text', text: 'hidden SQLite', ignored: true }] },
  ];
  if (finalStates) messages.push(
    { info: { id: 'length-final', role: 'assistant', parentID: 'u2', time: { created: 5, completed: 6 }, finish: 'length' }, parts: [{ type: 'text', text: 'SQLite length-limited final' }] } as any,
    { info: { id: 'streaming', role: 'assistant', parentID: 'u2', time: { created: 7 } }, parts: [{ type: 'text', text: 'SQLite streaming draft' }] } as any,
  );
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!); const before = new URL(req.url!, 'http://localhost').searchParams.get('before');
    res.writeHead(200, { 'Content-Type': 'application/json', ...(!before ? { 'X-Next-Cursor': 'older' } : {}) });
    res.end(JSON.stringify(before ? messages.slice(0, 2) : messages.slice(2)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const transport = new OpenCodeTransport({ serverUrl: `http://127.0.0.1:${(server.address() as any).port}` }); cleanup.push(() => transport.close());
  return { read: (query: any) => readReferenceHistory(transport, 'source', '/project', query), requests };
}
it('reads newest-first with stable paging and bounded text, and returns tool context without reasoning', async () => {
  const f = await fixture(); const first = await f.read({ limit: 2 });
  expect(first.entries.map(e => e.id)).toEqual(['u2', 'a2']); expect(first.entries[1]!.text).toHaveLength(6000);
  const rest = await f.read({ cursor: first.nextCursor, limit: 2 });
  expect(rest.entries.map(e => e.role)).toEqual(['tool', 'assistant']); expect(rest.entries[0]!.text).toContain('tool result');
  expect(JSON.stringify(rest)).not.toContain('private SQLite reasoning');
  const turn = await f.read({ turnId: 'u1', limit: 10, textOffset: 6000 });
  expect(turn.entries[0]).toMatchObject({ textOffset: 6000, totalChars: 7011 }); expect(turn.entries[0]!.text).toHaveLength(1011);
  expect(f.requests.every(path => path.includes('limit=100'))).toBe(true);
}, 10000);
it('searches visible user and final assistant messages chronologically and scopes cursors to a query', async () => {
  const f = await fixture(); const found = await f.read({ query: 'sqlite', limit: 1 });
  expect(found.entries.map(e => e.id)).toEqual(['u1']);
  const second = await f.read({ query: 'sqlite', cursor: found.nextCursor, limit: 1 });
  expect(second.entries.map(e => e.id)).toEqual(['a2']); expect(second.entries[0]!.turnId).toBe('u1');
  await expect(f.read({ query: 'other', cursor: found.nextCursor })).rejects.toThrow(/cursor/);
  for (const query of [{ limit: 11 }, { textOffset: -1 }, { query: 'x', turnId: 'u1' }]) await expect(f.read(query)).rejects.toThrow(/query/);
}, 10000);

it('searches completed native final responses including length limits and excludes streaming drafts', async () => {
  const f = await fixture(true);
  const found = await f.read({ query: 'sqlite', limit: 10 });
  expect(found.entries.map(entry => entry.id)).toEqual(['u1', 'a2', 'length-final']);
  const recent = await f.read({ limit: 2 }); expect(recent.entries.map(entry => entry.id)).toEqual(['streaming', 'length-final']);
}, 10000);
