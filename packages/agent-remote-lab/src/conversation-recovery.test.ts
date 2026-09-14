// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearConversationRecovery, ReadingPositions, readDrafts, saveDrafts } from './conversation-recovery.js';

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

it('restores drafts and independent reading anchors within a relay scope', () => {
  saveDrafts('alice', { root: 'Unsent root', side: 'Unsent side' });
  expect(readDrafts('alice')).toEqual({ root: 'Unsent root', side: 'Unsent side' });
  expect(readDrafts('bob')).toEqual({});
  const positions = new ReadingPositions('alice');
  positions.set('root:epoch', { following: false, anchor: { key: 'entry-1', offset: -20 } });
  positions.set('side:epoch', { following: true });
  expect([...new ReadingPositions('alice')]).toEqual([...positions]);
  expect(new ReadingPositions('bob').size).toBe(0);
  positions.set('root:epoch', { following: true });
  expect(new ReadingPositions('alice').get('root:epoch')).toEqual({ following: true });
});

it('bounds anchor retention and clears only conversation recovery on sign out', () => {
  const positions = new ReadingPositions('alice');
  for (let index = 0; index < 100; index++) positions.set(String(index), { following: true });
  expect(new ReadingPositions('alice').size).toBe(80);
  expect(positions.has('0')).toBe(false);
  saveDrafts('alice', { root: 'Private draft' });
  sessionStorage.setItem('unrelated', 'preserve');
  clearConversationRecovery();
  expect(readDrafts('alice')).toEqual({});
  expect(new ReadingPositions('alice').size).toBe(0);
  expect(sessionStorage.getItem('unrelated')).toBe('preserve');
});

it('keeps in-memory interaction available when browser storage is denied', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Full'); });
  expect(readDrafts('relay')).toEqual({});
  expect(() => saveDrafts('relay', { root: 'Draft' })).not.toThrow();
  const positions = new ReadingPositions('relay');
  positions.set('root', { following: false });
  expect(positions.get('root')).toEqual({ following: false });
});
