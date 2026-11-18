import { createHostBroker } from '@orchardworks/agent-relay-core';
import { createAgentRemoteRelay, createRemoteHostUplinkClient, type RemoteHostControlRequest, type RemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';

import { connectToRelay } from '@orchardworks/agent-session-runtime/testing';
import { TERMINAL_OWNER } from '../relay-harness.js';
import { driver, virtualClock } from '../virtual-clock.js';
import type { Scenario, ScenarioRecorder } from './scenario.js';

const CONSUMER = 'packages/agent-remote-seams/tests/S2/uplink-wire.integration.test.ts';
export const ORIGIN = 'https://relay.example';
export const OPERATION = '00000000-0000-4000-8000-0000000000a1';

type Answer = (request: RemoteHostControlRequest) => { status: number; body: string };

/** What the scenarios' Controller answers to an attach, by the native session it is asked for. */
export const controllerAnswer: Answer = request => {
  const { nativeSessionId } = JSON.parse(request.body ?? '{}') as { nativeSessionId?: string };
  if (nativeSessionId === 'native-1') return { status: 200, body: JSON.stringify({ agentId: 'agent-1', nativeSessionId }) };
  if (nativeSessionId === 'owned') return { status: 409, body: JSON.stringify({ code: 'native_session_owned', error: 'A terminal holds this session.', nativeOwner: TERMINAL_OWNER }) };
  return { status: 404, body: JSON.stringify({ code: 'native_session_unavailable', error: 'The Host could not find this session.' }) };
};
export const outboxHostCall = async (_hostId: string, call: unknown) => (call as { action: string }).action === 'poll'
  ? { entries: [{ id: OPERATION, providerId: 'codex', nativeSessionId: 'native-1', text: 'Run the suite.', createdAt: 1, status: 'waiting' }] } : { ok: true };
export const PROVIDERS = [{ providerId: 'codex', displayName: 'Codex' }];

/** The Controller's uplink client and the Relay's real host connection, joined in memory on a virtual clock; every frame goes to the recorder. */
async function uplinkWire(recorder: ScenarioRecorder, options: { outbox?: { hostCall(hostId: string, call: unknown): Promise<unknown> } } = {}) {
  const clock = virtualClock();
  const { settle } = driver(clock);
  const closers: Array<() => void | Promise<void>> = [];
  const broker = createHostBroker({ origin: ORIGIN, now: clock.now, scheduler: clock, rpcTimeoutMs: 1000, ...(options.outbox ? { outbox: options.outbox } : {}) });
  closers.push(() => broker.close());
  const pairing = await broker.handleRequest(new Request(`${ORIGIN}/v1/remote/pairings`, { method: 'POST', body: '{}' }));
  const key = ((await pairing!.json()) as { key: string }).key;
  let outboxAvailable = false, outboxReady = 0;
  const client: RemoteHostUplinkClient = createRemoteHostUplinkClient({
    relay: createAgentRemoteRelay({ providers: [] }), installationId: 'controller-1', name: 'Controller', providers: PROVIDERS,
    remoteKey: key, url: 'ws://relay.example/ws/remote-host', resolveSession: () => undefined, control: async request => controllerAnswer(request),
    ...(options.outbox ? { outbox: { onAvailable: available => { outboxAvailable = available; }, onReady: () => { outboxReady += 1; } } } : {}),
    connect: connectToRelay(broker, closers, recorder),
  });
  const { hostId } = await client.ready;
  return {
    broker, client, hostId, clock, settle,
    outbox: () => ({ available: outboxAvailable, ready: outboxReady }),
    attach: (body: unknown) => broker.handleRequest(new Request(`${ORIGIN}/v1/remote/hosts/${hostId}/attach`, { method: 'POST', body: JSON.stringify(body) })),
    async dispose() { await client.close(); for (const close of closers.splice(0).reverse()) await close(); },
  };
}

/** Runs the body against a fresh pair and always releases it. */
const withWire = (options: Parameters<typeof uplinkWire>[1], body: (wire: Awaited<ReturnType<typeof uplinkWire>>, recorder: ScenarioRecorder) => Promise<void>) =>
  async (recorder: ScenarioRecorder): Promise<void> => {
    const wire = await uplinkWire(recorder, options);
    try { await body(wire, recorder); } finally { await wire.dispose(); }
  };

export const uplinkWireScenarios: Scenario[] = [
  {
    seam: 'S2', name: 'register', consumers: [CONSUMER],
    description: 'A Controller connects with a pairing key and registers its providers; the Relay acknowledges with the Host id, its heartbeat deadlines, session control and a tunnel token.',
    run: withWire({}, async (_wire, recorder) => { recorder.step('connect and register'); }),
  },
  {
    seam: 'S2', name: 'heartbeat', consumers: [CONSUMER],
    description: 'A registered Host is sent a heartbeat once the Relay interval has passed, and the Controller acknowledges it with the same nonce.',
    run: withWire({}, async (wire, recorder) => {
      recorder.step('one heartbeat interval passes');
      wire.clock.advance(30_000);
      await wire.settle(20);
    }),
  },
  {
    seam: 'S2', name: 'rpc-attach', consumers: [CONSUMER],
    description: 'The Relay asks the Controller to attach a session and the Controller answers with the session; a second attach is refused and the answer carries the refusal.',
    run: withWire({}, async (wire, recorder) => {
      recorder.step('attach accepted');
      await wire.attach({ providerId: 'codex', nativeSessionId: 'native-1' });
      recorder.step('attach refused');
      await wire.attach({ providerId: 'codex', nativeSessionId: 'native-2' });
    }),
  },
  {
    seam: 'S2', name: 'rpc-native-owner', consumers: [CONSUMER],
    description: 'A terminal owns the session: the Controller refuses the attach with the native owner in its answer.',
    run: withWire({}, async (wire, recorder) => {
      recorder.step('attach while a terminal owns the session');
      await wire.attach({ providerId: 'codex', nativeSessionId: 'owned' });
    }),
  },
  {
    seam: 'S2', name: 'outbox', consumers: [CONSUMER],
    description: 'A Controller that asked for the outbox is told when a message waits, polls for it, claims it and settles it; the Relay answers each call.',
    run: withWire({ outbox: { hostCall: outboxHostCall } }, async (wire, recorder) => {
      recorder.step('a message waits');
      wire.broker.outboxReady(wire.hostId);
      await wire.settle(10);
      recorder.step('poll, claim and settle');
      await wire.client.outboxRequest({ action: 'poll' });
      await wire.client.outboxRequest({ action: 'claim', id: OPERATION });
      await wire.client.outboxRequest({ action: 'settle', id: OPERATION, outcome: 'accepted' });
    }),
  },
];
