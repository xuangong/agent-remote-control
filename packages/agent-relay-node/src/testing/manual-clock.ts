import { vi } from 'vitest';
import type { GatewayRelayOptions } from '../gateway-relay.js';

/**
 * The Relay's clock and its timers, advanced by the test instead of waited for.
 * `Date` is the clock every lease, grant and expiry check reads. Two ports wake the Relay: its scheduler (the next lease,
 * grant or challenge expiry) and each account Broker's timers (credential expiry, heartbeats, deadlines). `advance` moves
 * the clock and runs whatever falls due on the way, earliest first. Sockets stay real. Call `restore` when the test ends.
 */
/** Lets the real sockets carry what a wake-up started (a renewal, a close) before time moves on. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 20));

export function manualClock(start = Date.now()) {
  vi.useFakeTimers({ toFake: ['Date'], now: start });
  let wake: { deadline: number; refresh: () => Promise<void> } | undefined;
  const timers = new Map<object, { at: number; run: () => void }>();
  const scheduler: NonNullable<GatewayRelayOptions['scheduler']> = {
    schedule(deadline, refresh) { wake = { deadline, refresh }; },
    cancel() { wake = undefined; },
  };
  const brokerScheduler: NonNullable<GatewayRelayOptions['brokerScheduler']> = {
    setTimeout(run, delayMs) { const timer = {}; timers.set(timer, { at: Math.ceil(Date.now() + delayMs), run }); return timer; },
    clearTimeout(timer) { if (timer) timers.delete(timer as object); },
  };
  const next = () => {
    const earliest = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    return wake && (!earliest || wake.deadline <= earliest[1].at) ? { at: wake.deadline, fire: async () => { const due = wake!; wake = undefined; await due.refresh(); } }
      : earliest ? { at: earliest[1].at, fire: async () => { timers.delete(earliest[0]); earliest[1].run(); await Promise.resolve(); } } : undefined;
  };
  return {
    scheduler, brokerScheduler,
    /** Moves the clock forward and runs every wake-up that falls due on the way. */
    async advance(ms: number) {
      const end = Date.now() + ms;
      for (let step = next(), fired = 0; step && step.at <= end; step = next()) {
        if (++fired > 5000) throw new Error('The manual clock keeps waking: a timer reschedules itself without moving forward.');
        vi.setSystemTime(Math.max(Date.now(), step.at)); await step.fire(); await settle();
      }
      vi.setSystemTime(end);
      await settle();
    },
    restore: () => vi.useRealTimers(),
  };
}
