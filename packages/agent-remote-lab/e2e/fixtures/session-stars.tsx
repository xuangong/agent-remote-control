import { createRoot } from 'react-dom/client';
import type { HttpWebSocketTransport, RemoteAgentTransport, RemoteTransportListener } from '@agent-remote-controller/agent-remote-web';
import type { AgentStatus } from '@agent-remote-controller/agent-remote-protocol';
import { App } from '../../src/App.js';
import { SessionDirectoryClient } from '../../src/directory-client.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@agent-remote-controller/agent-remote-web/styles.css';

const baseUrl = location.origin + '/u/alice/';
const directory = new SessionDirectoryClient(baseUrl, undefined, 'host');
const session = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'recorded-session', title: 'Research notes', state: 'idle' as const, createdAt: '2026-09-19', updatedAt: '2026-09-19' };
directory.list = async () => ({ items: [session], hasMore: false, revision: '1' });
directory.workspaces = async () => ({ workspaces: [] });
directory.attach = async () => ({ agentId: 'agent-1', nativeSessionId: session.nativeSessionId });
const observers = new Set<RemoteTransportListener>();
const transport: RemoteAgentTransport & Pick<HttpWebSocketTransport, 'listProviders' | 'createAgent' | 'resumeAgent'> = {
  listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
  createAgent: async () => { throw new Error('Creation is not used'); },
  resumeAgent: async () => { throw new Error('Resume is not used'); },
  fetchSnapshot: async () => ({ protocolVersion: '1.4.0', type: 'agent_snapshot', payload: replicaState.agent! }),
  fetchTimeline: async () => { throw new Error('Tracking must not request content'); },
  onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect(agentId, listener) {
    observers.add(listener); queueMicrotask(() => listener.onOpen());
    return { close: () => { observers.delete(listener); }, send: message => {
      if (message.type !== 'negotiate' || message.observation !== 'activity') throw new Error('Tracking requested a content subscription');
      listener.onMessage({ protocolVersion: '1.4.0', type: 'negotiated' });
      listener.onMessage({ protocolVersion: '1.4.0', type: 'agent_activity', payload: { agentId, status: 'idle' } });
    } };
  },
};
window.addEventListener('fixture-activity', event => {
  for (const listener of observers) listener.onMessage({ protocolVersion: '1.4.0', type: 'agent_activity', payload: { agentId: 'agent-1', status: (event as CustomEvent<AgentStatus>).detail } });
});
localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([{ ...session, agentId: 'agent-1' }]));
const hostService = { hosts: async () => ({ hosts: [{ id: 'host', name: 'Work Mac', online: true, providers: [{ providerId: 'recorded', displayName: 'Recorded' }] }] }), pair: async () => { throw new Error('Pairing is not used'); } };
createRoot(document.getElementById('root')!).render(<App baseUrl={baseUrl} userScoped transport={transport} directory={directory} hostService={hostService}
  initialState={{ ...replicaState, agent: { ...replicaState.agent!, status: 'running' }, timeline: { ...replicaState.timeline, hasOlder: false } }} initialSessionStatus="ready"
  accountAction={<><span className="gateway-account-identity">Alice Example</span><button>Security</button><button>Sign out</button></>} />);
