import { expect, it } from 'vitest';
import { advanceKnowledge, listPresentation, type Knowledge, type KnowledgeEvent } from './known-list.js';

const steps: ReadonlyArray<[Knowledge, KnowledgeEvent, Knowledge]> = [
  ['unknown', 'restored', 'stored'],
  ['unknown', 'confirmed', 'confirmed'],
  ['unknown', 'failed', 'unknown'],
  ['stored', 'confirmed', 'confirmed'],
  ['stored', 'failed', 'stored'],
  ['stored', 'restored', 'stored'],
  ['confirmed', 'restored', 'confirmed'],
  ['confirmed', 'failed', 'confirmed'],
];
it.each(steps)('%s then %s is %s', (from, event, to) => { expect(advanceKnowledge(from, event)).toBe(to); });

it('says empty only after a load confirmed the list empty, shows items whatever is known, and keeps the shell quiet otherwise', () => {
  expect(listPresentation(0, 'unknown')).toBe('quiet');
  expect(listPresentation(0, 'stored')).toBe('quiet');
  expect(listPresentation(0, 'confirmed')).toBe('empty');
  expect(listPresentation(3, 'unknown')).toBe('items');
  expect(listPresentation(3, 'stored')).toBe('items');
  expect(listPresentation(3, 'confirmed')).toBe('items');
});
