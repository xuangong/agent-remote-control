import { expect, it, vi } from 'vitest';
import { DraftStore } from './draft-store.js';
import { clearConversationRecovery, readDrafts } from './conversation-recovery.js';

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
