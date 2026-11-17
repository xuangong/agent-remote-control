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

it('serves an empty catalog until explicitly listed and never probes automatically', async () => {
  const codex = store(300);
  expect(await codex.directory.list()).toEqual([]);
  expect(codex.reads()).toBe(0);
  await codex.directory.listing!.refresh();
  expect(await codex.directory.list()).toHaveLength(300);
  expect(codex.reads()).toBe(300);
  codex.add('new'); codex.remove('thread-298');
  await codex.directory.list(); await codex.directory.list();
  expect(codex.reads()).toBe(0);
  await codex.directory.listing!.refresh();
  const listed = await codex.directory.list();
  expect(listed).toHaveLength(300);
  expect(listed.some(item => item.nativeSessionId === 'new')).toBe(true);
  expect(listed.some(item => item.nativeSessionId === 'thread-298')).toBe(false);
  expect(codex.reads()).toBe(300);
  await codex.directory.close?.();
});

it('updates a renamed session without listing native sessions', async () => {
  const codex = store(50);
  await codex.directory.listing!.refresh(); codex.reads();
  await codex.directory.renameSession!('thread-0', 'Renamed');
  expect((await codex.titles()).get('thread-0')).toBe('Renamed');
  expect(codex.reads()).toBe(0);
  await codex.directory.close?.();
});
