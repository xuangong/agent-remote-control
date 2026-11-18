/**
 * Admission: whether the Controller still takes new work, as one small state.
 *
 * Contract.
 * - Three states. `open` takes everything. `draining` (the owner confirmed an update) refuses new mutations and registrations at once, so the
 *   shutdown and the launcher bound the cleanup time; reads still answer. `closed` refuses everything and never reopens.
 * - `beginDrain` succeeds only from `open`; `cancelDrain` returns a draining Controller to `open` and does nothing once closed.
 * - `close` always ends in `closed`, whatever the state before.
 * - `refuse(method)` names why a request is refused, or nothing: a closed Controller refuses every method (`host_closed`), a draining one
 *   refuses `POST` (`controller_updating`).
 *
 * Mutable state: the one phase. No clock, no ports.
 */
export type AdmissionPhase = 'open' | 'draining' | 'closed';

export type AdmissionRefusal = { code: 'host_closed'; message: string } | { code: 'controller_updating'; message: string };

export interface Admission {
  readonly phase: AdmissionPhase;
  /** True while draining or closed: nothing new starts. */
  readonly stopped: boolean;
  readonly closed: boolean;
  readonly draining: boolean;
  beginDrain(): boolean;
  cancelDrain(): void;
  close(): void;
  refuse(method: string): AdmissionRefusal | undefined;
}

export function createAdmission(): Admission {
  let phase: AdmissionPhase = 'open';
  return {
    get phase() { return phase; },
    get stopped() { return phase !== 'open'; },
    get closed() { return phase === 'closed'; },
    get draining() { return phase !== 'open'; },
    beginDrain() {
      if (phase !== 'open') return false;
      phase = 'draining';
      return true;
    },
    cancelDrain() { if (phase === 'draining') phase = 'open'; },
    close() { phase = 'closed'; },
    refuse(method) {
      if (phase === 'closed') return { code: 'host_closed', message: 'Agent Host is closed.' };
      if (phase === 'draining' && method === 'POST') return { code: 'controller_updating', message: 'Controller is updating. Reconnect before retrying.' };
      return undefined;
    },
  };
}
