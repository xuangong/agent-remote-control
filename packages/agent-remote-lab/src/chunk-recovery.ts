export type ChunkRecoveryOptions = {
  /** Delays before each retry of a failed import; the length is the number of retries. */
  retryDelaysMs?: readonly number[];
  wait?: (ms: number) => Promise<void>;
  /** Reloads the page: a fresh module map is the only way to refetch a chunk the browser remembers as failed. */
  reload?: () => void;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  guardKey?: string;
};

const defaultRetryDelaysMs = [500, 1500, 4000] as const;
const defaultGuardKey = 'agent-remote.chunk-reload';

const settle = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Loads a code-split chunk so that one failed fetch does not leave the page empty.
 * It retries with backoff; when every retry fails it reloads the page once (a marker in
 * session storage stops a reload loop) and leaves the load pending while the page reloads.
 * A successful load clears the marker, so a later failure can recover again.
 */
export async function loadChunkWithRecovery<T>(load: () => Promise<T>, options: ChunkRecoveryOptions = {}): Promise<T> {
  const delays = options.retryDelaysMs ?? defaultRetryDelaysMs;
  const wait = options.wait ?? settle;
  const storage = options.storage ?? sessionStorageOrUndefined();
  const guardKey = options.guardKey ?? defaultGuardKey;
  let failure: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await wait(delays[attempt - 1]!);
    try {
      const loaded = await load();
      storage?.removeItem(guardKey);
      return loaded;
    } catch (error) {
      failure = error;
    }
  }
  if (storage && !storage.getItem(guardKey)) {
    storage.setItem(guardKey, '1');
    (options.reload ?? (() => window.location.reload()))();
    return new Promise<T>(() => undefined);
  }
  throw failure;
}

function sessionStorageOrUndefined(): ChunkRecoveryOptions['storage'] {
  try { return window.sessionStorage; } catch { return undefined; }
}
