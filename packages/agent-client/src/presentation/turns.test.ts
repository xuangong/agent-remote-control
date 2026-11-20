import { describe, expect, it } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { buildEveryKindConversation, TURN_VECTORS, turnShapes } from '../testing/index.js';
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
