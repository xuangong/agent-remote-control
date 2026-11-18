import { createHostBroker } from '@orchardworks/agent-relay-core';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';
import { relayPlayer } from '@orchardworks/agent-session-runtime/testing';

import { collect, socketPair } from './relay-harness.js';
import { controllerAnswer, ORIGIN, outboxHostCall, PROVIDERS } from './scenarios/uplink-wire.js';
import { playRole, type Transcript } from './transcript.js';
import { driver, virtualClock } from './virtual-clock.js';

/**
 * The two players of the uplink wire transcripts (`register`, `heartbeat`, `rpc-attach`, `rpc-native-owner`, `outbox`).
 *
 * `playControllerAgainstRelay` plays the Controller's frames against the Relay's real host connection: what the Relay sends back must
 * be the transcript's Relay frames. `playRelayAgainstController` plays the Relay's frames against the Controller's real uplink
 * client: what the client sends must be the transcript's Controller frames. Each scenario names what it does at a step marker (a
 * clock advance, a call that makes a frame) in the tables below; every other frame is the other side's reaction.
 */
const usesOutbox = (transcript: Transcript) => transcript.header.scenario === 'outbox';

/** The Relay under test, joined to a transcript's Controller. Returns the number of Relay frames it matched. */
export async function playControllerAgainstRelay(transcript: Transcript): Promise<number> {
  const clock = virtualClock();
  const { settle } = driver(clock);
  const closers: Array<() => void | Promise<void>> = [];
  const broker = createHostBroker({ origin: ORIGIN, now: clock.now, scheduler: clock, rpcTimeoutMs: 1000, ...(usesOutbox(transcript) ? { outbox: { hostCall: outboxHostCall } } : {}) });
  closers.push(() => broker.close());
  try {
    const pairing = await broker.handleRequest(new Request(`${ORIGIN}/v1/remote/pairings`, { method: 'POST', body: '{}' }));
    const { key } = await pairing!.json() as { key: string };
    const prepared = await broker.prepareUpgrade(new Request(`${ORIGIN}/ws/remote-host?control=1${usesOutbox(transcript) ? '&outbox=1' : ''}`, { headers: { authorization: `Bearer ${key}` } }));
    if (!prepared || prepared instanceof Response) throw new Error('The Relay refused the Host upgrade.');
    const pair = socketPair(closers);
    const inbox = collect(pair.native);
    prepared.accept(pair.server);
    const hostId = () => broker.snapshot().hosts[0]!.id;
    const attach = (nativeSessionId: string) => void broker.handleRequest(new Request(`${ORIGIN}/v1/remote/hosts/${hostId()}/attach`, { method: 'POST', body: JSON.stringify({ providerId: 'codex', nativeSessionId }) }));
    const steps: Record<string, () => void | Promise<void>> = {
      'one heartbeat interval passes': async () => { clock.advance(30_000); await settle(20); },
      'a message waits': () => { broker.outboxReady(hostId()); },
      'attach accepted': () => attach('native-1'),
      'attach refused': () => attach('native-2'),
      'attach while a terminal owns the session': () => attach('owned'),
    };
    return await playRole(transcript, 'controller', { send: json => pair.native.send(json), next: () => inbox.take(() => true, 'the next frame from the Relay') }, async step => { await steps[step]?.(); });
  } finally { for (const close of closers.splice(0).reverse()) await close(); }
}

/** The Controller's real uplink client, joined to a transcript's Relay. Returns the number of Controller frames it matched. */
export async function playRelayAgainstController(transcript: Transcript): Promise<number> {
  const relay = relayPlayer('host-under-test', { autoRegister: false });
  const outbox = usesOutbox(transcript);
  const client = createRemoteHostUplinkClient({
    relay: createAgentRemoteRelay({ providers: [] }), installationId: 'controller-1', name: 'Controller', providers: PROVIDERS, remoteKey: 'arc_player',
    url: 'ws://relay.example/ws/remote-host', resolveSession: () => undefined, control: async request => controllerAnswer(request),
    ...(outbox ? { outbox: { onAvailable: () => undefined, onReady: () => undefined } } : {}),
    connect: (endpoint, init) => relay.accept(endpoint, init),
  });
  try {
    const steps: Record<string, () => void> = {
      'poll, claim and settle': () => { void (async () => {
        await client.outboxRequest({ action: 'poll' });
        await client.outboxRequest({ action: 'claim', id: transcriptEntry(transcript) });
        await client.outboxRequest({ action: 'settle', id: transcriptEntry(transcript), outcome: 'accepted' });
      })(); },
    };
    return await playRole(transcript, 'relay', relay.peer, step => { steps[step]?.(); });
  } finally { await client.close(); await relay.close(); }
}

/** The id the transcript's Relay answered a poll with, so the client claims what it was offered. */
function transcriptEntry(transcript: Transcript): string {
  for (const line of transcript.lines) {
    if (!('message' in line)) continue;
    const body = (line.message as { body?: { $json?: { entries?: Array<{ id: string }> } } }).body?.$json;
    const id = body?.entries?.[0]?.id;
    if (id) return id.replace(/^<uuid:(\d+)>$/, (_whole, number: string) => `00000000-0000-4000-8000-${number.padStart(12, '0')}`);
  }
  throw new Error('The transcript offers no outbox entry.');
}
