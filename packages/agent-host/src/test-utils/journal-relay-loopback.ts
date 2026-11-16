import { createHostJournals, type HostJournals, type HostJournalsOptions, type JournalPublished } from '@orchardworks/agent-remote-hosted';
import { createJournalConnection, type JournalConnection } from '@orchardworks/agent-remote-hosted/journal-uplink';
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import type { JournalRelayMessage, RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

import type { JournalPublisher } from '../journal-publisher.js';
import type { VirtualClock } from './journal-scripted-session.js';

export const HOST_ID = 'host-1';

export interface RelayLoopbackOptions {
  /** The store a Relay that came back finds, so a reconnecting Controller meets the journal it left. */
  store?: MemoryJournalStore;
  /** The service's own limits, to make a quota refuse what a test publishes. */
  limits?: HostJournalsOptions['limits'];
  /** The index size above which an open is refused as too large; the Relay's own is far above what a test builds. */
  maxIndexItems?: number;
  /**
   * Refuses one entry of a publication before the journal sees it, as a Relay that rejects an item for its own reasons
   * does: the entries before it are stored by the real journal, the refused one and those after it are not.
   */
  refuseEntry?(entry: { sequence: number; op: string; itemKey?: string }): { reason: 'body_missing' | 'invalid' | 'type_changed'; itemKey: string } | undefined;
}

/** The Relay's journal service and its per-connection adapter, wired to a publisher through asynchronous hand-offs. */
export function relayLoopback(clock: VirtualClock, options: RelayLoopbackOptions = {}) {
  const store = options.store ?? new MemoryJournalStore();
  const real = createHostJournals({ store, now: () => 1_000, ...(options.limits === undefined ? {} : { limits: options.limits }) });
  const journals: HostJournals = {
    ...real,
    open: (hostId, sessionKey, publisherId, openOptions) => real.open(hostId, sessionKey, publisherId, { ...openOptions, ...(options.maxIndexItems === undefined ? {} : { maxIndexItems: options.maxIndexItems }) }),
    publish: async (hostId, sessionKey, generation, entries) => {
      let at = -1;
      let refusal: ReturnType<NonNullable<RelayLoopbackOptions['refuseEntry']>>;
      for (const [position, entry] of entries.entries()) {
        refusal = options.refuseEntry?.({ sequence: entry.sequence, op: entry.op, ...('itemKey' in entry ? { itemKey: entry.itemKey } : 'row' in entry ? { itemKey: entry.row.itemKey } : {}) });
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
    store, journals, connection, writer, fromPublisher, fromRelay, published,
    /** The publisher the Relay's messages go to. */
    connect(next: JournalPublisher): void { publisher = next; next.available(writer); },
    /** Ends the connection: the Relay forgets which sessions it opened, and the publisher is told. */
    disconnect(): void { online = false; connection.close(); publisher?.available(undefined); },
    /** The journal the Relay holds for a session. */
    async journal(sessionKey: string): Promise<SessionJournal | undefined> {
      const state = await store.load(`${HOST_ID}:${sessionKey}`);
      return state ? new SessionJournal(state) : undefined;
    },
  };
}
