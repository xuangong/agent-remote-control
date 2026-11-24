import { describe, expect, it } from 'vitest';
import { readSessionHistoryPage } from './reference-history.js';

const reasoning = (id: string) => ({ turnId: 't1', item: { type: 'reasoning', id, summary: [], content: [] } });
const said = (id: string, text: string) => ({ turnId: 't1', item: { type: 'agentMessage', id, text } });

/** A transport that answers each `thread/items/list` call with the next scripted page, newest first as Codex does. */
function scripted(pages: Array<{ data: unknown[]; nextCursor: string | null }>) {
  const requests: Array<Record<string, unknown>> = [];
  const transport = { request: async (_method: string, params: Record<string, unknown>) => { requests.push(params); return pages[requests.length - 1] ?? { data: [], nextCursor: null }; } };
  return { transport: transport as never, requests };
}

describe('a page of a session\'s history read through Codex', () => {
  it('reaches the newest readable entry when the newest native items are not readable, rather than answering an empty page', async () => {
    const { transport, requests } = scripted([
      { data: [reasoning('r2')], nextCursor: 'c1' },
      { data: [reasoning('r1')], nextCursor: 'c2' },
      { data: [said('m1', 'The item is done.')], nextCursor: 'c3' },
    ]);
    const page = await readSessionHistoryPage(transport, 'thread', { limit: 1 });
    expect(page.entries.map(entry => [entry.role, entry.text])).toEqual([['assistant', 'The item is done.']]);
    expect(page.nextCursor).toBe('c3');
    expect(requests.map(request => request.cursor)).toEqual([undefined, 'c1', 'c2']);
  });

  it('is empty, without a continuation, when no entry of the history is readable', async () => {
    const { transport } = scripted([{ data: [reasoning('r1')], nextCursor: null }]);
    expect(await readSessionHistoryPage(transport, 'thread', { limit: 1 })).toEqual({ entries: [] });
  });

  it('stops reading after a bounded number of unreadable pages and hands back the cursor to continue from', async () => {
    const pages = Array.from({ length: 40 }, (_, index) => ({ data: [reasoning(`r${index}`)], nextCursor: `c${index}` }));
    const { transport, requests } = scripted(pages);
    const page = await readSessionHistoryPage(transport, 'thread', { limit: 1 });
    expect(page.entries).toEqual([]);
    expect(page.nextCursor).toBe(`c${requests.length - 1}`);
    expect(requests.length).toBeLessThanOrEqual(20);
  });
});
