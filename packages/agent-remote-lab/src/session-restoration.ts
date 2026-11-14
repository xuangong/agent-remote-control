import { watchPageResume } from '@orchardworks/agent-remote-web';
import { DirectoryError } from './directory-client.js';

/** The first wait before trying a failed restoration again, and the longest; each failure doubles it. */
export const RESTORE_RETRY_MS = 5_000, RESTORE_RETRY_MAX_MS = 5 * 60_000;
/** The wait after `failures` failures in a row: shortened by up to a fifth at random, so pages that failed together spread out. */
export function restoreRetryDelay(failures: number): number {
  const delay = Math.min(RESTORE_RETRY_MAX_MS, RESTORE_RETRY_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(delay * (0.8 + 0.2 * Math.random()));
}

/**
 * Reattaching observes an existing session; it never replays user input. A Host that keeps failing is asked again less
 * and less often (see restoreRetryDelay); the page resuming or coming back online asks at once and starts over.
 */
export function restoreSession<T>(options: {
  active(): boolean;
  open(signal: AbortSignal): Promise<T>;
  restored(value: T): void;
  failed(error: unknown, retrying: boolean): void;
}): () => void {
  let retired = false;
  let completed = false;
  let pending: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const active = () => !retired && !completed && options.active();
  async function run(): Promise<void> {
    if (!active() || pending || document.visibilityState === 'hidden') return;
    clearTimeout(retry);
    const controller = new AbortController();
    pending = controller;
    deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await options.open(controller.signal);
      if (!active() || pending !== controller || controller.signal.aborted) return;
      completed = true;
      options.restored(result);
    } catch (error) {
      if (!active() || pending !== controller) return;
      if (controller.signal.aborted) error = new DirectoryError(
        'The browser stopped waiting for the session to open. The Host may still be opening it.', 'session_attach_wait_timeout', 408);
      const status = error instanceof DirectoryError ? error.status : undefined;
      const retrying = status === undefined || status >= 500 || status === 408 || status === 429;
      options.failed(error, retrying);
      if (retrying) retry = setTimeout(() => void run(), restoreRetryDelay(++failures));
      else completed = true;
    } finally {
      if (pending === controller) { clearTimeout(deadline); pending = undefined; }
    }
  }
  const unwatch = watchPageResume(() => {
    if (!active()) return;
    pending?.abort(); pending = undefined;
    clearTimeout(deadline);
    failures = 0;
    void run();
  });
  void run();
  return () => {
    retired = true;
    pending?.abort();
    clearTimeout(deadline); clearTimeout(retry); unwatch();
  };
}
