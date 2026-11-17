/**
 * A clock a test moves by hand. It is the scheduler of the publisher and the journal service, so every timer fires when the clock
 * advances and nothing waits on the wall clock.
 */
export function virtualClock(start = 1_000_000) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: (): number => now,
    setTimeout(callback: () => void, delayMs: number): unknown {
      const id = ++nextId;
      timers.set(id, { at: now + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimeout(timer: unknown): void { timers.delete(timer as number); },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const entry of timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = target;
    },
    pending: (): number => timers.size,
  };
}

export type VirtualClock = ReturnType<typeof virtualClock>;

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** Lets work that runs on the event loop finish while the clock moves a step at a time; `until` polls a condition the same way. */
export function driver(clock: VirtualClock, stepMs = 5) {
  return {
    async settle(ms = 30): Promise<void> {
      for (let spent = 0; spent < ms; spent += stepMs) { for (let at = 0; at < 3; at += 1) await tick(); clock.advance(stepMs); }
      for (let at = 0; at < 3; at += 1) await tick();
    },
    async until(check: () => boolean | Promise<boolean>, label: string, virtualMs = 20_000): Promise<void> {
      for (let spent = 0; spent <= virtualMs; spent += stepMs) {
        if (await check()) return;
        await tick();
        clock.advance(stepMs);
      }
      throw new Error(`Timed out waiting for ${label}.`);
    },
  };
}
