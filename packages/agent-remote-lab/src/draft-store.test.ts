import { afterEach, expect, it, vi } from 'vitest';
import { DraftStore } from './draft-store.js';
import { clearConversationRecovery, readDrafts } from './conversation-recovery.js';
import { conversationSessionStorage } from './conversation-storage.js';

afterEach(() => { clearConversationRecovery(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('notifies only the edited conversation and persists the latest draft', () => {
  const store = new DraftStore('scoped-drafts');
  const first = vi.fn(); const second = vi.fn();
  const stop = store.subscribe('one', first);
  store.subscribe('two', second);
  store.set('one', 'First'); store.set('one', 'First');
  expect(first).toHaveBeenCalledTimes(1); expect(second).not.toHaveBeenCalled();
  stop(); store.set('one', 'Latest');
  expect(first).toHaveBeenCalledTimes(1);
  expect(readDrafts('scoped-drafts')).toEqual({ one: 'Latest' });
});

it('does not resurrect signed-out text or Ask drafts from a late completion', () => {
  const primary = new DraftStore('signed-out');
  const ask = new DraftStore('signed-out:ask');
  primary.set('one', 'Private draft'); ask.set('source', 'Private question');
  clearConversationRecovery('signed-out');
  primary.set('one', 'Late draft'); ask.set('source', 'Late question');
  expect(readDrafts('signed-out')).toEqual({});
  expect(readDrafts('signed-out:ask')).toEqual({});
  const fresh = new DraftStore('signed-out');
  fresh.set('one', 'New login');
  expect(readDrafts('signed-out')).toEqual({ one: 'New login' });
});

it('retries the current text after a failed save and a newer ordinary edit', async () => {
  const store = new DraftStore('retry-current-draft');
  const write = vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation(() => { throw new Error('Full'); });
  store.set('one', 'First');
  expect(store.flush()?.status).toBe('failed');
  await Promise.resolve();
  expect(store.hasSaveError('one')).toBe(true);
  expect(store.hasSaveError('other')).toBe(false);
  store.set('one', 'Latest');
  const latest = store.snapshot('one');
  expect(latest).toEqual({ text: 'Latest', revision: 2 });
  write.mockRestore();
  const result = store.flush();
  expect(result?.status).toBe('saved');
  await Promise.resolve();
  expect(readDrafts('retry-current-draft')).toEqual({ one: 'Latest' });
  expect(store.persistence()).toMatchObject({ revision: 2, savedRevision: 2, result });
  expect(store.hasSaveError('one')).toBe(false);
});

it('does not broadcast ordinary successful saves to persistence subscribers', async () => {
  const store = new DraftStore('quiet-save');
  const listener = vi.fn(); store.subscribePersistence(listener);
  store.set('one', 'First'); store.flush(); await Promise.resolve();
  expect(listener).not.toHaveBeenCalled();
  expect(store.persistence()).toMatchObject({ revision: 1, savedRevision: 1, result: { status: 'saved', retention: 'session' } });
});

it('does not publish a late completed save after signout', async () => {
  const store = new DraftStore('fenced-result');
  const listener = vi.fn(); store.subscribePersistence(listener);
  store.set('one', 'Private'); store.flush();
  clearConversationRecovery('fenced-result');
  await Promise.resolve();
  expect(store.persistence().savedRevision).toBe(0);
  expect(listener).not.toHaveBeenCalled();
  expect(store.flush()?.status).not.toBe('saved');
  expect(readDrafts('fenced-result')).toEqual({});
});

it('retains an earlier completed revision when a newer edit fails before its callback', async () => {
  const store = new DraftStore('delayed-success');
  store.set('one', 'Already saved'); store.flush();
  store.set('two', 'Not saved');
  vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation(() => { throw new Error('Full'); });
  store.flush();
  await Promise.resolve();
  expect(store.hasSaveError('one')).toBe(false);
  expect(store.hasSaveError('two')).toBe(true);
  expect(store.persistence()).toMatchObject({ revision: 2, savedRevision: 1, result: { status: 'failed' } });
});
