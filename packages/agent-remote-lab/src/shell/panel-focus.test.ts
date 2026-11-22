import { describe, expect, it } from 'vitest';
import { nextPanelIndex } from './panel-focus.js';

describe('nextPanelIndex', () => {
  it.each([
    { name: 'no panel on screen', count: 0, current: -1, backwards: false, next: undefined },
    { name: 'from outside every panel, forwards to the first', count: 3, current: -1, backwards: false, next: 0 },
    { name: 'from outside every panel, backwards to the last', count: 3, current: -1, backwards: true, next: 2 },
    { name: 'the next panel', count: 3, current: 0, backwards: false, next: 1 },
    { name: 'the previous panel', count: 3, current: 2, backwards: true, next: 1 },
    { name: 'past the last wraps to the first', count: 3, current: 2, backwards: false, next: 0 },
    { name: 'before the first wraps to the last', count: 3, current: 0, backwards: true, next: 2 },
    { name: 'one panel stays itself', count: 1, current: 0, backwards: false, next: 0 },
    { name: 'a panel that went away counts as outside', count: 2, current: 5, backwards: false, next: 0 },
  ])('$name', ({ count, current, backwards, next }) => {
    expect(nextPanelIndex(count, current, backwards)).toBe(next);
  });
});
