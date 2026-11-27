import { describe, expect, it } from 'vitest';
import { lastTurns } from './turn-reading.js';

const entry = (id: string, turnId: string | undefined, type = 'assistant_message') => ({ id, type, ...(turnId ? { turnId } : {}) });

describe('the last turns of a page of a conversation', () => {
  const page = [entry('a1', 't1', 'user_message'), entry('a2', 't1'), entry('b1', 't2', 'user_message'), entry('b2', 't2'), entry('c1', 't3', 'user_message'), entry('c2', 't3'), entry('c3', 't3')];
  it('keeps the entries of the last n turns, in the order they came', () => {
    expect(lastTurns(page, 1).map(item => item.id)).toEqual(['c1', 'c2', 'c3']);
    expect(lastTurns(page, 2).map(item => item.id)).toEqual(['b1', 'b2', 'c1', 'c2', 'c3']);
    expect(lastTurns(page, 9)).toEqual(page);
  });
  it('tells a turn by its id, and where entries carry none by the message that starts it', () => {
    const bare = [entry('x1', undefined, 'user_message'), entry('x2', undefined), entry('y1', undefined, 'user_message'), entry('y2', undefined)];
    expect(lastTurns(bare, 1).map(item => item.id)).toEqual(['y1', 'y2']);
  });
  it('gives back an empty page unchanged and keeps at least one turn', () => {
    expect(lastTurns([], 3)).toEqual([]);
    expect(lastTurns(page, 0).map(item => item.id)).toEqual(['c1', 'c2', 'c3']);
  });
});
