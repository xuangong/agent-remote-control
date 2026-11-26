import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock, playRun } from './test-utils/fake-pi.js';
import { piHarness } from './test-utils/harness.js';

const open: Array<{ close(): Promise<void> }> = [];
const harness = (...args: Parameters<typeof piHarness>) => { const h = piHarness(...args); open.push(h); return h; };
afterEach(async () => { await Promise.all(open.splice(0).map(h => h.close())); });
const ID = '0f5c51e2-71e4-4ab9-b111-e054c951bc6a';

function seed(h: ReturnType<typeof harness>, turns: string[] = ['First question', 'Second question']) {
  const clock = new FakeClock();
  const messages = turns.flatMap((prompt, index) => playRun({ prompt, messages: [{ text: `ANSWER_${index + 1}` }] }, clock).messages);
  h.fake.save({ sessionFile: `${h.agentDirectory}/sessions/--workspace--/2026-11-26T00-00-00-000Z_${ID}.jsonl`, sessionId: ID, launch: { cwd: h.cwd }, conversation: messages } as never);
  return `${h.agentDirectory}/sessions/--workspace--/2026-11-26T00-00-00-000Z_${ID}.jsonl`;
}

describe('the pi catalog', () => {
  it('lists saved sessions with their workspace, title and times, and reads the workspace of one', async () => {
    const h = harness(); seed(h);
    const [summary] = await h.provider.listSessions();
    expect(summary).toMatchObject({ nativeSessionId: ID, providerId: 'pi', title: 'First question', workspace: h.cwd, state: 'unknown' });
    expect(await h.provider.sessionWorkspace(ID)).toBe(h.cwd);
    expect(await h.provider.sessionWorkspace('1a5c51e2-71e4-4ab9-b111-e054c951bc6b')).toBeUndefined();
    await expect(h.provider.sessionWorkspace(ID, { providerId: 'codex', sessionId: ID, opaque: '{}' })).rejects.toThrow(/Invalid pi persistence handle/);
  });

  it('renames a saved session by appending the name pi itself records, and confirms it', async () => {
    const h = harness(); const file = seed(h);
    expect(await h.provider.renameSession(ID, '  Release plan ')).toBe('Release plan');
    expect(await h.provider.readSessionTitle(ID)).toBe('Release plan');
    const last = JSON.parse(readFileSync(file, 'utf8').trimEnd().split('\n').at(-1)!) as { type: string; name: string; parentId: string };
    expect(last).toMatchObject({ type: 'session_info', name: 'Release plan' });
    expect(() => h.provider.validateSessionTitle('')).toThrow();
    expect(() => h.provider.validateSessionTitle('a\nb')).toThrow();
    await expect(h.provider.renameSession('1a5c51e2-71e4-4ab9-b111-e054c951bc6b', 'x')).rejects.toThrow(/not found/);
  });

  it('renames a session that is open through pi, which owns its file then', async () => {
    const h = harness(); seed(h);
    const session = await h.provider.resumeSession({ providerId: 'pi', sessionId: ID, opaque: '{}' });
    expect(await h.provider.renameSession(ID, 'Live name')).toBe('Live name');
    expect(h.fake.renamed).toEqual(['Live name']);
    await session.dispose();
  });

  it('reads a bounded page of the conversation newest first, with its text cut to a page, and searches it', async () => {
    const h = harness(); seed(h);
    const first = await h.provider.readSessionHistory(ID, { limit: 3 });
    expect(first.entries.map(entry => [entry.role, entry.text])).toEqual([['assistant', 'ANSWER_2'], ['user', 'Second question'], ['assistant', 'ANSWER_1']]);
    expect(first.nextCursor).toBeDefined();
    const next = await h.provider.readSessionHistory(ID, { limit: 3, cursor: first.nextCursor });
    expect(next.entries.map(entry => entry.text)).toEqual(['First question']);
    expect(next.nextCursor).toBeUndefined();
    const found = await h.provider.readSessionHistory(ID, { query: 'second' });
    expect(found.entries.map(entry => entry.text)).toEqual(['Second question']);
    const turn = first.entries[0]!.turnId;
    expect((await h.provider.readSessionHistory(ID, { turnId: turn })).entries.map(entry => entry.text)).toEqual(['ANSWER_2', 'Second question']);
    expect((await h.provider.readSessionHistory(ID, { limit: 1, textOffset: 3 })).entries[0]).toMatchObject({ text: 'WER_2', textOffset: 3, totalChars: 8 });
  });

  it('rejects a bad query, a cursor of another query and an unknown session', async () => {
    const h = harness(); seed(h);
    await expect(h.provider.readSessionHistory(ID, { limit: 11 })).rejects.toThrow(/Invalid pi source history query/);
    const page = await h.provider.readSessionHistory(ID, { limit: 1 });
    await expect(h.provider.readSessionHistory(ID, { limit: 1, query: 'x', cursor: page.nextCursor })).rejects.toThrow(/cursor/);
    await expect(h.provider.readSessionHistory('1a5c51e2-71e4-4ab9-b111-e054c951bc6b', {})).rejects.toThrow(/not found/);
    await expect(h.provider.readSessionHistory('../x', {})).rejects.toThrow(/Invalid pi session identity/);
  });

  it('releases an open session on request and refuses new sessions once disposed', async () => {
    const h = harness(); seed(h);
    await h.provider.resumeSession({ providerId: 'pi', sessionId: ID, opaque: '{}' });
    await h.provider.releaseSession(ID);
    expect(h.fake.last.exited).toBeDefined();
    await (await h.provider.resumeSession({ providerId: 'pi', sessionId: ID, opaque: '{}' })).dispose();
    await h.provider.dispose();
    await expect(h.provider.createSession({ sessionId: 'a', cwd: h.cwd })).rejects.toThrow(/closed/);
  });
});
