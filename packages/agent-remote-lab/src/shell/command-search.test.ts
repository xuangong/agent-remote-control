import { expect, it } from 'vitest';
import { searchCommands, type CommandItem } from './command-search.js';

const item = (id: string, title: string, kind: CommandItem['kind'] = 'session', extra: Partial<CommandItem> = {}): CommandItem =>
  ({ id, kind, title, run: () => {}, ...extra });

it('ranks title prefixes, then word prefixes, then substrings, and drops non-matches', () => {
  const items = [item('a', 'Refactor parser'), item('b', 'Fix the parser'), item('c', 'Sparse arrays'), item('d', 'Unrelated'), item('e', 'Parser notes')];
  // "a" and "b" both match "par" at a word start: the tie keeps the given order.
  expect(searchCommands(items, 'par').map(entry => entry.id)).toEqual(['e', 'a', 'b', 'c']);
  expect(searchCommands(items, 'refactor').map(entry => entry.id)).toEqual(['a']);
});

it('breaks score ties by kind, then by the given order', () => {
  const items = [item('s', 'Deploy notes'), item('w', 'Deploy', 'window'), item('a', 'Deploy now', 'action'), item('b', 'Deploy bot', 'bot')];
  expect(searchCommands(items, 'deploy').map(entry => entry.id)).toEqual(['a', 'w', 'b', 's']);
});

it('matches every word of the query, in any order, across title, subtitle and keywords', () => {
  const items = [item('a', 'Research', 'window', { subtitle: '3 session views' }), item('b', 'New Window', 'action', { keywords: ['create'] })];
  expect(searchCommands(items, 'views research').map(entry => entry.id)).toEqual(['a']);
  expect(searchCommands(items, 'create').map(entry => entry.id)).toEqual(['b']);
});

it('ignores case and diacritics, and keeps the given order for an empty query, actions first', () => {
  const items = [item('s', 'Café notes'), item('w', 'Main', 'window'), item('n', 'New session', 'action')];
  expect(searchCommands(items, 'CAFE').map(entry => entry.id)).toEqual(['s']);
  expect(searchCommands(items, '').map(entry => entry.id)).toEqual(['n', 'w', 's']);
});

it('caps each kind', () => {
  const items = Array.from({ length: 30 }, (_, index) => item(`s${index}`, `Session ${index}`));
  expect(searchCommands(items, 'session', { perKind: 8 })).toHaveLength(8);
  expect(searchCommands([...items, item('w', 'Session window', 'window')], 'session', { perKind: 8 }).map(entry => entry.id)).toContain('w');
});

it('ranks the same after many distinct titles have passed through its folding cache', () => {
  const run = () => {};
  const many = Array.from({ length: 5000 }, (_, index) => ({ id: `s${index}`, kind: 'session' as const, title: `Séance ${index}`, run }));
  expect(searchCommands(many, 'seance 4999', { perKind: 1 }).map(item => item.id)).toEqual(['s4999']);
  expect(searchCommands([{ id: 'c', kind: 'action', title: 'Café', run }], 'cafe').map(item => item.id)).toEqual(['c']);
});
