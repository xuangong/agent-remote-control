import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { GatewayController } from '../../src/GatewayController.js';
import type { HttpWebSocketTransport, RemoteAgentTransport, RemoteTransportListener } from '@orchardworks/agent-remote-web';
import type { AgentStatus } from '@orchardworks/agent-remote-protocol';
import { App } from '../../src/App.js';
import { SessionDirectoryClient } from '../../src/directory-client.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

const baseUrl = location.origin + '/u/alice/';
const directory = new SessionDirectoryClient(baseUrl, undefined, 'host');
const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', title: 'Research notes', state: 'idle' as const, createdAt: '2026-09-19', updatedAt: '2026-09-19' };
const sidebarFixture = new URLSearchParams(location.search).has('sidebar');
directory.list = async () => ({ items: sidebarFixture ? Array.from({ length: 24 }, (_, index) => ({ ...session, nativeSessionId: `session-${index}`, title: `${['Review connection stability', 'Improve mobile session navigation', 'Investigate preview tunnel requests'][index % 3]} ${index + 1}` })) : [session], hasMore: false, revision: '1' });
directory.workspaces = async () => ({ workspaces: [] });
directory.attach = async () => ({ agentId: 'agent-1', nativeSessionId: session.nativeSessionId });
const observers = new Map<RemoteTransportListener, string>();
const catchUpFixture = new URLSearchParams(location.search).has('catchup');
const contentObservers = new Map<RemoteTransportListener, string>();
const allowContent = new URLSearchParams(location.search).has('switching');
const transport: RemoteAgentTransport & Pick<HttpWebSocketTransport, 'listProviders' | 'createAgent' | 'resumeAgent'> = {
  listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
  createAgent: async () => { throw new Error('Creation is not used'); },
  resumeAgent: async () => { throw new Error('Resume is not used'); },
  fetchSnapshot: async () => ({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: replicaState.agent! }),
  fetchTimeline: async agentId => {
    if (!allowContent) throw new Error('Tracking must not request content');
    if (catchUpFixture) await new Promise<void>(resolve => window.addEventListener('fixture-history', () => resolve(), { once: true }));
    performance.mark('tracked-content-loaded');
    return { protocolVersion: '1.5.0', type: 'timeline_page', payload: {
      requestId: 'history', agentId, direction: 'tail', epoch: 'fixture', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: { epoch: 'fixture', seq: 1 }, endCursor: { epoch: 'fixture', seq: 1 },
      hasOlder: false, hasNewer: false, error: null,
      entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-20T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
        item: { type: 'assistant_message', text: `Conversation for ${agentId}` } }],
    } };
  },
  onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect(agentId, listener) {
    observers.set(listener, agentId); queueMicrotask(() => listener.onOpen());
    return { close: () => { observers.delete(listener); contentObservers.delete(listener); }, send: message => {
      if (allowContent && message.type === 'negotiate' && message.observation !== 'activity') {
        observers.delete(listener);
        contentObservers.set(listener, agentId);
        listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_snapshot', payload: {
          ...replicaState.agent!, id: agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId },
        } });
        return;
      }
      if (allowContent && message.type === 'timeline_subscription') {
        listener.onMessage({ protocolVersion: '1.5.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
        return;
      }
      if (message.type !== 'negotiate' || message.observation !== 'activity') throw new Error('Tracking requested a content subscription');
      listener.onMessage({ protocolVersion: '1.5.0', type: 'negotiated' });
      listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId, status: 'idle', ...(catchUpFixture ? { cursor: { epoch: 'fixture', seq: 3 } } : {}) } });
    } };
  },
};
window.addEventListener('fixture-activity', event => {
  const detail = (event as CustomEvent<AgentStatus | { agentId: string; status: AgentStatus }>).detail;
  for (const [listener, agentId] of observers) {
    if (typeof detail !== 'string' && detail.agentId !== agentId) continue;
    listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId, status: typeof detail === 'string' ? detail : detail.status } });
  }
});
window.addEventListener('fixture-content', event => {
  const seq = (event as CustomEvent<number>).detail;
  for (const [listener, agentId] of contentObservers) listener.onMessage({ protocolVersion: '1.5.0', type: 'agent_stream', payload: {
    agentId, epoch: 'fixture', seq, timestamp: '2026-09-20T00:00:00Z',
    event: { type: 'timeline', providerId: 'recorded', resources: [], item: { type: 'assistant_message', text: `Caught-up content ${seq}` } },
  } });
});
localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ ...session, agentId: 'agent-1' }]));
const hostService = { hosts: async () => ({ hosts: [{ id: 'host', name: sidebarFixture ? 'zhangxians-Mac-mini.local · CLI' : 'Work Mac', online: true, ...(sidebarFixture ? { access: 'owner' as const, environment: { detectedAt: Date.now(), os: { platform: 'darwin', name: 'macOS', arch: 'arm64', release: '25.0' }, shell: { name: 'zsh', source: 'account' as const }, shells: [], browsers: [{ id: 'chrome', name: 'Chrome', status: 'found' as const }], vscode: { status: 'found' as const }, wsl: false, container: false } } : {}), providers: [{ providerId: 'recorded', displayName: 'Recorded' }] }] }), pair: async () => { throw new Error('Pairing is not used'); } };
const requestedStatus = new URLSearchParams(location.search).get('status');
const status = requestedStatus === 'waiting' || requestedStatus === 'idle' ? requestedStatus : 'running';
const app = (accountAction: ReactNode) => <App baseUrl={baseUrl} userScoped transport={transport} directory={directory} hostService={hostService}
  initialState={{ ...replicaState, agent: { ...replicaState.agent!, status }, timeline: { ...replicaState.timeline, hasOlder: false } }} initialSessionStatus="ready"
  accountAction={accountAction} />;
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('gateway')
  ? <GatewayController>{(_baseUrl, accountAction) => app(accountAction)}</GatewayController>
  : app(<><span className="gateway-account-identity">Alice Example</span><button>Security</button><button>Sign out</button></>));
