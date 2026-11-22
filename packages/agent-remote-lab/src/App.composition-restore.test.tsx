import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { clearImageDraftScope, configureImageDraftPersistence } from '@orchardworks/agent-client-web/browser';
import { App, type LabTransport } from './App.js';
import * as workspaceHooks from './features/windows/useWindowWorkspace.js';
import { DirectoryError, SessionDirectoryClient } from './kernel/directory-client.js';
import { render, unmount, setPromptText, promptText } from './test/setup.js';
import { replicaState } from './test/fixtures.js';

// Reloading the page over a saved Window: the Window document, the drafts and the opened list live in the page's storage, so a
// reload is an unmount and a new mount over the same storage. Nothing may create a session or send a message again.
const useWindowWorkspace = workspaceHooks.useWindowWorkspace;
const scope = 'http://localhost/composition-restore/';
const session = (nativeSessionId: string, title: string) => ({ hostId: 'local', providerId: 'recorded', nativeSessionId, title });

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  configureImageDraftPersistence(() => true);
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/');
});

interface Options { views?: WorkspaceWindow['views']; selected?: string }
async function page(options: Options = {}) {
  configureImageDraftPersistence(() => false);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const views = options.views ?? [createWindowView('main', session('primary', 'Primary'), 'primary'),
    { ...createWindowView('side', session('side', 'Side'), 'attached'), attachedTo: 'main' }];
  const saved: WorkspaceWindow = { schemaVersion: 3, id: 'composition', revision: 0, title: 'Composition', selectedPrimaryViewId: 'main',
    selectedViewId: options.selected ?? 'side', views };
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${saved.id}`, JSON.stringify(saved));
  history.replaceState(null, '', `/?window=${saved.id}`);
  const attached: string[] = [], created: unknown[] = [], sent: unknown[] = [];
  // The Host gives a session a new agent each time it is attached, as after a reload.
  let generation = 0;
  const nativeOf = (agentId: string) => agentId.replace(/-g\d+$/, '');
  const attachGate = { hold: undefined as { id: string; release: () => void } | undefined, fail: new Map<string, Error>() };
  vi.spyOn(SessionDirectoryClient.prototype, 'attach').mockImplementation(async (_providerId, nativeSessionId) => {
    attached.push(nativeSessionId);
    const failure = attachGate.fail.get(nativeSessionId);
    if (failure) throw failure;
    if (attachGate.hold?.id === nativeSessionId) await new Promise<void>(resolve => { attachGate.hold!.release = resolve; });
    return { agentId: `${nativeSessionId}-g${generation}`, nativeSessionId };
  });
  vi.spyOn(SessionDirectoryClient.prototype, 'create').mockImplementation(async (...args) => { created.push(args); throw new Error('A reload must not create a session.'); });
  vi.spyOn(SessionDirectoryClient.prototype, 'list').mockResolvedValue({ items: [], hasMore: false, revision: '1' });
  vi.spyOn(SessionDirectoryClient.prototype, 'workspaces').mockResolvedValue({ workspaces: [] });
  let workspace!: ReturnType<typeof useWindowWorkspace>;
  vi.spyOn(workspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = useWindowWorkspace(...args); return workspace; });
  const snapshot = (agentId: string): Awaited<ReturnType<LabTransport['fetchSnapshot']>> => ({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
    ...replicaState.agent!, id: agentId, capabilities: { ...replicaState.agent!.capabilities, sessionSettings: true },
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: nativeOf(agentId), connection: { state: 'connected' as const }, settings: [
      { id: 'model', category: 'model' as const, label: 'Model', value: 'recorded-large', mutable: true, scope: 'session' as const, options: [{ value: 'recorded-large', label: 'Recorded Large' }] }] } } });
  const transport: LabTransport = {
    listProviders: async () => [{ providerId: 'recorded', displayName: 'Recorded' }],
    createAgent: async () => { throw new Error('A reload must not create a session.'); },
    resumeAgent: async () => { throw new Error('A reload must not create a session.'); },
    fetchSessionSuccessions: async () => ({ version: 1, successions: [], nextCursor: null }),
    fetchSnapshot: async agentId => snapshot(agentId),
    fetchTimeline: async agentId => ({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
      requestId: 'timeline', agentId, epoch: `epoch-${agentId}`, direction: 'tail', reset: false, staleCursor: false, gap: false,
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, error: null,
      entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-18T00:00:00Z', sourceSeqRanges: [], collapsed: [], resources: [],
        item: { type: 'assistant_message' as const, text: `History of ${agentId}` } }],
    } }),
    connect(agentId, listener) {
      queueMicrotask(() => listener.onOpen());
      const control = (requestId?: string) => listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
        agentId, ...(requestId ? { requestId } : {}), revision: 'control', access: 'control', available: false, token: 'fixture-token' } });
      return { close() {}, send(message) {
        if (message.type === 'send_message') sent.push(message);
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
          if (message.observation === 'activity') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId, status: 'idle' } });
          else { control(); listener.onMessage(snapshot(agentId)); }
        } else if (message.type === 'session_control_request') control(message.payload.requestId);
        else if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [agentId] } });
      } };
    },
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
  };
  let container = await render(<App baseUrl={scope} transport={transport} directory={new SessionDirectoryClient(scope)} />);
  await vi.waitFor(() => expect(workspace.window?.id).toBe(saved.id));
  const pane = (viewId: string) => container.querySelector<HTMLElement>(`[data-view-id="${viewId}"]`);
  const draftOf = (viewId: string) => { const input = pane(viewId)?.querySelector<HTMLElement>('[data-testid="prompt-input"]'); return input ? promptText(input) : undefined; };
  const type = async (viewId: string, text: string) => {
    const input = pane(viewId)!.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
    await act(async () => { setPromptText(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
  };
  return { workspace: () => workspace, pane, draftOf, type, attached, created, sent, attachGate, saved,
    get container() { return container; },
    reload: async () => { await unmount(container); await clearImageDraftScope(scope); // a page's retained editor content does not survive a reload
       attached.length = 0; generation++; container = await render(<App baseUrl={scope} transport={transport} directory={new SessionDirectoryClient(scope)} />);
      await vi.waitFor(() => expect(workspace.window?.id).toBe(saved.id)); } };
}

it('restores a Side with the drafts of both panes after a reload without creating a session or sending a message', async () => {
  const fixture = await page();
  await vi.waitFor(() => expect(fixture.pane('side')).not.toBeNull());
  await fixture.type('main', 'Unsent primary draft');
  await fixture.type('side', 'Unsent side draft');
  await fixture.reload();
  await vi.waitFor(() => expect([fixture.draftOf('main'), fixture.draftOf('side')]).toEqual(['Unsent primary draft', 'Unsent side draft']));
  expect(new Set(fixture.attached)).toEqual(new Set(['primary', 'side']));
  expect(fixture.created).toEqual([]);
  expect(fixture.sent).toEqual([]);
  expect(fixture.workspace().window!.views.map(view => view.id)).toEqual(['main', 'side']);
});

it('does not reopen a Side that was closed before the reload', async () => {
  const fixture = await page();
  await vi.waitFor(() => expect(fixture.pane('side')).not.toBeNull());
  await act(async () => { await fixture.workspace().operate({ type: 'view.close', viewId: 'side' }); });
  await vi.waitFor(() => expect(fixture.pane('side')).toBeNull());
  await fixture.type('main', 'Unsent primary draft');
  await fixture.reload();
  await vi.waitFor(() => expect(fixture.draftOf('main')).toBe('Unsent primary draft'));
  expect(fixture.pane('side')).toBeNull();
  expect(fixture.workspace().window!.views.map(view => view.id)).toEqual(['main']);
  expect(fixture.attached).not.toContain('side');
  expect(fixture.created).toEqual([]);
});

it.each(['the primary', 'another view'] as const)('does not let a Side restoration that finishes late override the person selecting %s', async choice => {
  const views = [createWindowView('main', session('primary', 'Primary'), 'primary'), { ...createWindowView('side', session('side', 'Side'), 'attached'), attachedTo: 'main' },
    createWindowView('other', session('other', 'Other'), 'dock')];
  const fixture = await page({ views });
  await vi.waitFor(() => expect(fixture.pane('side')).not.toBeNull());
  fixture.attachGate.hold = { id: 'side', release: () => {} };
  const reloading = fixture.reload();
  await vi.waitFor(() => expect(fixture.attached).toContain('side'));
  await reloading;
  const chosen = choice === 'the primary' ? 'main' : 'other';
  await act(async () => { await fixture.workspace().operate({ type: 'view.select', viewId: chosen }); });
  expect(fixture.workspace().window!.selectedViewId).toBe(chosen);
  await act(async () => { fixture.attachGate.hold!.release(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(fixture.workspace().window!.selectedViewId).toBe(chosen);
  expect(fixture.workspace().window!.views.map(view => view.id)).toEqual(['main', 'side', 'other']);
  expect(fixture.created).toEqual([]);
});

it('keeps a Side whose restoration failed in its place with the reason, and retries the same session on the next reload', async () => {
  const fixture = await page();
  await vi.waitFor(() => expect(fixture.pane('side')).not.toBeNull());
  await fixture.type('main', 'Unsent primary draft');
  fixture.attachGate.fail.set('side', new DirectoryError('Recorded Side temporarily unavailable', 'session_unavailable', 503));
  await fixture.reload();
  await vi.waitFor(() => expect(fixture.pane('side')!.querySelector('[role="alert"]')?.textContent).toContain('Recorded Side temporarily unavailable'));
  expect(fixture.draftOf('main')).toBe('Unsent primary draft');
  expect(fixture.workspace().window!.views.map(view => view.id)).toEqual(['main', 'side']);
  fixture.attachGate.fail.clear();
  await fixture.reload();
  await vi.waitFor(() => expect(fixture.pane('side')!.querySelector('[role="alert"]')).toBeNull());
  expect(fixture.attached.filter(id => id === 'side')).toHaveLength(1);
  expect(fixture.workspace().window!.views.map(view => view.id)).toEqual(['main', 'side']);
  expect(fixture.created).toEqual([]);
});

it('keeps the saved path of a nested Side that failed for good, and leaves the selection where it was', async () => {
  const views = [createWindowView('main', session('primary', 'Primary'), 'primary'), { ...createWindowView('side', session('side', 'Side'), 'attached'), attachedTo: 'main' },
    { ...createWindowView('nested', session('nested', 'Nested'), 'attached'), attachedTo: 'side' }];
  const fixture = await page({ views, selected: 'nested' });
  await vi.waitFor(() => expect(fixture.pane('nested')).not.toBeNull());
  fixture.attachGate.fail.set('nested', new DirectoryError('Recorded nested Side is unavailable', 'native_session_unavailable', 404));
  await fixture.reload();
  await vi.waitFor(() => expect(fixture.pane('nested')!.querySelector('[role="alert"]')?.textContent).toContain('Recorded nested Side is unavailable'));
  expect(fixture.workspace().window!.views.map(view => ({ id: view.id, attachedTo: view.attachedTo }))).toEqual([
    { id: 'main' }, { id: 'side', attachedTo: 'main' }, { id: 'nested', attachedTo: 'side' }].map(view => ({ attachedTo: undefined, ...view })));
  expect(fixture.workspace().window!.selectedViewId).toBe('nested');
});

it.each([false, true])('keeps the drafts of restored panes when the opened list is %s', async stale => {
  const fixture = await page();
  await vi.waitFor(() => expect(fixture.pane('side')).not.toBeNull());
  await fixture.type('main', 'Unsent primary draft');
  await fixture.type('side', 'Unsent side draft');
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  // The opened list is a catalogue of what this device opened: after the Host gave the sessions new agents it names their old ones.
  if (stale) localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([{ ...session('primary', 'Primary'), agentId: 'previous-binding-0' }, { ...session('side', 'Side'), agentId: 'previous-binding-1' }]));
  else localStorage.removeItem(`agent-remote-opened:${scope}`);
  await fixture.reload();
  await vi.waitFor(() => expect([fixture.draftOf('main'), fixture.draftOf('side')]).toEqual(['Unsent primary draft', 'Unsent side draft']));
  expect(new Set(fixture.attached)).toEqual(new Set(['primary', 'side']));
  expect(fixture.created).toEqual([]);
});

it('selects a Side when its composer is touched and leaves the page title on the source', async () => {
  const fixture = await page({ selected: 'main' });
  await vi.waitFor(() => expect(fixture.pane('side')?.querySelector('[data-testid="prompt-input"]')).not.toBeNull());
  expect(document.title).toBe('Primary · Orchard');
  const touch = async (control: HTMLElement) => { await act(async () => { control.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); control.focus(); control.click(); }); };
  await touch(fixture.pane('side')!.querySelector<HTMLElement>('[data-testid="prompt-input"]')!);
  expect(fixture.workspace().window!.selectedViewId).toBe('side');
  await touch(fixture.pane('main')!.querySelector<HTMLElement>('[data-testid="prompt-input"]')!);
  expect(fixture.workspace().window!.selectedViewId).toBe('main');
  await touch(fixture.pane('side')!.querySelector<HTMLElement>('[data-testid="prompt-input"]')!);
  expect(fixture.workspace().window!.selectedViewId).toBe('side');
  expect(document.title).toBe('Primary · Orchard');
  expect(fixture.workspace().window!.views.map(view => view.id)).toEqual(['main', 'side']);
  expect(fixture.created).toEqual([]);
});
