import { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalPublished } from '@orchardworks/agent-relay-core';
import { createJournalConnection, type JournalConnection } from '@orchardworks/agent-relay-core/journal-uplink';
import { MemoryJournalStore, SessionJournal, type JournalStore } from '@orchardworks/agent-remote-journal';
import type { JournalRelayMessage, RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

import type { JournalPublisher } from '../journal-publisher.js';
import type { VirtualClock } from './journal-scripted-session.js';

export const HOST_ID = 'host-1';

export interface RelayLoopbackOptions {
  /** The store a Relay that came back finds, so a reconnecting Controller meets the journal it left. */
  store?: MemoryJournalStore;
  /** The service's own limits, to make a quota refuse what a test publishes. */
  limits?: HostJournalsOptions['limits'];
  /** Makes the Relay refuse the open the publisher sends as its `n`th (1-based). */
  refuseOpen?(n: number): boolean;
  /**
   * Refuses one entry of a publication before the journal sees it, as a Relay that rejects an item for its own reasons
   * does: the entries before it are stored by the real journal, the refused one and those after it are not.
   */
  refuseEntry?(entry: { sequence: number; op: string }): { reason: 'invalid' | 'quota_exceeded' } | undefined;
}

/** The Relay's journal service and its per-connection adapter, wired to a publisher through asynchronous hand-offs. */
export function relayLoopback(clock: VirtualClock, options: RelayLoopbackOptions = {}) {
  const store = options.store ?? new MemoryJournalStore();
  /** What every write to the store carried, so a test can tell an item write from a write of the meta alone. */
  const writes: Array<{ upsert: string[]; removed: string[]; replaced: boolean }> = [];
  const counted: JournalStore = {
    load: key => store.load(key),
    apply: changes => { writes.push({ upsert: changes.upsert.map(item => item.itemKey), removed: changes.removed, replaced: changes.replaced }); return store.apply(changes); },
    delete: key => store.delete(key), catalog: store.catalog,
  };
  const real = createHostJournals({ store: counted, ...(options.limits === undefined ? {} : { limits: options.limits }) });
  let opens = 0;
  const journals: HostJournals = {
    ...real,
    open: (hostId, sessionKey, publisherId, openOptions) => options.refuseOpen?.(++opens) ? Promise.resolve({ refused: 'unavailable' as const }) : real.open(hostId, sessionKey, publisherId, openOptions),
    publish: async (hostId, sessionKey, generation, entries) => {
      let at = -1;
      let refusal: ReturnType<NonNullable<RelayLoopbackOptions['refuseEntry']>>;
      for (const [position, entry] of entries.entries()) {
        refusal = options.refuseEntry?.({ sequence: entry.sequence, op: entry.op });
        if (refusal) { at = position; break; }
      }
      if (at < 0 || !refusal) return real.publish(hostId, sessionKey, generation, entries);
      const stored = at > 0 ? await real.publish(hostId, sessionKey, generation, entries.slice(0, at)) : { events: [], watermark: 0 };
      return { ...stored, refusal: { sequence: entries[at]!.sequence, ...refusal } };
    },
  };
  const fromPublisher: Array<Record<string, any>> = [];
  const fromRelay: JournalRelayMessage[] = [];
  const published: Array<{ sessionKey: string; result: JournalPublished }> = [];
  /** What the Relay recorded about its journals, by name and with the metadata each one carried. */
  const diagnostics: string[] = [];
  const diagnosticDetails: Array<{ event: string; agentId?: string; reason?: string; bytes?: number }> = [];
  let publisher: JournalPublisher | undefined;
  let online = true;
  const connection: JournalConnection = createJournalConnection({
    hostId: HOST_ID, journals, current: () => online,
    scheduler: clock,
    send: (message: RemoteHostUplinkMessage) => {
      const relayMessage = message as JournalRelayMessage;
      fromRelay.push(relayMessage);
      queueMicrotask(() => publisher?.receive(relayMessage));
    },
    diagnostic: (event, details) => { diagnostics.push(event); diagnosticDetails.push({ event, ...details }); },
    published: (sessionKey, result) => { published.push({ sessionKey, result }); },
  });
  const writer = {
    send(json: string): void {
      const message = JSON.parse(json);
      fromPublisher.push(message);
      queueMicrotask(() => { void connection.receive(message).catch(() => undefined); });
    },
  };
  return {
    store, writes, diagnostics, diagnosticDetails, journals, connection, writer, fromPublisher, fromRelay, published,
    /** The publisher the Relay's messages go to. */
    connect(next: JournalPublisher): void { publisher = next; next.available(writer); },
    /** Ends the connection: the Relay forgets which sessions it opened, and the publisher is told. */
    disconnect(): void { online = false; connection.close(); publisher?.available(undefined); },
    /** Marks the stored journal of a session incomplete, as a quota refusal of a live row does while the Controller is away. */
    async makeIncomplete(sessionKey: string): Promise<void> {
      const state = await store.load(`${HOST_ID}:${sessionKey}`);
      const journal = new SessionJournal(state!);
      journal.markIncomplete();
      await store.apply(journal.takeChanges());
    },
    /** The journal the Relay holds for a session. */
    async journal(sessionKey: string): Promise<SessionJournal | undefined> {
      const state = await store.load(`${HOST_ID}:${sessionKey}`);
      return state ? new SessionJournal(state) : undefined;
    },
  };
}
