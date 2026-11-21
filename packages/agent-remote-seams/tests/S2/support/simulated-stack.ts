import type { AgentProviderBehaviour } from '@orchardworks/agent-provider-sdk';
import { createHostBroker } from '@orchardworks/agent-relay-core';
import { createAgentHost } from '@orchardworks/agent-remote-controller';
import { simulatedCli } from '@orchardworks/agent-remote-controller/testing/simulated-cli';
import { browserStream, connectToRelay } from '@orchardworks/agent-remote-fixtures';
import { MemoryJournalStore } from '@orchardworks/agent-remote-journal';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { createRemoteHostUplinkClient } from '@orchardworks/agent-session-runtime';
import { vi } from 'vitest';

export type Frame = Record<string, any>;
const ORIGIN = 'http://relay.test';

/** Fake timers and clock for everything below: the Relay, the uplink, the Controller's idle sweep and the simulator. */
export function fakeTime(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
}

/**
 * The Relay and the Controller joined in memory, with smart reading on: the Controller's provider is the CLI simulator playing a declared
 * behaviour, and a page reads a session the way the Workbench does, by attaching it and then opening its stream, which the Relay serves
 * from the session's journal. Nothing listens on a port and every timer is fake (`fakeTime`).
 */
export async function simulatedStack(behaviour: AgentProviderBehaviour, closers: Array<() => void | Promise<void>>, sessions: Record<string, string[]> = { 'thread-1': ['Hello', 'Hi'] }) {
  const cli = simulatedCli({ behaviour, sessions, turnMs: 1000 });
  const store = new MemoryJournalStore();
  const broker = createHostBroker({ origin: ORIGIN, journals: store });
  closers.push(() => broker.close());
  const { key } = await (await broker.handleRequest(new Request(`${ORIGIN}/v1/remote/pairings`, { method: 'POST', body: '{}' })))!.json() as { key: string };
  const connect = connectToRelay(broker, closers);
  const host = createAgentHost({ registrations: [cli.registration()], installationId: 'simulated-host', name: 'Host',
    uplink: { url: 'ws://relay.test/ws/remote-host', remoteKey: key }, uplinkClient: options => createRemoteHostUplinkClient({ ...options, connect }) });
  closers.push(() => host.close());
  const { hostId } = await host.ready;
  const request = (path: string, init?: RequestInit) => broker.handleRequest(new Request(`${ORIGIN}${path}`, { ...init, headers: { 'content-type': 'application/json', origin: ORIGIN } }));
  if ((await request(`/v1/remote/hosts/${hostId}/smart-reading`, { method: 'PUT', body: JSON.stringify({ providerId: 'simulated', enabled: true }) }))?.status !== 200) throw new Error('Smart reading did not turn on.');
  /** What a page's open asks first: the binding of the session, answered by the Relay through the Controller. */
  async function attach(nativeSessionId = 'thread-1'): Promise<{ status: number; body: Frame }> {
    const response = (await request(`/v1/remote/hosts/${hostId}/attach`, { method: 'POST', body: JSON.stringify({ providerId: 'simulated', nativeSessionId }) }))!;
    return { status: response.status, body: await response.json() as Frame };
  }
  /** Whether the Relay reads the session from its journal: it holds a head for it. */
  const journalServed = async (nativeSessionId = 'thread-1') => !!(await store.load(`${hostId}:simulated:${nativeSessionId}`))?.meta;
  /** A page's stream of the session: negotiated with item keys and subscribed, as the Workbench opens a conversation. */
  async function openPage(agentId: string) {
    const page = await browserStream(broker, `${ORIGIN}/v1/sessions/${encodeURIComponent(agentId)}/events`, closers);
    page.send({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate', itemKeys: true });
    page.send({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscription', payload: { requestId: 'subscription', agentIds: [agentId] } });
    const frames = page.messages as Frame[];
    return {
      frames,
      /** The texts of the rows the page received live. */
      liveTexts: () => frames.filter(frame => frame.type === 'agent_stream' && frame.payload.event?.type === 'timeline').map(frame => frame.payload.event.item.text as string),
      tail: () => page.send({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_request', payload: { requestId: `tail-${frames.length}`, agentId, direction: 'tail', limit: 100 } }),
      close: page.close,
    };
  }
  return { cli, broker, store, hostId, attach, journalServed, openPage };
}
