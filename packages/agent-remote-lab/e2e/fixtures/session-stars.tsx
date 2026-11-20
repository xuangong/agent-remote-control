/// <reference types="vite/client" />
import type { AccountFacts } from '../../src/account.js';
import { createRoot } from 'react-dom/client';
import { GatewayController } from '../../src/GatewayController.js';
import type { HttpWebSocketTransport, RemoteAgentTransport, RemoteTransportListener } from '@orchardworks/agent-client';
import type { AgentStatus } from '@orchardworks/agent-remote-protocol';
import { App } from '../../src/App.js';
import { SessionDirectoryClient } from '../../src/directory-client.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles.js';
import { trackFocusModality } from '../../src/focus-modality.js';
import { openInWindowMode } from './window-mode.js';

const stopTrackingFocus = trackFocusModality(document);
if (import.meta.hot) import.meta.hot.dispose(stopTrackingFocus);

const baseUrl = location.origin + '/u/alice/';
const directory = new SessionDirectoryClient(baseUrl, undefined, 'host');
// A long conversation, for layouts that must keep its text uncovered; its title is long too.
const longConversation = new URLSearchParams(location.search).has('long');
const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', title: longConversation ? 'Research notes on the reliability of Controller reconnection across networks' : 'Research notes', state: 'idle' as const, createdAt: '2026-09-19', updatedAt: '2026-09-19' };
const sidebarFixture = new URLSearchParams(location.search).has('sidebar');
const renameFixture = new URLSearchParams(location.search).get('rename');
directory.list = async () => ({ items: sidebarFixture ? Array.from({ length: 24 }, (_, index) => ({ ...session, nativeSessionId: `session-${index}`, title: `${['Review connection stability', 'Improve mobile session navigation', 'Investigate preview tunnel requests'][index % 3]} ${index + 1}` })) : [session], hasMore: false, revision: '1' });
directory.workspaces = async () => ({ workspaces: [] });
directory.attach = async () => ({ agentId: 'agent-1', nativeSessionId: session.nativeSessionId });
const observers = new Map<RemoteTransportListener, string>();
const catchUpFixture = new URLSearchParams(location.search).has('catchup');
const contentObservers = new Map<RemoteTransportListener, string>();
const allowContent = new URLSearchParams(location.search).has('switching');
// A current Controller negotiates session control and grants it; without it, an opened session is read only.
const controlFixture = new URLSearchParams(location.search).has('control');
if (allowContent) directory.attach = async (_providerId, nativeSessionId) => ({ agentId: nativeSessionId, nativeSessionId });
const transport: RemoteAgentTransport & Pick<HttpWebSocketTransport, 'listProviders' | 'createAgent' | 'resumeAgent'> = {
  listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
  createAgent: async () => { throw new Error('Creation is not used'); },
  resumeAgent: async () => { throw new Error('Resume is not used'); },
  fetchSnapshot: async agentId => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: allowContent
    ? { ...replicaState.agent!, id: agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId } }
    : replicaState.agent! }),
  fetchTimeline: async agentId => {
    if (!allowContent) throw new Error('Tracking must not request content');
    if (catchUpFixture) await new Promise<void>(resolve => window.addEventListener('fixture-history', () => resolve(), { once: true }));
    performance.mark('tracked-content-loaded');
    return { protocolVersion: '1.8.0', type: 'timeline_page', payload: {
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
        listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated', ...(controlFixture ? { sessionControl: true } : {}) });
        listener.onMessage({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
          ...replicaState.agent!, id: agentId, runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId },
        } });
        if (controlFixture) listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId, revision: 'control', access: 'control', available: false, token: 'token' } });
        return;
      }
      if (controlFixture && message.type === 'session_control_request') {
        listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
        return;
      }
      if (allowContent && message.type === 'timeline_subscription') {
        listener.onMessage({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
        return;
      }
      if (message.type !== 'negotiate' || message.observation !== 'activity') throw new Error('Tracking requested a content subscription');
      listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated' });
      listener.onMessage({ protocolVersion: '1.8.0', type: 'agent_activity', payload: { agentId, status: 'idle', ...(catchUpFixture ? { cursor: { epoch: 'fixture', seq: 3 } } : {}) } });
    } };
  },
};
window.addEventListener('fixture-activity', event => {
  const detail = (event as CustomEvent<AgentStatus | { agentId: string; status: AgentStatus }>).detail;
  for (const [listener, agentId] of observers) {
    if (typeof detail !== 'string' && detail.agentId !== agentId) continue;
    listener.onMessage({ protocolVersion: '1.8.0', type: 'agent_activity', payload: { agentId, status: typeof detail === 'string' ? detail : detail.status } });
  }
});
window.addEventListener('fixture-content', event => {
  const seq = (event as CustomEvent<number>).detail;
  for (const [listener, agentId] of contentObservers) listener.onMessage({ protocolVersion: '1.8.0', type: 'agent_stream', payload: {
    agentId, epoch: 'fixture', seq, timestamp: '2026-09-20T00:00:00Z',
    event: { type: 'timeline', providerId: 'recorded', resources: [], item: { type: 'assistant_message', text: `Caught-up content ${seq}` } },
  } });
});
localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ ...session, agentId: 'agent-1' }]));
const hostService = { ...(sidebarFixture ? { controllerRelease: async () => ({ release: null }) } : {}), hosts: async () => ({ hosts: [{ id: 'host', name: sidebarFixture ? 'zhangxians-Mac-mini.local · CLI' : 'Work Mac', online: renameFixture !== 'offline', ...(sidebarFixture ? { access: 'owner' as const, environment: { detectedAt: Date.now(), os: { platform: 'darwin', name: 'macOS', arch: 'arm64', release: '25.0' }, shell: { name: 'zsh', source: 'account' as const }, shells: [], browsers: ['Chrome', 'Edge', 'Safari'].map(name => ({ id: name.toLowerCase(), name, status: 'found' as const })), vscode: { status: 'found' as const }, wsl: false, container: false } } : {}), providers: [{ providerId: 'recorded', displayName: 'Recorded', ...(renameFixture && renameFixture !== 'unsupported' ? { sessionRename: true as const } : {}) }] }] }), pair: async () => { throw new Error('Pairing is not used'); } };
const requestedStatus = new URLSearchParams(location.search).get('status');
const status = requestedStatus === 'waiting' || requestedStatus === 'idle' ? requestedStatus : 'running';
const entries = longConversation ? Array.from({ length: 30 }, (_, index) => ({ providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-09-20T00:00:00Z',
  sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [],
  item: { type: 'assistant_message' as const, messageId: `message-${index + 1}`, text: `Item ${index + 1}. ${'Readable conversation text that must stay uncovered. '.repeat(4)}` } })) : [];
const aliceAccount: AccountFacts = { name: 'Alice Example', ready: true, openSecurity: () => {}, signOut: () => {} };
const app = (account?: AccountFacts) => <App baseUrl={baseUrl} userScoped transport={transport} directory={directory} hostService={hostService}
  initialState={{ ...replicaState, agent: { ...replicaState.agent!, status }, timeline: { ...replicaState.timeline, hasOlder: false, ...(longConversation ? { entries, nextSeq: entries.length + 1 } : {}) } }} initialSessionStatus="ready"
  {...(account ? { account } : {})} />;
openInWindowMode();
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).has('gateway')
  ? <GatewayController>{(_baseUrl, account) => app(account)}</GatewayController>
  : app(aliceAccount));
