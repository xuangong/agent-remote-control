import { afterEach, expect, it, vi } from 'vitest';
import { conversationLocalStorage, conversationSessionStorage, cacheProtectionState, clearCacheOnClose, setClearCacheOnClose } from './conversation-storage.js';
import { saveDrafts, readDrafts, clearConversationRecovery } from './conversation-recovery.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { ForkStore, referenceForkContext } from './session-forks.js';

afterEach(async () => { clearConversationRecovery(); await setClearCacheOnClose(false); localStorage.clear(); sessionStorage.clear(); });

it('defaults to recovery and removes durable content only after enabling protection', async () => {
  expect(clearCacheOnClose()).toBe(false);
  saveDrafts('relay', { agent: 'private draft' }); flushRecoveryWrites();
  expect(sessionStorage.getItem('agent-remote:recovery:relay:drafts')).toContain('private draft');
  localStorage.setItem('agent-remote:workspace-access', 'account');
  localStorage.setItem('unrelated', 'keep');
  conversationLocalStorage.setItem('agent-remote:recovery:relay:workspace', 'private history');
  await setClearCacheOnClose(true);
  expect(sessionStorage.getItem('agent-remote:recovery:relay:drafts')).toBeNull();
  expect(localStorage.getItem('agent-remote:recovery:relay:workspace')).toBeNull();
  expect(readDrafts('relay')).toEqual({ agent: 'private draft' });
  expect(localStorage.getItem('agent-remote:workspace-access')).toBe('account');
  expect(localStorage.getItem('unrelated')).toBe('keep');
});

it('keeps delayed writes and background flushes in memory while retaining active fork intents', async () => {
  const forks = new ForkStore('relay');
  const source = { hostId: 'host', providerId: 'codex', nativeSessionId: 'session', agentId: 'agent', title: 'Title', createdAt: 'now' };
  const record = forks.prepare(referenceForkContext(source), { sourceNativeSessionId: 'session' });
  saveDrafts('relay', { agent: 'queued before enabling' });
  await setClearCacheOnClose(true);
  window.dispatchEvent(new Event('pagehide'));
  expect(readDrafts('relay')).toEqual({ agent: 'queued before enabling' });
  expect(forks.get(record.id).source).toEqual(source);
  forks.bind(record.id, { ...source, nativeSessionId: 'fork' });
  expect(forks.get(record.id).target?.nativeSessionId).toBe('fork');
  expect(Object.keys(localStorage).filter(key => key.startsWith('agent-remote-forks:'))).toEqual([]);
  expect(sessionStorage.length).toBe(0);
  await setClearCacheOnClose(false);
  saveDrafts('relay', { agent: 'recoverable again' }); flushRecoveryWrites();
  expect(sessionStorage.getItem('agent-remote:recovery:relay:drafts')).toContain('recoverable again');
});

it('blocks a write when another tab enables protection before its storage event is delivered', async () => {
  conversationSessionStorage.setItem('agent-remote-ask:relay:inputs:session', 'question');
  localStorage.setItem('agent-remote:clear-cache-on-close', 'true');
  conversationLocalStorage.setItem('agent-remote:recovery:relay:outbox:session', 'message');
  expect(localStorage.getItem('agent-remote:recovery:relay:outbox:session')).toBeNull();
  expect(conversationLocalStorage.getItem('agent-remote:recovery:relay:outbox:session')).toBe('message');
  expect(sessionStorage.getItem('agent-remote-ask:relay:inputs:session')).toBeNull();
  clearConversationRecovery('relay');
  expect(conversationLocalStorage.getItem('agent-remote:recovery:relay:outbox:session')).toBeNull();
});

it('does not resurrect normally persisted data after it was removed by another tab', () => {
  conversationLocalStorage.setItem('agent-remote:recovery:relay:workspace', 'old content');
  localStorage.removeItem('agent-remote:recovery:relay:workspace');
  expect(conversationLocalStorage.getItem('agent-remote:recovery:relay:workspace')).toBeNull();
});

it('reports incomplete cleanup and lets a later attempt remove the remaining disk copies', async () => {
  localStorage.setItem('agent-remote:recovery:relay:workspace', 'old content');
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  try {
    await setClearCacheOnClose(true);
    expect(cacheProtectionState()).toEqual({ enabled: true, clearing: false, failed: true });
    conversationLocalStorage.setItem('agent-remote:recovery:relay:outbox:session', 'private message');
    expect(localStorage.getItem('agent-remote:recovery:relay:outbox:session')).toBeNull();
  } finally { remove.mockRestore(); }
  await setClearCacheOnClose(true);
  expect(localStorage.getItem('agent-remote:recovery:relay:workspace')).toBeNull();
  expect(cacheProtectionState()).toEqual({ enabled: true, clearing: false, failed: false });
});
