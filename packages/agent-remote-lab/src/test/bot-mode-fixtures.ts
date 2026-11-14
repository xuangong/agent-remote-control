import 'fake-indexeddb/auto';
import { act, createElement, useContext, useState } from 'react';
import { vi } from 'vitest';
import { PROTOCOL_VERSION, applyGroupOperation, createWindowView, type WindowGroup, type SessionSuccessionReplay, type ProjectedTimelineEntry, type SessionTitleUpdate } from '@orchardworks/agent-remote-protocol';
import { SessionDraftStore, SessionReadStore, SessionStateStore, WindowWorkspaceClient, type RemoteTransportListener, type SessionDraftsFrame, type SessionReadsFrame, type SessionStatesFrame } from '@orchardworks/agent-remote-web';
import { App, type LabTransport } from '../App.js';
import { SessionDirectoryClient } from '../directory-client.js';
import * as workspaceHooks from '../hooks/useWindowWorkspace.js';
import * as successionHooks from '../hooks/useSessionSuccession.js';
import { replicaState } from './fixtures.js';
import { render, unmount } from './setup.js';
import { WorkspaceReady } from '../workspace-access.js';

export const botTarget = (id: string) => ({ hostId: 'local', providerId: 'recorded', nativeSessionId: id, title: id });
export function botGroup(id: string, section = true): WindowGroup {
  return { window: { schemaVersion: 3, id, revision: 0, title: id, selectedPrimaryViewId: `${id}2`, selectedViewId: `${id}2`,
    views: [createWindowView(`${id}1`, botTarget(`${id}1`), 'primary'), createWindowView(`${id}2`, botTarget(`${id}2`), 'primary')] },
    ...(section ? { bots: { rank: id.toLowerCase(), members: {} } } : {}) };
}
export function seedGroup(scope: string, group: WindowGroup) {
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${group.window.id}`, JSON.stringify(group));
}
export async function until(check: () => void) {
  await vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 3000, interval: 5 });
}
export function visibleButton(container: ParentNode, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(button =>
    (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label && !button.closest('[hidden]'))!;
}
export async function mountBotApp(scope: string, options: { hosted?: boolean; holdMessages?: boolean; timeline?: ProjectedTimelineEntry[]; holdInspect?: boolean; serverProviders?: boolean } = {}) {
  let workspace!: ReturnType<typeof workspaceHooks.useWindowWorkspace>;
  let succession!: ReturnType<typeof successionHooks.useSessionSuccession>;
  const useWorkspace = workspaceHooks.useWindowWorkspace, useSuccession = successionHooks.useSessionSuccession;
  const workspaceSpy = vi.spyOn(workspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWorkspace(...args); return workspace; });
  const successionSpy = vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = useSuccession(...args); return succession; });
  const hostedGroups = new Map<string, WindowGroup>();
  let releaseInspect!: () => void;
  const inspectGate = new Promise<void>(resolve => { releaseInspect = resolve; });
  for (let index = 0; index < localStorage.length; index++) { const key = localStorage.key(index)!; if (key.startsWith(`agent-remote:recovery:${scope}:shared-window:`)) { try { const group = JSON.parse(localStorage.getItem(key)!); if (group.window) hostedGroups.set(group.window.id, group); } catch {} } }
  if (options.hosted) {
    vi.spyOn(WindowWorkspaceClient.prototype, 'listGroups').mockImplementation(async () => [...hostedGroups.values()]);
    vi.spyOn(WindowWorkspaceClient.prototype, 'inspect').mockImplementation(async id => {
      // A held read keeps a cached Window provisional (a cold start) until the test releases it.
      if (options.holdInspect) await inspectGate;
      const group = hostedGroups.get(id); if (!group) throw new Error('Group unavailable'); return group;
    });
    vi.spyOn(WindowWorkspaceClient.prototype, 'changes').mockImplementation((_id, _revision, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }));
    vi.spyOn(WindowWorkspaceClient.prototype, 'mutate').mockImplementation(async (id, mutation) => { const group = applyGroupOperation(hostedGroups.get(id)!, mutation.operation); hostedGroups.set(id, group); return { ...group, result: { operationId: mutation.operationId, status: 'committed', revision: group.window.revision, committedAt: Date.now(), expiresAt: Date.now() + 86400000 } }; });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Fixture route unavailable.' }, { status: 404 })));
  }
  let replays: SessionSuccessionReplay[] = [];
  const acknowledgements: Array<() => void> = [];
  const activityListeners = new Map<string, RemoteTransportListener>();
  /** Each conversation's stream, by agent, as the Host would push to it. */
  const conversationListeners = new Map<string, Set<RemoteTransportListener>>();
  const titleListeners = new Set<(session: SessionTitleUpdate) => void>();
  // Shared session states and read positions, as the Relay pushes them on the states channel.
  const sharedStates = new SessionStateStore(), sharedReads = new SessionReadStore();
  const markedReads: Array<{ nativeSessionId: string; readAt: number }> = [];
  // Drafts shared across devices, as the Relay keeps them, and the ones this page saved.
  const sharedDrafts = new SessionDraftStore(), savedDrafts: Array<{ nativeSessionId: string; text: string }> = [];
  let draftRevision = 1000;
  const attachments: string[] = [], sendMessages: Array<{ agentId: string; text?: string }> = [];
  const snapshot = (agentId: string) => ({ ...replicaState.agent!, id: agentId, status: 'idle' as const,
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: agentId.slice(6), connection: { state: 'connected' as const } } });
  const timeline = (agentId: string, requestId = 'timeline'): Awaited<ReturnType<LabTransport['fetchTimeline']>> => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page' as const, payload: {
    requestId, agentId, epoch: `epoch-${agentId}`, direction: 'tail' as const, reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: options.timeline?.at(-1)?.seqEnd ?? 0, nextSeq: (options.timeline?.at(-1)?.seqEnd ?? 0) + 1 }, startCursor: null, endCursor: null, entries: options.timeline ?? [], hasOlder: false, hasNewer: false, error: null,
  } });
  const transport: LabTransport = {
    watchSessionStates: listener => sharedStates.subscribe(listener),
    watchSessionReads: listener => sharedReads.subscribe(listener),
    markSessionRead: (session, readAt) => { if (sharedReads.advance(session, readAt)) markedReads.push({ nativeSessionId: session.nativeSessionId, readAt }); },
    watchSessionDrafts: listener => sharedDrafts.subscribe(listener),
    saveSessionDraft: async (session, text) => {
      savedDrafts.push({ nativeSessionId: session.nativeSessionId, text });
      const draft = { hostId: session.hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId, text, revision: ++draftRevision };
      sharedDrafts.accept(draft);
      return draft;
    },
    listProviders: async () => options.hosted && !options.serverProviders ? [] : [{ providerId: 'recorded', displayName: 'Recorded Provider' }],
    createAgent: async () => { throw new Error('No session creation in this fixture.'); },
    resumeAgent: async () => { throw new Error('Use directory attachment.'); },
    fetchSnapshot: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot(agentId) }),
    fetchTimeline: async agentId => timeline(agentId),
    connect: (agentId: string, listener: RemoteTransportListener) => {
      queueMicrotask(() => listener.onOpen());
      return { close() { if (activityListeners.get(agentId) === listener) activityListeners.delete(agentId); }, send(message) {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
          if (message.observation === 'activity') { activityListeners.set(agentId, listener); listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId, status: 'idle' } }); return; }
          conversationListeners.set(agentId, (conversationListeners.get(agentId) ?? new Set()).add(listener));
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId, revision: 'control', access: 'control', available: false, token: 'token' } });
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshot(agentId) });
        } else if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
        else if (message.type === 'timeline_request') listener.onMessage(timeline(agentId, message.payload.requestId));
        else if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
        else if (message.type === 'send_message') {
          sendMessages.push({ agentId, text: 'text' in message.payload ? message.payload.text : undefined });
          const acknowledge = () => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged', payload: { agentId, requestId: message.payload.requestId, command: 'send_message' } });
          if (options.holdMessages) acknowledgements.push(acknowledge); else acknowledge();
        }
      } };
    }, onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    onSessionTitle: listener => { titleListeners.add(listener); return () => titleListeners.delete(listener); },
  };
  if (options.hosted) {
    transport.fetchSessionSuccessions = async () => ({ version: 1, successions: replays, nextCursor: null });
    transport.fetchSessionSuccessionCurrent = async roleId => { const latest = replays.find(item => item.projection.role.id === roleId)!; return { version: 1, role: latest.projection.role, locator: latest.to }; };
    transport.fetchSessionSuccessionOperation = async (_roleId, operationId) => replays.find(item => item.projection.receipt.operationId === operationId)!;
  }
  const directory = new SessionDirectoryClient(scope);
  vi.spyOn(directory, 'list').mockResolvedValue({ items: [{ ...botTarget('Other'), createdAt: '2026-11-08', updatedAt: '2026-11-08', state: 'idle' }], hasMore: false, revision: '1' });
  vi.spyOn(directory, 'workspaces').mockResolvedValue({ workspaces: [] });
  vi.spyOn(directory, 'attach').mockImplementation(async (_provider, nativeSessionId) => { attachments.push(nativeSessionId); return { agentId: `agent-${nativeSessionId}`, nativeSessionId }; });
  let setAccessReady!: (ready: boolean) => void, setScope!: (scope: string) => void;
  const hostService = { hosts: async () => ({ hosts: options.hosted ? [{ id: 'local', name: 'Test Host', online: true, access: 'owner' as const, providers: [{ providerId: 'recorded', displayName: 'Recorded Provider' }] }] : [] }), pair: async () => { throw new Error('No pairing.'); } };
  function Access() {
    const inheritedReady = useContext(WorkspaceReady);
    const [ready, setReady] = useState(true), [baseUrl, changeScope] = useState(scope); setAccessReady = setReady; setScope = changeScope;
    return createElement(WorkspaceReady.Provider, { value: inheritedReady && ready }, createElement(App, { baseUrl, directory, transport, userScoped: options.hosted, hostService }));
  }
  const container = await render(createElement(Access));
  return { container, workspace: () => workspace, succession: () => succession, sendMessages, attachments, transport, hostedGroups, setAccessReady: (ready: boolean) => setAccessReady(ready), setScope: (scope: string) => setScope(scope), setReplays(value: SessionSuccessionReplay[]) { replays = value; },
    activityListeners, releaseInspect: () => releaseInspect(),
    /** A conversation's agent status, as its Host pushes it. */
    emitStatus(agentId: string, status: 'running' | 'idle' | 'waiting') {
      const current = snapshot(agentId);
      for (const listener of conversationListeners.get(agentId) ?? []) listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_update',
        payload: { ...current, status, runtimeInfo: { ...current.runtimeInfo, status } } });
    },
    /** Session states (with reply facts) as the Relay shares them. */
    emitStates(frame: Omit<SessionStatesFrame, 'protocolVersion' | 'type'>) { sharedStates.apply({ protocolVersion: PROTOCOL_VERSION, type: 'session_states', ...frame }); },
    /** The account's read positions as the Relay shares them. */
    emitReads(frame: Omit<SessionReadsFrame, 'protocolVersion' | 'type'>) { sharedReads.apply({ protocolVersion: PROTOCOL_VERSION, type: 'session_reads', ...frame }); },
    markedReads,
    /** The account's drafts as the Relay shares them; revisions above 1000 are this page's saves. */
    emitDrafts(frame: Omit<SessionDraftsFrame, 'protocolVersion' | 'type'>) { sharedDrafts.apply({ protocolVersion: PROTOCOL_VERSION, type: 'session_drafts', ...frame }); },
    savedDrafts,
    releaseMessages() { for (const acknowledge of acknowledgements.splice(0)) acknowledge(); },
    /** A native title the Host reports for a session, as the Relay pushes it. */
    emitTitle(session: SessionTitleUpdate) { for (const listener of titleListeners) listener(session); },
    button: (label: string) => visibleButton(container, label),
    async switchMode(mode: 'window' | 'bot') {
      const label = mode === 'bot' ? 'Bot mode' : 'Window mode';
      if (!visibleButton(container, label)) await act(async () => visibleButton(container, 'View options').click());
      await act(async () => visibleButton(container, label).click());
    },
    async close() { await unmount(container); workspaceSpy.mockRestore(); successionSpy.mockRestore(); },
  };
}
