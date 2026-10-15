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

it('keeps an unread text owner unknown and does not overwrite it with a new page edit', async () => {
  const scope = 'checked-denied';
  conversationSessionStorage.setItem(`agent-remote:recovery:${scope}:drafts`, JSON.stringify({ A: 'Retained A', B: 'Independent B' }));
  const denied = vi.spyOn(conversationSessionStorage, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  const store = new DraftStore(scope);
  expect(store.inspect('A').status).toBe('failed');
  store.set('A', 'New A');
  expect((await store.flushCurrent('A', store.snapshot('A').revision, () => true)).status).toBe('failed');
  denied.mockRestore();
  expect(store.retryRead()).toBe(true);
  expect(store.inspect('A').text).toBe('New A');
  expect(store.inspect('B').text).toBe('Independent B');
  expect((await store.flushCurrent('A', store.snapshot('A').revision, () => true)).status).toBe('saved');
});
it('does not certify a text edit after a newer edit or scope retirement', async () => {
  const store = new DraftStore('checked-current'); store.set('A', 'First');
  const revision = store.snapshot('A').revision;
  store.set('A', 'Second');
  expect((await store.flushCurrent('A', revision, () => true)).status).toBe('cancelled');
  expect((await store.flushCurrent('A', store.snapshot('A').revision, () => false)).status).toBe('cancelled');
});


it('returns its text application identity before a subscriber performs a same-content newer edit', () => {
  const store = new DraftStore('application-receipt');
  let appliedRevision: number | undefined;
  const unsubscribe = store.subscribe('one', () => {
    appliedRevision = store.snapshot('one').revision;
    unsubscribe();
    store.set('one', 'newer'); store.set('one', 'selected');
  });
  const applied = store.set('one', 'selected');
  expect(applied).toEqual({ text: 'selected', revision: appliedRevision });
  expect(store.snapshot('one').text).toBe('selected');
  expect(store.snapshot('one').revision).not.toBe(applied?.revision);
});
