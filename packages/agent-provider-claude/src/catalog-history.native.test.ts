import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ClaudeAgentProvider } from '../dist/provider.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'arc-claude-history-'));
  const cwd = join(home, 'workspace'), profile = join(home, 'profile');
  const project = join(profile, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(cwd); await mkdir(project, { recursive: true });
  const sessionId = randomUUID(), file = join(project, `${sessionId}.jsonl`);
  const provider = new ClaudeAgentProvider({ env: { CLAUDE_CONFIG_DIR: profile }, requestTimeoutMs: 10000,
    query: () => { throw new Error('History reads must never open a native query'); } });
  const rows: Record<string, unknown>[] = [];
  const append = (type: 'user' | 'assistant', content: unknown) => {
    const uuid = randomUUID();
    rows.push({ type, uuid, parentUuid: rows.at(-1)?.uuid ?? null, sessionId, cwd, timestamp: new Date().toISOString(),
      message: { role: type, ...(type === 'assistant' ? { id: `msg-${uuid}`, model: 'fixture' } : {}), content } });
    return uuid;
  };
  return { home, sessionId, provider, rows, append, save: () => writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n') };
}

it('projects isolated public SDK history in the real worker without opening or resuming a session', async () => {
  const f = await fixture();
  try {
    const firstUser = f.append('user', 'Use SQLite');
    const assistant = f.append('assistant', [
      { type: 'thinking', thinking: 'Hidden reasoning SQLite' }, { type: 'text', text: 'SQLite answer' },
      { type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/work/schema' } },
    ]);
    f.append('user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'tool SQLite output' }]);
    f.append('user', 'Second question');
    const finalAssistant = f.append('assistant', [{ type: 'text', text: 'z'.repeat(7000) }]);
    await f.save();
    const search = await f.provider.readSessionHistory(f.sessionId, { query: 'SQLITE', limit: 10 });
    expect(search.entries.map(entry => [entry.role, entry.text, entry.turnId])).toEqual([
      ['user', 'Use SQLite', ''], ['assistant', 'SQLite answer', ''],
    ]);
    expect(search.entries[0]!.id).toContain(firstUser); expect(search.entries[1]!.id).toContain(assistant);
    const first = await f.provider.readSessionHistory(f.sessionId, { limit: 1 });
    expect(first.entries[0]).toMatchObject({ role: 'assistant', totalChars: 7000, textOffset: 0 });
    expect(first.entries[0]!.id).toContain(finalAssistant); expect(first.entries[0]!.text).toHaveLength(6000);
    const continuation = await f.provider.readSessionHistory(f.sessionId, { cursor: first.nextCursor, limit: 1 });
    expect(continuation.entries[0]!.text).toBe('Second question');
    const context = await f.provider.readSessionHistory(f.sessionId, { limit: 10 });
    expect(context.entries.some(entry => entry.role === 'tool' && entry.text.includes('tool SQLite output') && entry.text.includes('/work/schema'))).toBe(true);
    expect(JSON.stringify(context)).not.toContain('Hidden reasoning');
    await expect(f.provider.readSessionHistory(f.sessionId, { turnId: firstUser })).rejects.toThrow(/turn.*unsupported/i);
    f.append('user', 'Appended input'); await f.save();
    await expect(f.provider.readSessionHistory(f.sessionId, { cursor: first.nextCursor, limit: 1 })).rejects.toThrow(/changed/i);
    await expect(f.provider.readSessionHistory(randomUUID(), {})).rejects.toThrow(/unavailable/i);
  } finally { await f.provider.dispose(); await rm(f.home, { recursive: true, force: true }); }
}, 20000);

it('returns explicit bounded failure for an oversized public catalog instead of a complete empty page', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 2049; index++) f.append('user', `message ${index}`);
    await f.save();
    await expect(f.provider.readSessionHistory(f.sessionId, {})).rejects.toThrow(/scan.*limit/i);
  } finally { await f.provider.dispose(); await rm(f.home, { recursive: true, force: true }); }
}, 20000);
