// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearConversationRecovery, ReadingPositions, readDrafts, saveDrafts, readLastSession, saveLastSession } from './conversation-recovery.js';

afterEach(() => { clearConversationRecovery(); sessionStorage.clear(); localStorage.clear(); vi.restoreAllMocks(); });

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

it('persists the visible text anchor even when the containing entry offset is unchanged', () => {
  const positions = new ReadingPositions('text-reader');
  const first = { following: false, anchor: { key: 'reply', offset: -800,
    text: { path: [0, 1, 2], character: 8, sample: 'Visible text', top: -3 } } };
  positions.set('session', first);
  const next = { ...first, anchor: { ...first.anchor, text: { ...first.anchor.text, character: 19, sample: 'Next visible line' } } };
  positions.set('session', next);
  expect(new ReadingPositions('text-reader').get('session')).toEqual(next);
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


it('restores the last session from a fresh home launch and removes it on sign out', () => {
  const session = { hostId: 'host-one', providerId: 'codex', nativeSessionId: 'native', agentId: 'old-binding', parentNativeSessionId: 'parent' };
  saveLastSession('relay', session);
  sessionStorage.clear();
  expect(readLastSession('relay')).toEqual(session);
  expect(readLastSession('another-relay')).toBeUndefined();
  localStorage.setItem('unrelated', 'keep');
  clearConversationRecovery();
  expect(readLastSession('relay')).toBeUndefined();
  expect(localStorage.getItem('unrelated')).toBe('keep');
});

it('coalesces reading and draft writes and flushes on page hide without reviving signed-out data', () => {
  vi.useFakeTimers();
  try {
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    const positions = new ReadingPositions('batched');
    for (let i = 0; i < 20; i++) {
      positions.set('session', { following: false, anchor: { key: 'entry', offset: i } });
      saveDrafts('batched', { root: String(i) });
    }
    expect(writes).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    expect(writes).toHaveBeenCalledTimes(3);
    expect(readDrafts('batched').root).toBe('19');
    expect(new ReadingPositions('batched').get('session')?.anchor?.offset).toBe(19);
    saveDrafts('batched', { root: 'Do not resurrect' });
    clearConversationRecovery('batched');
    vi.runAllTimers();
    expect(readDrafts('batched')).toEqual({});
  } finally { vi.useRealTimers(); }
});
it('restores reading positions after a fresh home-screen launch clears tab storage', () => {
  const position = { following: false, anchor: { key: 'last-paragraph', offset: -12 } };
  const positions = new ReadingPositions('personal-device');
  positions.set('session:epoch', position);
  window.dispatchEvent(new Event('pagehide'));
  sessionStorage.clear();
  expect(new ReadingPositions('personal-device').get('session:epoch')).toEqual(position);
  clearConversationRecovery('personal-device');
  expect(new ReadingPositions('personal-device').size).toBe(0);
});
