// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { TimelineEntryIndex } from './timeline-entry-index.js';

/** A scroller of entries laid out by hand: each with its box, and whether its turn is rendered. */
function timeline(entries: { key: string; top: number; bottom: number; rendered: boolean }[]) {
  const root = document.createElement('div');
  for (const spec of entries) {
    const entry = document.createElement('div');
    entry.dataset.entryKey = spec.key;
    entry.getBoundingClientRect = () => ({ top: spec.top, bottom: spec.bottom, left: 0, right: 0, width: 0, height: spec.bottom - spec.top, x: 0, y: spec.top, toJSON() {} });
    (entry as unknown as { checkVisibility(options: unknown): boolean }).checkVisibility = () => spec.rendered;
    root.append(entry);
  }
  return new TimelineEntryIndex().refresh(root);
}

it('finds the entry under a line', () => {
  const index = timeline([{ key: 'a', top: -200, bottom: -80, rendered: true }, { key: 'b', top: -80, bottom: 40, rendered: true }, { key: 'c', top: 40, bottom: 160, rendered: true }]);
  expect(index.at(0)?.dataset.entryKey).toBe('b');
});

it('never takes an entry of a turn that is not rendered for the line a reader is on: its box is the turn\'s collapsed one', () => {
  // The turn of a and b was not rendered; it reports one box over the line. c is the first line the reader can be on.
  const index = timeline([{ key: 'a', top: -50, bottom: 110, rendered: false }, { key: 'b', top: -50, bottom: 110, rendered: false }, { key: 'c', top: 110, bottom: 230, rendered: true }]);
  expect(index.at(0)?.dataset.entryKey).toBe('c');
});

it('takes the entries as they are where the browser cannot say whether a turn is rendered', () => {
  const root = document.createElement('div'), entry = document.createElement('div');
  entry.dataset.entryKey = 'a';
  entry.getBoundingClientRect = () => ({ top: -10, bottom: 100, left: 0, right: 0, width: 0, height: 110, x: 0, y: -10, toJSON() {} });
  root.append(entry);
  expect(new TimelineEntryIndex().refresh(root).at(0)).toBe(entry);
});
