import { clearPersistedImageDrafts, configureImageDraftPersistence } from '@orchardworks/agent-remote-web/headless';

const preferenceKey = 'agent-remote:clear-cache-on-close';
const contentPrefixes = ['agent-remote:recovery:', 'agent-remote-forks:', 'agent-remote-ask:', 'agent-remote-opened:', 'agent-remote-tracking:', 'arc:prompt-edit'];
const isContentKey = (key: string) => contentPrefixes.some(prefix => key.startsWith(prefix)) || key === 'agent-remote-conversation-history';
let enabled = false;
let initialized = false;
let cleanup: Promise<void> = Promise.resolve();
export interface CacheProtection { enabled: boolean; clearing: boolean; failed: boolean }
let state: CacheProtection = { enabled: false, clearing: false, failed: false };
const listeners = new Set<() => void>();
function publish(next: CacheProtection): void { state = next; for (const listener of listeners) listener(); }
export function subscribeCacheProtection(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function cacheProtectionState(): CacheProtection { return state; }

/** Existing readers and delayed writers share the same page-local store in private mode. */
class ConversationStorage implements Storage {
  private readonly memory = new Map<string, string>();
  private readonly privateKeys = new Set<string>();
  constructor(private readonly disk: () => Storage) {}
  private keys(): string[] {
    if (clearCacheOnClose()) return [...this.memory.keys()];
    return [...new Set([...Object.keys(this.disk()).filter(isContentKey), ...this.privateKeys])];
  }
  get length(): number { return this.keys().length; }
  key(index: number): string | null { return this.keys()[index] ?? null; }
  getItem(key: string): string | null {
    if (clearCacheOnClose()) return this.memory.get(key) ?? null;
    const value = this.disk().getItem(key);
    if (value !== null) { this.memory.set(key, value); this.privateKeys.delete(key); return value; }
    if (this.privateKeys.has(key)) return this.memory.get(key) ?? null;
    this.memory.delete(key);
    return null;
  }
  setItem(key: string, value: string): void {
    if (clearCacheOnClose()) this.privateKeys.add(key);
    else { this.disk().setItem(key, value); this.privateKeys.delete(key); }
    this.memory.set(key, value);
  }
  removeItem(key: string): void { this.privateKeys.delete(key); this.memory.delete(key); this.disk().removeItem(key); }
  clear(): void { for (const key of this.keys()) this.removeItem(key); }
  protect(retain: boolean): void {
    if (retain) for (const key of this.memory.keys()) this.privateKeys.add(key);
    const storage = this.disk();
    for (const key of Object.keys(storage)) if (isContentKey(key)) {
      const value = storage.getItem(key);
      if (retain && value !== null) { this.memory.set(key, value); this.privateKeys.add(key); }
      storage.removeItem(key);
    }
  }
}
export const conversationLocalStorage = new ConversationStorage(() => localStorage);
export const conversationSessionStorage = new ConversationStorage(() => sessionStorage);

function clearDiskCopies(retain = true): Promise<void> {
  publish({ enabled, clearing: true, failed: false });
  let failed = false;
  for (const storage of [conversationLocalStorage, conversationSessionStorage]) {
    try { storage.protect(retain); } catch { failed = true; }
  }
  let deadline: ReturnType<typeof setTimeout>;
  const timeout = new Promise<void>((_, reject) => { deadline = setTimeout(() => reject(new Error('Chat cache cleanup timed out.')), 10_000); });
  const current = Promise.race([clearPersistedImageDrafts(), timeout]).catch(() => { failed = true; }).then(() => {
    clearTimeout(deadline);
    if (cleanup === current) publish({ enabled, clearing: false, failed });
  });
  cleanup = current;
  return current;
}

/** Recheck at every storage boundary, even before another tab's event is delivered. */
export function clearCacheOnClose(): boolean {
  let next = enabled;
  try { next = localStorage.getItem(preferenceKey) === 'true'; } catch { /* Retain this page's policy if storage becomes unavailable. */ }
  if (!initialized || next !== enabled) {
    const retain = initialized;
    initialized = true; enabled = next;
    if (enabled) void clearDiskCopies(retain);
    else publish({ enabled, clearing: false, failed: false });
  }
  return enabled;
}
export async function setClearCacheOnClose(next: boolean): Promise<void> {
  // Persist the policy before clearing data, so suspended tabs also block future writes.
  localStorage.setItem(preferenceKey, String(next));
  initialized = true; enabled = next;
  if (enabled) await clearDiskCopies();
  else publish({ enabled, clearing: false, failed: false });
}

configureImageDraftPersistence(() => !clearCacheOnClose());
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => { if (event.key === preferenceKey || event.key === null) clearCacheOnClose(); });
  window.addEventListener('pageshow', () => { clearCacheOnClose(); });
  clearCacheOnClose();
}
