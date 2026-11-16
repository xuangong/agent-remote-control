import { describe, expect, it } from 'vitest';

import { recording } from './test-utils/copilot-recordings.js';
import { continuityOutcome, itemsOf, journalOfRun, type ContinuityOutcome } from './test-utils/journal-continuity.js';

const UNCHANGED: ContinuityOutcome = { outcome: 'unchanged' };

describe('Copilot journal continuity, from the recordings of the real CLI', () => {
  it.each(['settled', 'restart', 'reasoning', 'approval', 'todos', 'compaction', 'interrupted', 'partial-tool'])('%s: reopening gives unchanged, and a second reread adds nothing', async name => {
    const run = recording(name);
    const journal = await journalOfRun(run.live);
    expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    expect(journal.openKeys()).toEqual([]);
  });

  it('gives every row an identity and none a key the Controller keeps for itself', async () => {
    for (const name of ['settled', 'approval', 'todos', 'compaction', 'interrupted']) {
      const items = [...await itemsOf(recording(name).live), ...await itemsOf(recording(name).reread)];
      expect(items.length).toBeGreaterThan(0);
      expect(items.filter(({ key }) => key.startsWith('controller:'))).toEqual([]);
    }
  });

  it('approval: the question the reread cannot reproduce stays in the journal, live-only, and a tool approval does not', async () => {
    const run = recording('approval');
    const journal = await journalOfRun(run.live);
    const before = journal.keys();
    expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    expect(journal.keys()).toEqual(before);
    const resolved = run.live.filter(({ event }) => event.type === 'interaction_resolved').map(({ itemIdentity }) => itemIdentity);
    expect(resolved.map(identity => identity?.liveOnly === true)).toEqual([true, false, false]);
    expect(journal.liveOnlyKeys()).toEqual([resolved[0]!.key]);
  });

  it('todos: the live-only snapshot survives the reopen and the reread holds none', async () => {
    const run = recording('todos');
    const journal = await journalOfRun(run.live);
    const snapshots = journal.liveOnlyKeys();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every(key => key.startsWith('todo:'))).toBe(true);
    expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    expect(journal.liveOnlyKeys()).toEqual(snapshots);
    expect(run.reread.some(({ event }) => event.type === 'timeline' && event.item.type === 'todo')).toBe(false);
  });

  it('reasoning: the native history does not keep it, so the journal keeps the streamed copy as live-only', async () => {
    const run = recording('reasoning');
    const journal = await journalOfRun(run.live);
    expect(journal.liveOnlyKeys().filter(key => key.startsWith('reasoning:'))).toHaveLength(1);
    expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    expect(journal.liveOnlyKeys().filter(key => key.startsWith('reasoning:'))).toHaveLength(1);
  });

  it('compaction: a failed one finishes its item, beside an error item', async () => {
    const run = recording('compaction');
    const journal = await journalOfRun(run.live);
    expect(journal.keys().filter(key => key.startsWith('compaction:'))).toHaveLength(2);
    expect(journal.keys().filter(key => key.startsWith('error:'))).toHaveLength(1);
    expect(journal.openKeys()).toEqual([]);
  });

  it('interrupted: the text that streamed before the cancel is kept live-only and no item stays open', async () => {
    const run = recording('interrupted');
    const journal = await journalOfRun(run.live);
    expect(journal.liveOnlyKeys().filter(key => key.startsWith('assistant:'))).toHaveLength(1);
    expect(journal.openKeys()).toEqual([]);
    for (let reopen = 0; reopen < 5; reopen += 1) expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
  });

  it('partial-tool: a tool that streamed output reads the same, because its last row carries the whole result', async () => {
    const run = recording('partial-tool');
    const streamed = run.live.filter(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call' && event.item.status === 'running');
    expect(streamed.length).toBeGreaterThan(1);
    expect(await continuityOutcome(run)).toEqual(UNCHANGED);
  });

  it('a tool that completed while the Controller was away replaces the journal once, as an open item', async () => {
    const run = recording('partial-tool');
    const completes = run.live.findIndex(({ itemIdentity }) => itemIdentity?.key.startsWith('tool:') && itemIdentity.completes === true);
    expect(completes).toBeGreaterThan(0);
    const journal = await journalOfRun(run.live.slice(0, completes));
    expect(journal.openKeys().filter(key => key.startsWith('tool:'))).toHaveLength(1);
    expect(await journal.reread(run.reread)).toEqual({ outcome: 'replaced', reason: 'open_item' });
    expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
  });

  it('a session that grew while the Controller was away appends the newest items of its reread', async () => {
    const run = recording('settled');
    const firstTurn = run.live.findIndex(({ event }) => event.type === 'turn_completed') + 1;
    const grown = (await itemsOf(run.reread.map(observation => ({ ...observation, delivery: 'history' as const })))).length;
    const known = (await itemsOf(run.live.slice(0, firstTurn))).length;
    const journal = await journalOfRun(run.live.slice(0, firstTurn));
    expect(known).toBeLessThan(grown);
    expect(await journal.newest(run.reread, grown - known + 1)).toEqual({ outcome: 'appended' });
    expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
  });

  it('a session whose reread lost an item the journal holds replaces the journal, as a changed item', async () => {
    const run = recording('settled');
    const lastUser = run.reread.map(({ event }) => event.type === 'timeline' && event.item.type === 'user_message').lastIndexOf(true);
    expect(await continuityOutcome({ live: run.live, reread: run.reread.slice(0, lastUser) })).toEqual({ outcome: 'replaced', reason: 'changed' });
  });
});
