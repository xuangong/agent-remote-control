import { describe, expect, it } from 'vitest';
import { restoredReading } from './reading-restore.js';

const anchor = { key: 'assistant:42', offset: -18 };
describe('restoredReading', () => {
  it.each([
    { name: 'nothing saved: the latest message', saved: undefined, continuity: undefined, restore: { following: true } },
    { name: 'saved at the latest: the latest message', saved: { following: true }, continuity: undefined, restore: { following: true } },
    { name: 'saved while reading back: the same row at the same offset', saved: { following: false, anchor }, continuity: undefined, restore: { following: false, anchor } },
    { name: 'a saved place wins over the view it carries on', saved: { following: false, anchor }, continuity: { following: true, scrollTop: 0 }, restore: { following: false, anchor } },
    { name: 'a saved latest wins over a view that was reading back', saved: { following: true }, continuity: { following: false, scrollTop: 320 }, restore: { following: true } },
    { name: 'none saved: carries on a view that was reading back, at its offset', saved: undefined, continuity: { following: false, scrollTop: 320 }, restore: { following: false, scrollTop: 320 } },
    { name: 'none saved: carries on a view that followed the latest', saved: undefined, continuity: { following: true, scrollTop: 900 }, restore: { following: true } },
    { name: 'none saved: a view reading back with no offset yet', saved: undefined, continuity: { following: false }, restore: { following: false } },
  ])('$name', ({ saved, continuity, restore }) => {
    expect(restoredReading(saved, continuity)).toEqual(restore);
  });
});
