import { watchPageResume } from '@orchardworks/agent-remote-web';
import { DirectoryError } from './directory-client.js';

/** Reattaching observes an existing session; it never replays user input. */
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
      if (retrying) retry = setTimeout(() => void run(), 5_000);
      else completed = true;
    } finally {
      if (pending === controller) { clearTimeout(deadline); pending = undefined; }
    }
  }
  const unwatch = watchPageResume(() => {
    if (!active()) return;
    pending?.abort(); pending = undefined;
    clearTimeout(deadline);
    void run();
  });
  void run();
  return () => {
    retired = true;
    pending?.abort();
    clearTimeout(deadline); clearTimeout(retry); unwatch();
  };
}
