import { clearCacheOnClose, conversationLocalStorage, conversationSessionStorage } from './conversation-storage.js';

export type RecoveryWriteResult =
  | { status: 'saved'; ticket: number; retention: 'page' | 'session' | 'local' }
  | { status: 'failed'; ticket: number; error: unknown; sessionWritten: boolean; localWritten: boolean }
  | { status: 'cancelled' | 'superseded'; ticket: number };
export interface RecoveryWriteHandle {
  readonly ticket: number;
  readonly result: RecoveryWriteResult | undefined;
  /** Always resolves, including when a queued write is replaced or cancelled. */
  readonly completion: Promise<RecoveryWriteResult>;
}
export interface RecoveryWriteOptions { durable?: boolean; isCurrent?(): boolean }
interface PendingWrite {
  handle: RecoveryWriteHandle;
  settle(result: RecoveryWriteResult): void;
  serialize(): string;
  options: RecoveryWriteOptions;
  flushing: boolean;
}
const pending = new Map<string, PendingWrite>();
let timer: ReturnType<typeof setTimeout> | undefined;
let nextTicket = 0;

/** Persist the latest value at most once per burst, including before suspension. */
export function queueRecoveryWrite(key: string, serialize: () => string, options: boolean | RecoveryWriteOptions = false): RecoveryWriteHandle {
  const previous = pending.get(key);
  previous?.settle({ status: 'superseded', ticket: previous.handle.ticket });
  const ticket = ++nextTicket;
  let result: RecoveryWriteResult | undefined;
  let resolve!: (result: RecoveryWriteResult) => void;
  const completion = new Promise<RecoveryWriteResult>(done => { resolve = done; });
  const handle: RecoveryWriteHandle = { ticket, completion, get result() { return result; } };
  pending.set(key, { handle, serialize, options: typeof options === 'boolean' ? { durable: options } : options, flushing: false,
    settle(value) { if (result) return; result = value; resolve(value); } });
  schedule();
  return handle;
}

export function flushRecoveryWrites(prefix = ''): void {
  // New writes queued by a serializer belong to the next batch, unless explicitly flushed.
  for (const [key, entry] of [...pending]) {
    if (!key.startsWith(prefix) || entry.flushing || pending.get(key) !== entry) continue;
    entry.flushing = true;
    let sessionWritten = false, localWritten = false;
    const ticket = entry.handle.ticket;
    const current = () => {
      if (entry.handle.result || pending.get(key) !== entry) return false;
      if (entry.options.isCurrent && !entry.options.isCurrent()) {
        entry.settle({ status: 'cancelled', ticket });
        return false;
      }
      return true;
    };
    try {
      if (!current()) continue;
      const value = entry.serialize();
      let pageOnly = clearCacheOnClose();
      if (!current()) continue;
      conversationSessionStorage.setItem(key, value); sessionWritten = true;
      pageOnly = clearCacheOnClose() || pageOnly;
      if (!current()) continue;
      if (entry.options.durable) {
        conversationLocalStorage.setItem(key, value); localWritten = true;
        pageOnly = clearCacheOnClose() || pageOnly;
      }
      if (current()) entry.settle({ status: 'saved', ticket, retention: pageOnly ? 'page' : entry.options.durable ? 'local' : 'session' });
    } catch (error) {
      try {
        if (current()) entry.settle({ status: 'failed', ticket, error, sessionWritten, localWritten });
      } catch { entry.settle({ status: 'cancelled', ticket }); }
    } finally {
      entry.flushing = false;
      if (pending.get(key) === entry) pending.delete(key);
    }
  }
  releaseIfEmpty();
}

export function cancelRecoveryWrites(prefix: string): void {
  for (const [key, entry] of pending) if (key.startsWith(prefix)) {
    entry.settle({ status: 'cancelled', ticket: entry.handle.ticket });
    pending.delete(key);
  }
  releaseIfEmpty();
}

function schedule(): void {
  if (!pending.size || timer !== undefined) return;
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', onVisibility);
  timer = setTimeout(flushAll, 200);
}
function flushAll(): void { clearTimeout(timer); timer = undefined; flushRecoveryWrites(); schedule(); }
function onVisibility(): void { if (document.visibilityState === 'hidden') flushAll(); }
function releaseIfEmpty(): void {
  if (pending.size) return;
  clearTimeout(timer); timer = undefined;
  window.removeEventListener('pagehide', flushAll);
  document.removeEventListener('visibilitychange', onVisibility);
}
