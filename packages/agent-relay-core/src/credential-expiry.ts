import type { BrokerScheduler, RelaySocket } from './transport.js';

/**
 * Closes a socket when the credential it connected with expires. Contract: `expire` watches one socket: `expiry` says when the
 * credential ends (undefined while it has no end to watch, 0 or a past time to close now); the socket is closed with `close`
 * (default code `code()`, 1008) at that time, checked again at least every minute so a shortened lifetime is noticed. It returns
 * the function that stops watching, which also runs when the socket closes. `enforce` checks every watched socket now, for a
 * revocation that should not wait for the next timer. Ports: the scheduler and the clock.
 */
export interface Expiry {
  expire(client: RelaySocket, expiry: () => number | undefined, code?: () => number, close?: (code: number) => void): () => void;
  enforce(): void;
}

export function createExpiry({ scheduler, now }: { scheduler: BrokerScheduler; now(): number }): Expiry {
  const setTimeout = scheduler.setTimeout.bind(scheduler);
  const clearTimeout = scheduler.clearTimeout.bind(scheduler);
  const expiryChecks = new Set<() => void>();
  function expire(client: RelaySocket, expiry: () => number | undefined, code: () => number = () => 1008, close = (code: number) => client.close(code, 'Credential expired')) {
    let timer: unknown;
    let active = true;
    const check = () => {
      if (!active) return;
      clearTimeout(timer);
      const expiresAt = expiry();
      if (expiresAt === undefined) return;
      if (expiresAt <= now()) { cleanup(); close(code()); return; }
      timer = setTimeout(check, Math.min(60_000, expiresAt - now()));
    };
    const cleanup = () => { active = false; clearTimeout(timer); expiryChecks.delete(check); };
    expiryChecks.add(check); client.onClose(cleanup); check();
    return cleanup;
  }
  return { expire, enforce() { for (const check of expiryChecks) check(); } };
}
