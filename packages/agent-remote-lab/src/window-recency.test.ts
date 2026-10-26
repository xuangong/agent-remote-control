import { beforeEach, expect, it } from 'vitest';
import { byRecentUse, touchWindow } from './window-recency.js';

beforeEach(() => localStorage.clear());

it('orders Windows by their most recent use on this device, then in catalog order', () => {
  const windows = ['a', 'b', 'c', 'd'].map(id => ({ id }));
  expect(byRecentUse('scope', windows).map(window => window.id)).toEqual(['a', 'b', 'c', 'd']);
  touchWindow('scope', 'c', 100); touchWindow('scope', 'a', 200); touchWindow('scope', 'c', 300);
  expect(byRecentUse('scope', windows).map(window => window.id)).toEqual(['c', 'a', 'b', 'd']);
  // Each page scope keeps its own order.
  expect(byRecentUse('other', windows).map(window => window.id)).toEqual(['a', 'b', 'c', 'd']);
  localStorage.setItem('agent-remote:recovery:scope:window-recency', 'not json');
  expect(byRecentUse('scope', windows).map(window => window.id)).toEqual(['a', 'b', 'c', 'd']);
});
