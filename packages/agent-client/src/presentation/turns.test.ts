import { describe, expect, it } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { buildEveryKindConversation, TimelineRows, TURN_VECTORS, turnShapes } from '../testing/index.js';
import { foldTurns, type Turn } from './turns.js';

/** T-1: the entries of a fold, in the order the fold holds them. */
export function foldedEntries(turns: readonly Turn[]): ProjectedTimelineEntry[] {
  return turns.flatMap(turn => [...(turn.prompt ? [turn.prompt] : []), ...turn.work.flatMap(step => step.entries), ...turn.answer, ...turn.letters]);
}

describe('foldTurns', () => {
  it.each(TURN_VECTORS)('$rule: $name', ({ entries, activeTurn = null, status, pending = 0, turns }) => {
    expect(turnShapes(foldTurns(entries, activeTurn, status, pending), turns.some(turn => turn.key !== undefined))).toEqual(turns);
  });

  it.each(TURN_VECTORS)('T-1: every entry is in one turn, once ($name)', ({ entries, activeTurn = null, status, pending = 0 }) => {
    const folded = foldedEntries(foldTurns(entries, activeTurn, status, pending));
    expect([...folded].sort((a, b) => a.seqStart - b.seqStart)).toEqual(entries);
  });

  it('T-1: every kind of row of a whole conversation is in one turn, once', () => {
    const { entries, snapshot } = buildEveryKindConversation();
    const turns = foldTurns(entries, snapshot.activeTurn, snapshot.status, 0);
    const folded = foldedEntries(turns);
    expect(folded).toHaveLength(entries.length);
    expect(new Set(folded).size).toBe(entries.length);
    expect(new Set(turns.map(turn => turn.key)).size).toBe(turns.length);
  });

  it('folds the every-kind conversation as a person reads it', () => {
    const { entries, snapshot } = buildEveryKindConversation();
    const turns = foldTurns(entries, snapshot.activeTurn, snapshot.status, 0);
    expect(turns.map(turn => [turn.prompt?.itemKey, turn.answer.map(entry => entry.itemKey), turn.letters.map(entry => entry.itemKey), turn.state])).toEqual([
      ['prompt-1', ['answer-1'], ['letter-1'], 'ended'],
      ['withdrawn-1', [], [], 'ended'],
      ['prompt-3', [], [], 'running'],
    ]);
    expect(turns[0]!.work.map(step => step.kind)).toEqual(['reasoning', 'command', 'read', 'read', 'narration', 'search', 'fetch', 'tool', 'interaction_receipt', 'edit', 'edit',
      'command', 'command', 'todo', 'compaction', 'notice', 'interaction_receipt', 'interaction_receipt', 'interaction_receipt', 'interaction_receipt', 'interaction_receipt', 'background']);
  });

  it('T-6: only the last turn can run, whatever the activity says', () => {
    const { entries } = buildEveryKindConversation();
    for (const activeTurn of [{ turnId: 'turn-1' }, { turnId: 'turn-3' }, null]) for (const status of ['running', 'waiting', 'idle'] as const) {
      const turns = foldTurns(entries, activeTurn, status, 1);
      expect(turns.slice(0, -1).every(turn => turn.state === 'ended')).toBe(true);
    }
  });

  it('is empty for an empty timeline', () => {
    expect(foldTurns([], null)).toEqual([]);
  });
});

describe('a long timeline', () => {
  const shell = { type: 'shell', command: 'npm test' } as const;
  /** Adds `count` turns of five rows (a message, a remark, a tool call, a letter and an answer); every other turn carries a turn id. */
  function addTurns(rows: TimelineRows, first: number, count: number): void {
    for (let turn = first; turn < first + count; turn += 1) {
      const options = turn % 2 === 0 ? { turnId: `turn-${turn}` } : {};
      rows.user(`Ask ${turn}`, options); rows.assistant(`Looking ${turn}`, options); rows.tool('Bash', shell, 'completed', options); rows.letter(`Note ${turn}`, options); rows.assistant(`Done ${turn}`, options);
    }
  }

  it('folds a thousand entries into one turn each, once, with a unique key per turn', () => {
    const rows = new TimelineRows();
    addTurns(rows, 0, 200);
    expect(rows.entries).toHaveLength(1000);
    const turns = foldTurns(rows.entries, null, 'idle');
    expect(turns).toHaveLength(200);
    const folded = foldedEntries(turns);
    expect(folded).toHaveLength(1000);
    expect(new Set(folded).size).toBe(1000);
    expect(new Set(turns.map(turn => turn.key)).size).toBe(turns.length);
    expect(turns.every(turn => turn.state === 'ended')).toBe(true);
  });

  it('keys the same entries the same on every fold', () => {
    const rows = new TimelineRows();
    addTurns(rows, 0, 20);
    expect(foldTurns(rows.entries, null, 'idle').map(turn => turn.key)).toEqual(foldTurns(rows.entries, null, 'idle').map(turn => turn.key));
  });

  it('keeps the keys of the earlier turns when a row or a turn is appended', () => {
    const rows = new TimelineRows();
    addTurns(rows, 0, 20);
    const keys = () => foldTurns(rows.entries, null, 'idle').map(turn => turn.key);
    const before = keys();
    rows.assistant('One more answer', { turnId: 'turn-18' });
    expect(keys()).toEqual(before);
    addTurns(rows, 20, 1);
    const after = keys();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
  });
});
