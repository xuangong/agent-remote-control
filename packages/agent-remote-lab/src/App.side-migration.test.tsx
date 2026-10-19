import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@orchardworks/agent-remote-protocol';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient, type OpenedSession } from './directory-client.js';
import { ForkStore, referenceForkContext } from './session-forks.js';
import { replicaState } from './test/fixtures.js';
import { render, unmount } from './test/setup.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
async function waitFor(assertion: () => void): Promise<void> {
  const deadline = performance.now() + 5000;
  for (;;) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    try { assertion(); return; } catch (error) { if (performance.now() >= deadline) throw error; }
  }
}

it.each([false, true])('follows an edited Side without retargeting its original delivery (local: %s)', async localDelivery => {
  const baseUrl = 'http://localhost/u/side-edit-follow/';
  const original: OpenedSession = { hostId: 'host', providerId: 'pA', nativeSessionId: 'A', agentId: 'A-agent', title: 'Fixed A' };
  let current: OpenedSession = localDelivery ? original : { ...original, nativeSessionId: 'B', agentId: 'B-agent', title: 'Current B' };
  const advanced: OpenedSession = { ...original, nativeSessionId: 'C', agentId: 'C-agent', title: 'Current C' };
  const edited: OpenedSession = { ...original, nativeSessionId: 'Y', agentId: 'Y-agent', title: 'Edited Side' };
  const secondEdit: OpenedSession = { ...edited, nativeSessionId: 'Z', agentId: 'Z-agent', title: 'Second edited Side' };
  const side: OpenedSession = { ...original, nativeSessionId: 'S', agentId: 'S-agent', title: 'Pending Side' };
  const origin = { controllerId: 'controller', providerId: 'pA', nativeSessionId: 'A' };
  localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([current]));
  window.history.replaceState(null, '', `/?host=host&provider=pA&session=${current.nativeSessionId}&agent=${current.agentId}`);
  const local = new ForkStore(baseUrl);
  const localRecord = localDelivery ? local.prepare(referenceForkContext(original), { sourceNativeSessionId: 'A', creationSource: { providerId: 'pA', nativeSessionId: 'A' }, cwd: '/original', model: 'original-model' }, [{ id: 'model', value: 'original-model' }]) : undefined;
  if (localRecord) {
    local.bind(localRecord.id, side); local.markConfigured(localRecord.id);
    await expect(local.send(localRecord.id, 'unknown X input', async () => { throw new Error('lost'); }, async () => false)).rejects.toThrow('lost');
  }
  const rawBefore = localRecord ? local.getLocal(localRecord.id) : undefined;
  if (localRecord) {
    const key = `agent-remote-forks:${baseUrl}:record:${localRecord.id}`;
    const legacy = JSON.parse(localStorage.getItem(key)!);
    legacy.target.viewId = 'retired-side-pane';
    localStorage.setItem(key, JSON.stringify(legacy));
  }
  let projection = {
    id: localRecord?.id ?? 'relation', kind: 'side', createdAt: '2026-10-10T00:00:00.000Z', source: current, target: side, nativeSourceRef: origin,
    sourceBinding: { kind: 'fixed', source: origin }, hostLocator: { hostId: 'host', controllerId: 'controller' },
    linked: true, revision: 1, roleRevision: 2,
  };
  const requests: Array<{ providerId: string; nativeSessionId: string }> = [];
  let receiveMigration!: (value: import('@orchardworks/agent-remote-protocol').SessionMigration) => void;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/session-migrations')) return Response.json({ migrations: [] });
    if (path.endsWith('/session-relations')) return Response.json({ relations: [projection] });
    if (path.endsWith('/attach')) {
      const value = JSON.parse(String(init?.body));
      requests.push(value);
      return Response.json({ agentId: value.nativeSessionId + '-agent', nativeSessionId: value.nativeSessionId });
    }
    if (path.endsWith('/catalog')) return Response.json({ items: [], hasMore: false, revision: '1' });
    if (path.endsWith('/workspaces')) return Response.json({ workspaces: [] });
    return new Response(null, { status: 404 });
  };
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  const snapshot = (session: OpenedSession) => ({ ...replicaState.agent!, id: session.agentId, providerId: session.providerId,
    persistence: { providerId: session.providerId, sessionId: session.nativeSessionId, opaque: session.nativeSessionId },
    runtimeInfo: { providerId: session.providerId, sessionId: session.nativeSessionId, status: 'idle' as const } });
  const snapshots = { 'S-agent': snapshot(side), 'A-agent': snapshot(original), 'B-agent': snapshot(current), 'C-agent': snapshot(advanced), 'Y-agent': snapshot(edited), 'Z-agent': snapshot(secondEdit) };
  const observedAgents: string[] = [];
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'pA', displayName: 'A' }, { providerId: 'pB', displayName: 'B' }],
    createAgent: async () => { throw new Error('Unexpected creation'); },
    resumeAgent: async () => { throw new Error('Unexpected resume'); },
    fetchSnapshot: async agentId => { observedAgents.push(agentId); return { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshots[agentId as keyof typeof snapshots] }; },
    fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'page', agentId, epoch: 'epoch', direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, entries: [], hasOlder: false, hasNewer: false, error: null,
    } }),
    connect: (agentId, listener) => {
      observedAgents.push(agentId);
      queueMicrotask(() => {
        listener.onOpen();
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
        listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: snapshots[agentId as keyof typeof snapshots] });
      });
      return { close() {}, send(message) {
        if (message.type === 'session_control_request') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION,
          type: 'session_control', payload: { agentId, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } }));
        if (message.type === 'timeline_subscription') queueMicrotask(() => listener.onMessage({ protocolVersion: PROTOCOL_VERSION,
          type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } }));
      } };
    },
    onSessionMigration: listener => { receiveMigration = listener; return () => {}; },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  };
  const directory = new SessionDirectoryClient(baseUrl, fetcher, 'host');
  const props = { baseUrl, userScoped: true, directory, transport,
    hostService: { hosts: async () => ({ hosts: [{ id: 'host', name: 'Host', online: true,
      providers: [{ providerId: 'pA', displayName: 'A' }, { providerId: 'pB', displayName: 'B' }] }] }),
      pair: async () => { throw new Error('Unexpected pair'); } },
    initialState: { ...replicaState, agent: snapshots[current.agentId as keyof typeof snapshots] }, initialSessionStatus: 'ready' as const,
    actions: { sendMessage: async () => {} } };
  let container = await render(<App {...props} />);
  async function assertAttachedNative(nativeSessionId: string): Promise<void> {
    const panel = container.querySelector<HTMLElement>('.lab-side-conversation:not([hidden])')!;
    await waitFor(() => expect(panel.querySelector('button.agent-toolbar-more')).not.toBeNull());
    await act(async () => panel.querySelector<HTMLButtonElement>('button.agent-toolbar-more')!.click());
    const status = [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Status');
    if (status) await act(async () => status.click());
    await waitFor(() => {
      const section = panel.querySelector<HTMLElement>('section[aria-label="Session status"]')!;
      expect(section.hidden).toBe(false);
      const label = [...section.querySelectorAll('dt')].find(label => label.textContent === 'Session');
      expect(label?.nextElementSibling?.textContent).toBe(nativeSessionId);
    });
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Close session controls"]')!.click());
  }
  try {
    await waitFor(() => expect(container.querySelector('.lab-fork-entries')).not.toBeNull());
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-fork-entry > button')!.click());
    await waitFor(() => {
      expect(container.textContent).not.toContain('The selected session view no longer matches this session.');
      expect(container.querySelectorAll('.lab-side-conversation:not([hidden])')).toHaveLength(1);
    });
    await act(async () => receiveMigration({ id: 'edit-X-Y', from: { ...side, hostId: 'host' }, to: { ...edited, hostId: 'host' }, createdAt: 1 }));
    const follow = [...container.querySelectorAll<HTMLButtonElement>('.lab-prompt-edit-notice button')].find(button => button.textContent === 'Open edited branch');
    expect(follow).toBeDefined();
    await act(async () => follow!.click());
    await waitFor(() => expect(container.textContent).toContain('Opened the edited branch.'));
    expect(new URL(window.location.href).searchParams.get('session')).toBe('Y');
    await assertAttachedNative('Y');
    expect(container.querySelector('.lab-primary-conversation .lab-fork-entry > button')?.getAttribute('aria-pressed')).toBe('true');
    if (localRecord) expect(local.getLocal(localRecord.id)).toEqual(rawBefore);
    else expect(local.allLocal()).toEqual([]);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close side conversation, back to source"]')!.click());
    if (!localDelivery) {
      projection = { ...projection, source: advanced, roleRevision: 3 };
      await act(async () => window.dispatchEvent(new Event('focus')));
      await waitFor(() => expect(container.querySelector('.lab-fork-entry > button')).toBeNull());
      expect(new ForkStore(baseUrl).allLocal()).toEqual([]);
      await unmount(container);
      current = advanced;
      localStorage.setItem(`agent-remote-opened:${baseUrl}`, JSON.stringify([current]));
      window.history.replaceState(null, '', '/?host=host&provider=pA&session=C&agent=C-agent');
      props.initialState = { ...replicaState, agent: snapshots['C-agent'] };
      container = await render(<App {...props} />);
      await waitFor(() => expect(container.querySelector('.lab-fork-entry > button')).not.toBeNull());
    }
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-fork-entry > button')!.click());
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('session')).toBe('Y'));
    expect(requests.map(item => item.nativeSessionId)).toEqual(['S', 'Y', 'Y']);
    await unmount(container);
    window.history.replaceState(null, '', `/?host=host&provider=pA&session=${current.nativeSessionId}&agent=${current.agentId}`);
    container = await render(<App {...props} />);
    await waitFor(() => expect(container.querySelector('.lab-fork-entry > button')).not.toBeNull());
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-fork-entry > button')!.click());
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('session')).toBe('Y'));
    if (localRecord) expect(new ForkStore(baseUrl).getLocal(localRecord.id)).toEqual(rawBefore);
    await assertAttachedNative('Y');
    await act(async () => receiveMigration({ id: 'edit-Y-Z', from: { ...edited, hostId: 'host' }, to: { ...secondEdit, hostId: 'host' }, createdAt: 2 }));
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('.lab-prompt-edit-notice button')].find(button => button.textContent === 'Open edited branch')!.click());
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('session')).toBe('Z'));
    await assertAttachedNative('Z');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close side conversation, back to source"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-fork-entry > button')!.click());
    await waitFor(() => expect(new URL(window.location.href).searchParams.get('session')).toBe('Z'));
    await assertAttachedNative('Z');
    expect(requests.map(item => item.nativeSessionId)).toEqual(['S', 'Y', 'Y', 'Y', 'Z', 'Z']);
    expect(requests.every(item => item.providerId === 'pA')).toBe(true);
    expect(observedAgents).toContain('Y-agent');
    expect(observedAgents).toContain('Z-agent');
    if (localRecord) expect(new ForkStore(baseUrl).getLocal(localRecord.id)).toEqual(rawBefore);
    else expect(new ForkStore(baseUrl).allLocal()).toEqual([]);
  } finally { await unmount(container); }
});
