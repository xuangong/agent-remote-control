import type { DiagnosticJournal } from './diagnostic-journal.js';
import type { BrokerState } from './broker-state.js';
import type { HostJournals } from './host-journals.js';
import type { BrokerScheduler } from './transport.js';

/**
 * Pending journal deletions. A revoke records a Host's id in the state; one sequential pass then clears the ids:
 * - a Host's id receives no journal while it is pending (`registered` grants none), so a deletion that returns has nothing
 *   left to delete for the entry it started under;
 * - each id has one call in flight, the store call and its confirming commit, shared by the pass and by a returning Host's
 *   wait; every caller races it against its own deadline, so a call that never answers is abandoned by each caller and is
 *   never followed by another store call for the same entry. The confirmation clears the entry only if the entry was
 *   created before the call started: a Host revoked again meanwhile stays pending and gets a call of its own after the
 *   first one ends. The journal service runs one Host's calls in order, so an abandoned call ends before any later one;
 * - a revoke or a registration while a pass runs is picked up by that pass, and an id the pass already tried is tried
 *   again when the pass ends if it was revoked meanwhile; a start, a registration and a revoke are the triggers.
 *
 * Owns: the pass, the calls in flight and the serials that order revokes. Reads and commits the pending list through
 * `BrokerState` (`journalDeletions`). Never rejects. Ports: the journal service (`deleteHost`), the scheduler (the deadline of a
 * wait), diagnostics.
 */
export interface JournalDeletion {
  /** A revoke put `hostId` into the pending list; `dropped` is an id the full list pushed out, which will not be deleted. Starts a pass. */
  revoked(hostId: string, dropped?: string): void;
  /** Starts a pass over the pending ids unless one is running. */
  drain(): void;
  /** Waits for the id's call for at most the deadline. Resolves false when the call failed or the deadline came first. */
  deleteOne(hostId: string): Promise<boolean>;
}

export interface JournalDeletionPorts {
  state: Pick<BrokerState, 'journalDeletions' | 'commit'>;
  journals: Pick<HostJournals, 'deleteHost'> | undefined;
  scheduler: BrokerScheduler;
  diagnostics: Pick<DiagnosticJournal, 'record'> | undefined;
  /** How long one wait for a call may take before the caller gives up on it. */
  timeoutMs: number;
}

export function createJournalDeletion({ state, journals, scheduler, diagnostics, timeoutMs }: JournalDeletionPorts): JournalDeletion {
  let draining = false;
  let rerun = false;
  /** Orders the revokes: the serial of the revoke that put an id into the pending list, and the serial a call started at. */
  let deletionSerial = 0;
  const pendingSerial = new Map<string, number>();
  const deletionCalls = new Map<string, { startedAt: number; run: Promise<boolean> }>();

  /** The call that deletes an id's journals and clears the entries up to its start. Resolves false on a failure and leaves the id pending. Never rejects. */
  function deletionCall(hostId: string): Promise<boolean> {
    const existing = deletionCalls.get(hostId);
    if (existing && (pendingSerial.get(hostId) ?? 0) <= existing.startedAt) return existing.run;
    const startedAt = deletionSerial;
    const run: Promise<boolean> = (async () => {
      await existing?.run;
      try { await journals!.deleteHost(hostId); }
      catch { diagnostics?.record(hostId, { event: 'journal_store_failed' }); return false; }
      try {
        await state.commit(draft => {
          const pending = draft.journalDeletions ?? [];
          if (!pending.includes(hostId) || (pendingSerial.get(hostId) ?? 0) > startedAt) return { value: undefined, unchanged: true, publish() {} };
          const rest = pending.filter(id => id !== hostId);
          if (rest.length > 0) draft.journalDeletions = rest; else delete draft.journalDeletions;
          return { value: undefined, publish() { state.journalDeletions = rest; pendingSerial.delete(hostId); } };
        });
      } catch { diagnostics?.record(hostId, { event: 'journal_store_failed' }); return false; }
      return true;
    })().finally(() => { if (deletionCalls.get(hostId)?.run === run) deletionCalls.delete(hostId); });
    deletionCalls.set(hostId, { startedAt, run });
    return run;
  }

  async function deleteOne(hostId: string): Promise<boolean> {
    if (!journals) return false;
    let timer: unknown;
    const deadline = new Promise<boolean>(resolve => { timer = scheduler.setTimeout(() => resolve(false), timeoutMs); });
    try {
      const done = await Promise.race([deletionCall(hostId), deadline]);
      if (!done) diagnostics?.record(hostId, { event: 'journal_store_failed' });
      return done;
    } finally { scheduler.clearTimeout(timer); }
  }

  function drain(): void {
    if (draining || !journals) return;
    draining = true;
    void (async () => {
      let tried = new Set<string>();
      for (;;) {
        const hostId = state.journalDeletions.find(id => !tried.has(id));
        if (hostId === undefined) {
          if (rerun) { rerun = false; tried = new Set(); continue; }
          draining = false;
          return;
        }
        tried.add(hostId);
        await deleteOne(hostId);
      }
    })();
  }

  return {
    revoked(hostId, dropped) {
      pendingSerial.set(hostId, ++deletionSerial);
      if (dropped !== undefined) { pendingSerial.delete(dropped); diagnostics?.record(hostId, { event: 'journal_deletion_dropped' }); }
      // An id that the running pass already tried is tried again when the pass ends.
      if (draining) rerun = true;
      drain();
    },
    drain,
    deleteOne,
  };
}
