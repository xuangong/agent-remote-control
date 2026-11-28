import { beforeEach, expect, it } from 'vitest';
import { readExpanded, writeExpanded } from './workbench-expansion.js';

beforeEach(() => localStorage.clear());
it('keeps the expanded tiles per workbench and scope', () => {
  writeExpanded('s', 'w1', new Set(['sub:a']));
  expect([...readExpanded('s', 'w1')]).toEqual(['sub:a']);
  expect(readExpanded('s', 'w2').size).toBe(0);
  expect(readExpanded('other', 'w1').size).toBe(0);
});
it('reads nothing from a damaged record or no Window', () => {
  localStorage.setItem('agent-remote:recovery:s:workbench-expanded:w1', '{broken');
  expect(readExpanded('s', 'w1').size).toBe(0);
  expect(readExpanded('s', undefined).size).toBe(0);
});
