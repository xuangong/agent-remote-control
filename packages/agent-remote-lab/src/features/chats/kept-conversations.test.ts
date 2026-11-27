import { expect, it } from 'vitest';
import { KEPT_CONVERSATIONS, keepRecent, type KeptConversation } from './kept-conversations.js';

type Item = KeptConversation<string, string>;
const item = (key: string, description = `d-${key}`): Item => ({ key, place: key, description });
const keys = (list: readonly Item[]) => list.map(entry => entry.key);

it('keeps the conversation on screen first and the ones before it by recency', () => {
  let kept: readonly Item[] = [];
  for (const key of ['a', 'b']) kept = keepRecent(kept, key, item(key));
  expect(keys(kept)).toEqual(['b', 'a']);
  kept = keepRecent(kept, 'a', item('a'));
  expect(keys(kept)).toEqual(['a', 'b']);
});

it('releases the oldest conversation beyond the bound of three and keeps no more', () => {
  expect(KEPT_CONVERSATIONS).toBe(3);
  let kept: readonly Item[] = [];
  for (const key of ['a', 'b', 'c', 'd']) kept = keepRecent(kept, key, item(key));
  expect(keys(kept)).toEqual(['d', 'c', 'b']);
  // Going back to the one released keeps it again and releases the next oldest.
  kept = keepRecent(kept, 'a', item('a'));
  expect(keys(kept)).toEqual(['a', 'd', 'c']);
});

it('renews the description of a conversation shown again', () => {
  const kept = keepRecent([item('a', 'old'), item('b')], 'a', item('a', 'new'));
  expect(kept[0]!.description).toBe('new');
});

it('releases a chosen conversation that can no longer be described, and leaves the others', () => {
  expect(keys(keepRecent([item('a'), item('b')], 'a', undefined))).toEqual(['b']);
});

it('keeps the list while no conversation is chosen', () => {
  const kept = [item('a'), item('b')];
  expect(keepRecent(kept, undefined, undefined)).toBe(kept);
});
