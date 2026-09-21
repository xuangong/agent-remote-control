import { readFile } from 'node:fs/promises';
import type { AgentProviderAdapter, AgentSession, ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import WebSocket from 'ws';
import { expect, vi } from 'vitest';

import {
  createAgentRemoteHttpServer,
  createAgentRemoteRelay,
  createAgentRemoteUplinkClient,
} from '../../../agent-remote-relay/src/index.js';
import {
  AgentReplica,
  HttpWebSocketTransport,
  RemoteSessionClient,
  type RemoteProtocolObservation,
  type RemoteSessionStatus,
  type WebSocketLike,
} from '../../../agent-remote-web/src/headless.js';
import { createRecordedLabProvider } from '../server/recorded.js';

export interface ConformanceManifest {
  baseUrl: string;
  uplinkUrl: string;
  agentId: string;
  sessionId: string;
  apiKey: string;
  ownerToken: string;
}

export async function createConformanceFixture(manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ConformanceManifest;
  const recorded = createRecordedLabProvider({ deferSteerObservation: true });
  let steerAcknowledgement: Promise<void> | undefined;
  let releaseSteerAcknowledgement: (() => void) | undefined;
  const provider = recordedDSHAdapter(recorded.provider, () => steerAcknowledgement ?? Promise.resolve());
  const relay = createAgentRemoteRelay({ providers: [provider] });
  const direct = createAgentRemoteHttpServer(relay, {
    websocketAuthorizer: {
      authenticate: () => ({ subject: 'recorded-owner' }),
      authorize: ({ agentId }) => agentId === manifest.agentId,
    },
  });
  const directAddress = await direct.listen(0, '127.0.0.1');
  const connectUplink = () => createAgentRemoteUplinkClient({
    relay, agentId: manifest.agentId, url: manifest.uplinkUrl, apiKey: manifest.apiKey,
    reconnectDelayMs: 25, registrationTimeoutMs: 5_000,
  });
  let uplink = connectUplink();
  const connections: ReturnType<typeof connectBrowser>[] = [];
  try {
    await uplink.ready;
  } catch (error) {
    await uplink.close();
    await direct.close();
    await relay.close();
    throw error;
  }
  const targetTransport = createTransport(manifest.baseUrl, manifest.ownerToken);
  const baselineTransport = createTransport(directAddress.url);

  return {
    manifest, relay, controller: recorded.controller, targetTransport, baselineTransport,
    holdSteerAcknowledgement() {
      steerAcknowledgement = new Promise<void>((resolve) => { releaseSteerAcknowledgement = resolve; });
      return () => {
        releaseSteerAcknowledgement?.();
        steerAcknowledgement = undefined;
      };
    },
    async createAgent() {
      return targetTransport.createAgent(manifest.agentId, 'dsh', { sessionId: manifest.sessionId });
    },
    connect(kind: 'baseline' | 'target', label: string = kind) {
      const browser = connectBrowser(
        kind === 'target' ? manifest.baseUrl : directAddress.url,
        manifest.agentId,
        kind === 'target' ? manifest.ownerToken : undefined,
        label,
      );
      connections.push(browser);
      return browser;
    },
    async compareSnapshot() {
      const [baseline, target] = await Promise.all([
        baselineTransport.fetchSnapshot(manifest.agentId),
        targetTransport.fetchSnapshot(manifest.agentId),
      ]);
      expect(target).toEqual(baseline);
      return target;
    },
    async comparePage(direction: 'tail' | 'before' | 'after', cursor?: TimelineCursor, limit = 3) {
      // Fresh transports keep the public request correlation identical.
      const baseline = createTransport(directAddress.url);
      const target = createTransport(manifest.baseUrl, manifest.ownerToken);
      const [baselinePage, targetPage] = await Promise.all([
        baseline.fetchTimeline(manifest.agentId, direction, cursor, limit),
        target.fetchTimeline(manifest.agentId, direction, cursor, limit),
      ]);
      expect(targetPage).toEqual(baselinePage);
      return targetPage;
    },
    async disconnectUplink() { await uplink.close(); },
    async reconnectUplink() {
      uplink = connectUplink();
      await uplink.ready;
    },
    async close() {
      releaseSteerAcknowledgement?.();
      for (const browser of connections) browser.client.stop();
      await uplink.close();
      await direct.close();
      await relay.close();
    },
  };
}

export type ConformanceFixture = Awaited<ReturnType<typeof createConformanceFixture>>;

function createTransport(baseUrl: string, ownerToken?: string) {
  return new HttpWebSocketTransport(baseUrl, {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (ownerToken) headers.set('Cookie', `borgee_token=${ownerToken}`);
      return fetch(input, { ...init, headers });
    },
    webSocketFactory: (url) => new WebSocket(url, {
      headers: ownerToken ? { Cookie: `borgee_token=${ownerToken}` } : {},
    }) as unknown as WebSocketLike,
  });
}

function connectBrowser(baseUrl: string, agentId: string, ownerToken: string | undefined, label: string) {
  const sockets: WebSocket[] = [];
  const observations: RemoteProtocolObservation[] = [];
  let status: RemoteSessionStatus = 'idle';
  let restart: (() => void) | undefined;
  let requestId = 0;
  const transport = createTransport(baseUrl, ownerToken);
  const socketTransport = new HttpWebSocketTransport(baseUrl, {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      if (ownerToken) headers.set('Cookie', `borgee_token=${ownerToken}`);
      return fetch(input, { ...init, headers });
    },
    webSocketFactory: (url) => {
      const socket = new WebSocket(url, { headers: ownerToken ? { Cookie: `borgee_token=${ownerToken}` } : {} });
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
  });
  socketTransport.onProtocolMessage((observation) => observations.push(observation));
  const replica = new AgentReplica();
  const client = new RemoteSessionClient(agentId, socketTransport, replica, {
    historyPageSize: 3,
    operationTimeoutMs: 5_000,
    requestId: () => `${label}-${++requestId}`,
    scheduleReconnect: (_delay, reconnect) => {
      restart = reconnect;
      return () => { restart = undefined; };
    },
  });
  client.subscribeStatus((next) => { status = next; });
  client.start();
  return {
    client, replica, transport, observations,
    ready: () => vi.waitFor(() => expect(status).toBe('ready'), { timeout: 5_000 }),
    disconnected: () => vi.waitFor(() => expect(status).toBe('disconnected'), { timeout: 5_000 }),
    disconnect() { sockets.at(-1)?.terminate(); },
    async reconnect() {
      await vi.waitFor(() => expect(restart).toBeTypeOf('function'), { timeout: 5_000 });
      restart!();
      await vi.waitFor(() => expect(status).toBe('ready'), { timeout: 5_000 });
    },
    async allHistory() {
      while (replica.getState().timeline.hasOlder) await client.loadOlder();
    },
  };
}

export type ConformanceBrowser = ReturnType<typeof connectBrowser>;

export function sharedEvents(browser: ConformanceBrowser, start = 0) {
  const sharedTypes = new Set([
    'agent_stream', 'agent_update', 'interaction_requested', 'interaction_resolved',
    'resource_update', 'timeline_resource_binding_replaced', 'timeline_replacement',
  ]);
  return browser.observations.slice(start)
    .filter((entry) => entry.direction === 'inbound' && entry.channel === 'websocket' && sharedTypes.has(entry.message.type))
    .map((entry) => entry.message);
}

export async function expectConverged(baseline: ConformanceBrowser, target: ConformanceBrowser) {
  await vi.waitFor(() => {
    expect(target.replica.getState().agent).toEqual(baseline.replica.getState().agent);
    expect(target.replica.getState().timeline).toEqual(baseline.replica.getState().timeline);
    expect(target.replica.getState().pendingInteractions).toEqual(baseline.replica.getState().pendingInteractions);
  }, { timeout: 5_000 });
}

function recordedDSHAdapter(adapter: AgentProviderAdapter, afterSteer: () => Promise<void>): AgentProviderAdapter {
  const wrap = (session: AgentSession): AgentSession => ({
    capabilities: session.capabilities,
    async *observe(): AsyncIterable<ProviderStreamItem> {
      for await (const item of session.observe()) {
        yield item.type === 'observation' ? { ...item, event: { ...item.event, provider: 'dsh' } } : item;
      }
    },
    sendMessage: (text) => session.sendMessage(text),
    respondToInteraction: (requestId, response) => session.respondToInteraction(requestId, response),
    async steer(text) {
      await session.steer!(text);
      await afterSteer();
    },
    cancel: () => session.cancel!(),
    readResource: (locator) => session.readResource!(locator),
    async runtimeInfo() {
      const info = await session.runtimeInfo();
      return {
        ...info, providerId: 'dsh',
        ...(info.persistence ? { persistence: { ...info.persistence, providerId: 'dsh' } } : {}),
      };
    },
    dispose: () => session.dispose(),
  });
  return {
    descriptor: { ...adapter.descriptor, providerId: 'dsh' },
    async createSession(config) { return wrap(await adapter.createSession(config)); },
    async resumeSession(handle) { return wrap(await adapter.resumeSession({ ...handle, providerId: 'recorded' })); },
  };
}
