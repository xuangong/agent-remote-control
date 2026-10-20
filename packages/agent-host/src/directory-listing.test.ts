import { afterEach, expect, it, vi } from 'vitest';
import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import type { CodexSessionListOptions, CodexSessionPage, CodexSessionSummary } from '@orchardworks/agent-provider-codex';
import { createCodexSessionDirectory } from './directory.js';

afterEach(() => vi.restoreAllMocks());

/** A Codex thread store that pages by update time, newest first, and counts every session it reads. */
function store(count: number) {
  let now = 1_000;
  const threads = new Map<string, number>();
  const titles = new Map<string, string>();
  for (let index = 0; index < count; index++) threads.set(`thread-${index}`, now++);
  let read = 0;
  const summary = (id: string, updated: number): CodexSessionSummary => ({ nativeSessionId: id, providerId: 'codex', title: titles.get(id) ?? id,
    createdAt: new Date(1_000_000).toISOString(), updatedAt: new Date(updated * 1000).toISOString(), state: 'idle' });
  async function listSessions(options: CodexSessionListOptions = {}): Promise<CodexSessionPage> {
    const ordered = [...threads].sort((a, b) => b[1] - a[1]);
    const offset = options.cursor ? Number(options.cursor) : 0, limit = options.limit ?? 100;
    const page = ordered.slice(offset, offset + limit);
    read += page.length;
    return { sessions: page.map(([id, updated]) => summary(id, updated)), ...(offset + limit < ordered.length ? { nextCursor: String(offset + limit) } : {}) };
  }
  const session = {} as AgentSession;
  const directory = createCodexSessionDirectory({ listSessions, createSession: async () => session, resumeSession: async () => session, openChildSession: async () => session,
    renameSession: async (id: string, title: string) => { titles.set(id, title); return title; } }, []);
  return {
    directory, reads: () => { const value = read; read = 0; return value; },
    touch(id: string) { threads.set(id, now++); }, remove(id: string) { threads.delete(id); },
    add(id: string) { threads.set(id, now++); }, rename(id: string, title: string) { titles.set(id, title); },
    ids: async () => (await directory.list()).map(item => item.nativeSessionId).sort(),
    titles: async () => new Map((await directory.list()).map(item => [item.nativeSessionId, item.title])),
  };
}

it('reads only the newest sessions between full listings while reflecting new, updated and recently removed sessions', async () => {
  let clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const codex = store(300);
  expect((await codex.directory.list())).toHaveLength(300);
  expect(codex.reads()).toBe(300);
  codex.add('new'); codex.touch('thread-5'); codex.remove('thread-298');
  clock += 15_000;
  const listed = await codex.directory.list();
  expect(codex.reads()).toBe(10);
  expect(listed).toHaveLength(300);
  expect(listed.slice(0, 2).map(item => item.nativeSessionId)).toEqual(['thread-5', 'new']);
  expect(listed.find(item => item.nativeSessionId === 'thread-5')?.updatedAt).toBe(new Date(1_301 * 1000).toISOString());
  expect(listed.some(item => item.nativeSessionId === 'thread-298')).toBe(false);
});

it('falls back to a full listing when too many sessions changed or the last full listing is old', async () => {
  let clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const codex = store(150);
  await codex.directory.list(); codex.reads();
  for (let index = 0; index < 12; index++) codex.touch(`thread-${index}`);
  clock += 15_000;
  expect(await codex.directory.list()).toHaveLength(150);
  expect(codex.reads()).toBe(160);
  clock += 5 * 60_000;
  codex.remove('thread-0');
  expect(await codex.directory.list()).toHaveLength(149);
  expect(codex.reads()).toBe(149);
});

it('reads a renamed session again on the next listing', async () => {
  const codex = store(50);
  await codex.directory.list(); codex.reads();
  await codex.directory.renameSession!('thread-0', 'Renamed');
  expect((await codex.titles()).get('thread-0')).toBe('Renamed');
  expect(codex.reads()).toBe(50);
});
