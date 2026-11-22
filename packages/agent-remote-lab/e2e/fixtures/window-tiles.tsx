/// <reference types="vite/client" />
// A Window of 1 to 4 tiles in the real Workbench (?tiles=N, default 3; ?bots=1 makes its group a group of bots), each tile a
// long conversation; ?docks=N docks 1 or 2 more sessions beside them, and ?working=tile-2,… names the sessions that are working.
// ?settings gives each session a model and an effort setting, and ?users=N makes every Nth row a message of the person's.
// The Window workspace answers from memory and the sessions from a recorded transport; no Relay runs.
import { createRoot } from 'react-dom/client';
import { applyGroupOperation, createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { WindowWorkspaceClient, type HttpWebSocketTransport, type RemoteAgentTransport, type RemoteTransportListener } from '@orchardworks/agent-client';
import { App } from '../../src/App.js';
import { SessionDirectoryClient } from '../../src/kernel/directory-client.js';
import { SessionStarsClient } from '../../src/features/sessions/session-stars-client.js';
import { replicaState } from '../../src/test/fixtures.js';
import { browserLocale } from '@orchardworks/agent-client-web/react';
import '../../src/session-view-styles.js';

const params = new URLSearchParams(location.search);
const count = Math.max(1, Math.min(4, Number(params.get('tiles') ?? 3)));
const baseUrl = location.origin + '/u/alice/';
// The sample data is in the reader's language: a Chinese fixture shows Chinese sample data, an English one English.
const zh = browserLocale() === 'zh';
const binding = (index: number) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: `tile-${index}`,
  title: zh ? `用 LOCAL 和 OK 回答，第 ${index} 块` : `Reply with the words LOCAL and OK, tile ${index}` });
const docks = Math.max(0, Math.min(2, Number(params.get('docks') ?? 0)));
const working = new Set((params.get('working') ?? '').split(',').filter(Boolean));
const statusOf = (nativeSessionId: string) => working.has(nativeSessionId) ? 'running' as const : 'idle' as const;
const settings = params.has('settings') ? [
  { id: 'model', category: 'model' as const, label: 'Model', value: 'recorded-large', mutable: true, scope: 'session' as const, options: [{ value: 'recorded-large', label: 'Recorded Large' }, { value: 'recorded-small', label: 'Recorded Small' }] },
  { id: 'effort', category: 'model' as const, label: 'Reasoning effort', value: 'medium', mutable: true, scope: 'session' as const, options: [{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }] },
] : undefined;
const userEvery = Math.max(0, Number(params.get('users') ?? 0));
const views = [...Array.from({ length: count }, (_, index) => createWindowView(`v${index + 1}`, binding(index + 1), 'primary')),
  ...Array.from({ length: docks }, (_, index) => createWindowView(`d${index + 1}`, binding(count + index + 1), 'dock'))];
let group: WindowGroup = { window: { schemaVersion: 3, id: 'tiles', revision: 1, title: zh ? '窗口' : 'Tiles', selectedPrimaryViewId: 'v1', selectedViewId: 'v1', views },
  ...(params.has('bots') ? { bots: { rank: 'm', members: {} } } : {}) };
localStorage.setItem(`agent-remote:recovery:${baseUrl}:shared-window:tiles`, JSON.stringify(group));
if (!params.has('window')) history.replaceState(null, '', `${location.pathname}${location.search ? `${location.search}&` : '?'}window=tiles`);

// The Window workspace, from memory.
WindowWorkspaceClient.prototype.listGroups = async () => [group];
WindowWorkspaceClient.prototype.inspect = async () => group as never;
WindowWorkspaceClient.prototype.changes = (_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
WindowWorkspaceClient.prototype.mutate = async (_id, mutation) => {
  group = applyGroupOperation(group, mutation.operation as never);
  return { ...group, result: { operationId: mutation.operationId, status: 'committed', revision: group.window.revision, committedAt: Date.now(), expiresAt: Date.now() + 86_400_000 } } as never;
};

// Every directory client of the page, the ones a Window makes per Host included.
SessionDirectoryClient.prototype.list = async () => ({ items: views.map(view => ({ ...view.binding!, state: statusOf(view.binding!.nativeSessionId), createdAt: '2026-11-20', updatedAt: '2026-11-20' })), hasMore: false, revision: '1' });
SessionDirectoryClient.prototype.workspaces = async () => ({ workspaces: [] });
SessionDirectoryClient.prototype.attach = async (_providerId, nativeSessionId) => ({ agentId: nativeSessionId, nativeSessionId });
// No favorites: without an answer the page would say the favorites failed, in a toast over the last tile's composer.
SessionStarsClient.prototype.snapshot = async () => ({ stars: [], folders: [], revision: 0 });
const directory = new SessionDirectoryClient(baseUrl, undefined, 'host');
const entries = (agentId: string) => Array.from({ length: 24 }, (_, index) => ({ providerId: 'recorded', seqStart: index + 1, seqEnd: index + 1, timestamp: '2026-11-20T05:20:00Z',
  sourceSeqRanges: [{ startSeq: index + 1, endSeq: index + 1 }], collapsed: [], resources: [],
  item: userEvery && (index + 1) % userEvery === 0
    ? { type: 'user_message' as const, messageId: `${agentId}-${index + 1}`, text: zh ? `${agentId} 的第 ${index + 1} 个问题` : `Question ${index + 1} of ${agentId}` }
    : { type: 'assistant_message' as const, messageId: `${agentId}-${index + 1}`, text: zh ? `${agentId} 的第 ${index + 1} 条。${'不能被遮住的对话文字。'.repeat(3)}` : `Item ${index + 1} of ${agentId}. ${'Readable conversation text that must stay uncovered. '.repeat(3)}` } }));
const snapshot = (agentId: string) => ({ ...replicaState.agent!, id: agentId, status: statusOf(agentId), runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId, status: statusOf(agentId), ...(settings ? { settings } : {}) } });
const transport: RemoteAgentTransport & Pick<HttpWebSocketTransport, 'listProviders' | 'createAgent' | 'resumeAgent'> = {
  listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
  createAgent: async () => { throw new Error('Creation is not used'); },
  resumeAgent: async () => { throw new Error('Resume is not used'); },
  fetchSnapshot: async agentId => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: snapshot(agentId) }),
  fetchTimeline: async agentId => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
    requestId: 'history', agentId, direction: 'tail', epoch: 'fixture', reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 24, nextSeq: 25 }, startCursor: { epoch: 'fixture', seq: 1 }, endCursor: { epoch: 'fixture', seq: 24 },
    hasOlder: false, hasNewer: false, error: null, entries: entries(agentId),
  } }),
  onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  connect(agentId, listener: RemoteTransportListener) {
    queueMicrotask(() => listener.onOpen());
    return { close: () => {}, send: message => {
      if (message.type === 'negotiate' && message.observation === 'activity') {
        listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.8.0', type: 'agent_activity', payload: { agentId, status: statusOf(agentId) } });
      } else if (message.type === 'negotiate') {
        listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated' });
        listener.onMessage({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: snapshot(agentId) });
      } else if (message.type === 'timeline_subscription') {
        listener.onMessage({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
      }
    } };
  },
};
const hostService = { hosts: async () => ({ hosts: [{ id: 'host', name: 'Work Mac', online: true, providers: [{ providerId: 'recorded', displayName: 'Recorded' }] }] }),
  pair: async () => { throw new Error('Pairing is not used'); } };
createRoot(document.getElementById('root')!).render(<App baseUrl={baseUrl} userScoped transport={transport} directory={directory} hostService={hostService}
  account={{ name: 'Alice Example', ready: true, openSecurity: () => {}, signOut: () => {} }} />);
