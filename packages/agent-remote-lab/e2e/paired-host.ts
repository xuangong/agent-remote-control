import type { APIRequestContext, TestInfo } from '@playwright/test';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';
import { createRecordedLabProvider } from '../src/server/recorded.js';

export interface PairedHost {
  hostId: string;
  name: string;
  /** The bodies of every `/remote/create` the Host received, in order. */
  creations: Record<string, unknown>[];
  close(): Promise<void>;
}

/**
 * Pairs a deterministic Host with the test Relay over the production uplink, as host-provider.spec.ts does.
 * Its recorded runtime creates, attaches and lists the sessions it made. Snapshot forks (`creationSource`) are
 * admitted like ordinary creations: the Lab's local directory rejects them since 71fcf583 ("Use a paired Host").
 */
export async function pairHost(request: APIRequestContext, testInfo: TestInfo): Promise<PairedHost> {
  const relayUrl = `http://127.0.0.1:${process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910}`;
  const invitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
  const relay = createAgentRemoteRelay({ providers: [createRecordedLabProvider().provider] });
  const name = `Paired Host ${testInfo.project.name} ${testInfo.testId.slice(0, 8)}`;
  const sessions = new Map<string, { agentId: string; title: string; createdAt: string }>();
  const creations: Record<string, unknown>[] = [];
  const agents = new Set<string>();
  const uplink = createRemoteHostUplinkClient({
    relay, url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key,
    installationId: `paired-${testInfo.project.name}-${testInfo.testId}`, name,
    providers: [{ providerId: 'recorded', displayName: 'Recorded' }],
    resolveSession: id => agents.has(id) ? relay.requireAgent(id) : undefined,
    async control(control) {
      const path = control.path.split('?')[0];
      if (path === '/remote/catalog/revision') return { status: 200, body: JSON.stringify({ revision: String(sessions.size) }) };
      if (path === '/remote/catalog') return { status: 200, body: JSON.stringify({ hasMore: false, revision: String(sessions.size),
        items: [...sessions].map(([nativeSessionId, session]) => ({ nativeSessionId, providerId: 'recorded', title: session.title,
          createdAt: session.createdAt, updatedAt: session.createdAt, state: 'idle' })) }) };
      if (path.startsWith('/remote/workspaces')) return { status: 200, body: JSON.stringify({ workspaces: [] }) };
      if (path === '/remote/attach') {
        const { nativeSessionId } = JSON.parse(control.body!);
        const session = sessions.get(nativeSessionId);
        return session ? { status: 200, body: JSON.stringify({ agentId: session.agentId, nativeSessionId }) } : { status: 404, body: '{}' };
      }
      if (path !== '/remote/create') return { status: 404, body: '{}' };
      const body = JSON.parse(control.body!);
      const existing = creations.findIndex(creation => creation.operationId === body.operationId);
      if (existing >= 0) {
        const nativeSessionId = `paired-native-${existing + 1}`;
        return { status: 200, body: JSON.stringify({ agentId: sessions.get(nativeSessionId)!.agentId, nativeSessionId }) };
      }
      creations.push(body);
      const nativeSessionId = `paired-native-${creations.length}`;
      await relay.createAgent({ protocolVersion: '1.8.0', type: 'create_agent', payload: {
        requestId: control.sessionId!, operationId: body.operationId, agentId: control.sessionId!, providerId: 'recorded',
        config: { sessionId: nativeSessionId, ...(body.cwd ? { cwd: body.cwd } : {}) },
      } });
      agents.add(control.sessionId!);
      sessions.set(nativeSessionId, { agentId: control.sessionId!, title: body.creationSource ? 'Fork of New session' : 'New session', createdAt: new Date().toISOString() });
      return { status: 200, body: JSON.stringify({ agentId: control.sessionId, nativeSessionId }) };
    },
  });
  const { hostId } = await uplink.ready;
  return { hostId, name, creations, async close() { await uplink.close(); await relay.close(); } };
}
