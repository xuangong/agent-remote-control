import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { afterEach } from 'vitest';

import { createJournalPublisher, type JournalPublisher } from '../journal-publisher.js';
import { recording, type RecordedProvider } from './recordings.js';
import { relayLoopback } from './journal-relay-loopback.js';
import { attachScripted, boundary, driver, ScriptedSession, virtualClock } from './journal-scripted-session.js';

export type Relay = ReturnType<typeof relayLoopback>;

/** A one-pixel PNG: the bytes behind every image a recording names. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');

const limits = { batchWindowMs: 5, backoffBaseMs: 5, backoffMaxMs: 20, responseTimeoutMs: 10_000 };

/**
 * A recorded session of one provider, through the Controller's publisher and the Relay's real journal service: what a Controller sends
 * when it opens the session again, and what the Relay keeps and reports. Registers its own clean-up with the calling test file.
 */
export function windowHarness(provider: RecordedProvider) {
  const clock = virtualClock();
  const { settle, until } = driver(clock);
  const closers: Array<() => void> = [];
  afterEach(() => { for (const close of closers.splice(0)) close(); });
  const SESSION = `${provider}:public`;

  const start = (relay: Relay): JournalPublisher => {
    const publisher = createJournalPublisher({ providers: () => [provider], scheduler: clock, now: clock.now, limits });
    closers.push(() => publisher.close());
    relay.connect(publisher);
    return publisher;
  };

  const liveOf = (observations: readonly ProviderObservation[]) => observations.filter(observation => observation.delivery === 'live');

  /** A native session of the Controller: its history, older pages and the live observations received since, under one manager. */
  async function follow(publisher: JournalPublisher, history: readonly ProviderObservation[], options: { live?: readonly ProviderObservation[]; older?: Array<{ observations: ProviderObservation[]; nextCursor?: string }> } = {}) {
    // The files the session's images name can be read, so each settles to a resource id that does not change from one reopen to the next, as in a real session.
    const images = Object.fromEntries([...history, ...(options.live ?? []), ...(options.older ?? []).flatMap(page => page.observations)].flatMap(observation => observation.resourceReferences ?? []).map(({ readLocator }) => [readLocator, PIXEL] as const));
    const session = new ScriptedSession(provider, 'public', [...history, boundary(options.older ? 'older-1' : undefined)], options.older, Object.keys(images).length > 0 ? images : undefined);
    // A Controller keeps its resource id key with its state, so a file a tool row names keeps its resource id across a reopen and a restart.
    const manager = await attachScripted(session, 'agent-1', { resourceIdKey: 'journal-window-harness' });
    closers.push(() => { void manager.close(); });
    for (const observation of options.live ?? []) session.push(observation);
    if ((options.live ?? []).length > 0) await settle(20);
    publisher.attach({ agentId: 'agent-1', providerId: provider, nativeSessionId: 'public', source: manager });
    return { session, manager };
  }

  const journalOf = async (relay: Relay) => (await relay.journal(SESSION))!;
  const keysOf = async (relay: Relay) => (await journalOf(relay)).state().items.map(value => value.itemKey);
  const openKeysOf = async (relay: Relay) => (await journalOf(relay)).state().items.filter(value => value.state === 'open').map(value => value.itemKey);
  const heads = (relay: Relay) => relay.fromPublisher.filter(message => message.type === 'journal_publish' && message.entries.some((entry: { op: string }) => entry.op === 'head')).length;
  const windows = (relay: Relay, from = 0) => relay.diagnosticDetails.filter(({ event }) => event === 'journal_window').slice(from).map(({ reason }) => reason);
  const itemWrites = (relay: Relay, from: number) => relay.writes.slice(from).filter(write => write.upsert.length > 0 || write.removed.length > 0 || write.replaced);

  async function settled(relay: Relay): Promise<void> {
    await until(async () => (await relay.journal(SESSION))?.head !== undefined, 'the head');
    await settle(30);
  }

  /** The session is released and opened again: a new manager reads the native history, and the connection comes back. */
  async function reopenFrom(relay: Relay, publisher: JournalPublisher, history: readonly ProviderObservation[], live: readonly ProviderObservation[] = []) {
    const before = heads(relay);
    publisher.available(undefined);
    const run = await follow(publisher, history, { live });
    relay.connect(publisher);
    await until(() => heads(relay) > before, 'the head of the reopened journal');
    await settle(30);
    return run;
  }

  /** The Controller restarts: a new publisher and a new manager read the same native history. */
  async function restart(relay: Relay, previous: JournalPublisher, history: readonly ProviderObservation[], options: Parameters<typeof follow>[2] = {}) {
    previous.close();
    const before = heads(relay);
    const publisher = start(relay);
    const run = await follow(publisher, history, options);
    await until(() => heads(relay) > before, 'the head after the restart');
    await settle(30);
    return { publisher, ...run };
  }

  /** Publishes a recorded live run to a Relay, and returns what the Relay holds. */
  async function published(name: string, relay: Relay = relayLoopback(clock)) {
    const run = recording(provider, name);
    const publisher = start(relay);
    await follow(publisher, [], { live: liveOf(run.live) });
    await settled(relay);
    return { run, relay, publisher };
  }

  return { clock, settle, until, SESSION, start, liveOf, follow, journalOf, keysOf, openKeysOf, heads, windows, itemWrites, settled, reopenFrom, restart, published, relay: (options?: Parameters<typeof relayLoopback>[1]) => relayLoopback(clock, options) };
}
