import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { createJournalPublisher, type JournalPublisher } from '@orchardworks/agent-remote-controller/journal-publisher';
import { createHostJournals, type HostJournals, type HostJournalsOptions } from '@orchardworks/agent-relay-core';
import { createJournalConnection } from '@orchardworks/agent-relay-core/journal-uplink';
import { MemoryJournalStore, SessionJournal } from '@orchardworks/agent-remote-journal';
import type { JournalRelayMessage, RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';

import { attachScripted, historyBoundary, observationsOf, ScriptedSession } from './scripted-session.js';
import type { FrameRecorder } from './relay-harness.js';
import type { PlayerPeer } from './transcript.js';
import { driver, virtualClock } from './virtual-clock.js';

const HOST_ID = 'host-1';
const PROVIDER = 'codex';
const NATIVE_SESSION = 'public';
export const UPLINK_SESSION = `${PROVIDER}:${NATIVE_SESSION}`;

const limits = { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 10_000 };

export interface UplinkOptions {
  /** The service's own limits, to make a quota refuse what a scenario publishes. */
  limits?: HostJournalsOptions['limits'];
  /** Refuses one entry of a publication before the journal sees it, as a Relay that rejects an item for its own reasons does. */
  refuseEntry?(entry: { sequence: number; op: string }): { reason: 'invalid' | 'quota_exceeded' } | undefined;
}

/**
 * A Controller's journal publisher, fed by a scripted provider session, connected to the Relay's real journal service over
 * in-memory hand-offs and a virtual clock. Every frame in either direction goes to the recorder, so a scenario's transcript is
 * what the publisher and the Relay really said to each other.
 */
export function uplinkHarness(recorder: FrameRecorder, options: UplinkOptions = {}) {
  const clock = virtualClock();
  const { settle, until } = driver(clock);
  const store = new MemoryJournalStore();
  const closers: Array<() => void | Promise<void>> = [];
  const real = createHostJournals({ store, ...(options.limits === undefined ? {} : { limits: options.limits }) });
  const journals: HostJournals = {
    ...real,
    publish: async (hostId, sessionKey, generation, entries) => {
      let at = -1;
      let refusal: ReturnType<NonNullable<UplinkOptions['refuseEntry']>>;
      for (const [position, entry] of entries.entries()) {
        refusal = options.refuseEntry?.({ sequence: entry.sequence, op: entry.op });
        if (refusal) { at = position; break; }
      }
      if (at < 0 || !refusal) return real.publish(hostId, sessionKey, generation, entries);
      const stored = at > 0 ? await real.publish(hostId, sessionKey, generation, entries.slice(0, at)) : { events: [], watermark: 0 };
      return { ...stored, refusal: { sequence: entries[at]!.sequence, ...refusal } };
    },
  };
  let publisher: JournalPublisher | undefined;
  let online = true;
  const connection = createJournalConnection({
    hostId: HOST_ID, journals, current: () => online, scheduler: clock,
    send: (message: RemoteHostUplinkMessage) => {
      recorder.frame('relay->controller', JSON.stringify(message));
      queueMicrotask(() => publisher?.receive(message as JournalRelayMessage));
    },
    diagnostic: () => undefined,
    published: () => undefined,
  });
  const writer = {
    send(json: string): void {
      recorder.frame('controller->relay', json);
      queueMicrotask(() => { void connection.receive(JSON.parse(json)).catch(() => undefined); });
    },
  };

  const start = (): JournalPublisher => {
    const next = createJournalPublisher({ providers: () => [PROVIDER], publisherId: 'controller-1', scheduler: clock, now: clock.now, limits });
    closers.push(() => next.close());
    next.available(writer);
    publisher = next;
    return next;
  };

  /** The native session of the Controller: its history, then the live observations received since, under one manager. */
  async function follow(next: JournalPublisher, history: readonly ProviderObservation[], live: readonly ProviderObservation[] = []) {
    const session = new ScriptedSession(PROVIDER, NATIVE_SESSION, [...observationsOf(history, 'history'), historyBoundary()]);
    const manager = await attachScripted(session, 'agent-1');
    closers.push(() => { void manager.close(); });
    for (const observation of live) session.push(observation);
    if (live.length > 0) await settle(20);
    next.attach({ agentId: 'agent-1', providerId: PROVIDER, nativeSessionId: NATIVE_SESSION, source: manager });
    return { session, manager };
  }

  const journal = async (): Promise<SessionJournal | undefined> => {
    const state = await store.load(`${HOST_ID}:${UPLINK_SESSION}`);
    return state ? new SessionJournal(state) : undefined;
  };

  return {
    clock, settle, until, start, follow, journal,
    /** Waits until the Relay holds a head for the session: the publication of a window finished. */
    async settled(): Promise<void> {
      await until(async () => (await journal())?.head !== undefined, 'the head');
      await settle(30);
    },
    /** Ends the connection: the Relay forgets which sessions it opened, and the publisher is told. */
    disconnect(): void { online = false; connection.close(); publisher?.available(undefined); },
    /** The connection comes back to the same Relay. */
    reconnect(next: JournalPublisher): void { publisher = next; next.available(writer); },
    async dispose(): Promise<void> { for (const close of closers.splice(0).reverse()) await close(); },
  };
}
export type Uplink = ReturnType<typeof uplinkHarness>;

/** Builds timeline observations of one item; each call of the builder numbers its source keys from one, so a scenario is the same every run. */
export function observationBuilder() {
  let sequence = 0;
  return (delivery: 'history' | 'live', key: string, text: string, options: { completes?: boolean } = {}): ProviderObservation => {
    sequence += 1;
    const completes = options.completes ?? delivery === 'history';
    return {
      type: 'observation', sourceKey: `${delivery}:${key}:${sequence}`, occurredAt: 1_725_000_000_000 + sequence, delivery,
      event: { type: 'timeline', provider: PROVIDER, turnId: 'turn-1', item: { type: 'assistant_message', text, messageId: key } },
      itemIdentity: { key, ...(completes ? { completes: true as const } : {}) },
    };
  };
}

/**
 * The Relay's real journal service alone, for a player that stands in for the Controller: what it is sent goes to the service, and
 * what the service answers is what the player reads. Nothing here waits on the wall clock; it yields to the event loop between checks.
 */
export function journalServicePeer(options: UplinkOptions = {}) {
  const clock = virtualClock();
  const real = createHostJournals({ store: new MemoryJournalStore(), ...(options.limits === undefined ? {} : { limits: options.limits }) });
  const queue: unknown[] = [];
  const connection = createJournalConnection({
    hostId: HOST_ID, journals: real, current: () => true, scheduler: clock,
    send: (message: RemoteHostUplinkMessage) => { queue.push(message); },
    diagnostic: () => undefined, published: () => undefined,
  });
  const peer: PlayerPeer = {
    send: json => { void connection.receive(JSON.parse(json)).catch(() => undefined); },
    async next() {
      for (let turn = 0; turn < 5_000; turn += 1) {
        if (queue.length > 0) return queue.shift();
        await new Promise<void>(resolve => { setImmediate(resolve); });
      }
      throw new Error('The journal service sent nothing.');
    },
  };
  return { peer, close: () => connection.close() };
}
