import { createHostJournals, type JournalPublished } from '@orchardworks/agent-remote-hosted';
import { createJournalConnection, type JournalConnection } from '@orchardworks/agent-remote-hosted/journal-uplink';
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import type { JournalRelayMessage, RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

import type { JournalPublisher } from '../journal-publisher.js';
import type { VirtualClock } from './journal-scripted-session.js';

export const HOST_ID = 'host-1';

/** The Relay's journal service and its per-connection adapter, wired to a publisher through asynchronous hand-offs. */
export function relayLoopback(clock: VirtualClock) {
  const store = new MemoryJournalStore();
  const journals = createHostJournals({ store, now: () => 1_000 });
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
