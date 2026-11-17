export interface RelayScheduler {
  /** Replace the scheduled refresh with the next epoch-millisecond deadline. */
  schedule(deadline: number, refresh: () => Promise<void>): void | Promise<void>;
  cancel(): void | Promise<void>;
}
export function createTimerRelayScheduler(): RelayScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule(deadline, refresh) {
      clearTimeout(timer);
      timer = setTimeout(() => { void refresh().catch(() => undefined); }, Math.max(1, deadline - Date.now()));
      (timer as unknown as { unref?(): void }).unref?.();
    },
    cancel() { clearTimeout(timer); timer = undefined; },
  };
}
