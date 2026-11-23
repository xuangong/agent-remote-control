import 'fake-indexeddb/auto';
import { type ComponentProps } from 'react';
import { expect, it, vi } from 'vitest';
import { createWindowView, splitSessionExcerpts, type WindowMutation, type WorkspaceWindow, type ProjectedTimelineEntry, type SessionSuccessionReplay, type Team } from '@orchardworks/agent-remote-protocol';
import { createWindowFeature } from './kernel/window-feature-views.js';
import { readQuotes } from './features/session-links/session-quotes.js';
import { RemoteTeamClient } from '@orchardworks/agent-client';
import { type OpenedSession, type SuccessionDescription } from './kernel/directory-client.js';
import * as askHooks from './features/team/useAskConversations.js';
import * as successionHooks from './hooks/useSessionSuccession.js';
import { sessionKey } from './kernel/session-tree.js';
import { saveTrackedSessions } from './kernel/tracking-state.js';
import * as workbenchComponents from './conversation/LabWorkbench.js';
import * as attentionHooks from './kernel/useSessionAttention.js';
import * as managerComponents from './features/sessions/ChatSessionManager.js';
import * as directoryComponents from './features/sessions/SessionDirectory.js';
import * as favoritesComponents from './features/sessions/SessionFavorites.js';
import * as windowWorkspaceHooks from './features/windows/useWindowWorkspace.js';
import { act, committed, expectDockedBeside, failureFixture, native, settleApp, testDeadline } from './App.succession.fixture.js';

it.each(['directory', 'directory-open', 'Favorites', 'Track'] as const)('opens a %s session beside the selected bot as a new primary group and keeps every other group', async navigation => {
  if (navigation === 'Favorites') vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const realDirectory = directoryComponents.SessionDirectory, realAttention = attentionHooks.useSessionAttention;
  let directory!: ComponentProps<typeof realDirectory>;
  vi.spyOn(directoryComponents, 'SessionDirectory').mockImplementation(props => { directory = props; return realDirectory(props); });
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((...args) => ({ ...realAttention(...args), trackVisible: true }));
  const realFavorites = favoritesComponents.FavoritesMenu;
  let favoritesMenu!: ComponentProps<typeof realFavorites>;
  vi.spyOn(favoritesComponents, 'FavoritesMenu').mockImplementation(props => { favoritesMenu = props; return realFavorites(props); });
  const binding = (id: string, title: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title });
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'navigation-primary-test', title: 'Parallel navigation', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A',
    views: [createWindowView('primary-A', binding('A', 'Retained primary'), 'primary'), createWindowView('primary-X', binding('X', 'Secondary X'), 'primary')] };
  const target = { ...binding('D', 'Destination D'), agentId: 'agent-D' };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: navigation === 'Track' || navigation === 'Favorites', windowDocument: document,
    seed(scope: string, source: OpenedSession) {
      localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${document.id}`, JSON.stringify(document));
      localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, target]));
      saveTrackedSessions(scope, [{ ...target, starredAt: 1 }]);
    } };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  const x = () => f.view.querySelector<HTMLElement>('[data-primary-group-id="primary-X"]');
  await settleApp(() => expect(x()).not.toBeNull());
  if (navigation === 'Favorites') {
    expect(x()!.hidden).toBe(true);
    await act(async () => f.view.querySelector<HTMLButtonElement>(':is(.lab-launcher, .lab-window-floating, .lab-toolbar-launchers, #lab-context) [aria-label="Groups"]')!.click());
    const option = f.view.querySelector<HTMLButtonElement>('[data-window-view-id="primary-X"]')!;
    expect(option.closest('[hidden]')).toBeNull();
    await act(async () => option.click());
    await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Close groups"]')!.click());
  } else {
    expect(x()!.closest('[hidden]')).toBeNull();
    await act(async () => { x()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
  }
  await settleApp(() => { expect(x()?.getAttribute('data-selected')).toBe('true'); expect(x()!.hidden).toBe(false); });
  const originalA = f.view.querySelector('[data-primary-group-id="primary-A"]');
  if (navigation === 'directory') await act(async () => directory.onSelect(target));
  else if (navigation === 'directory-open') await act(async () => directory.onOpen({ ...target, createdAt: 'now', updatedAt: 'now', state: 'idle' }));
  else if (navigation === 'Favorites') await act(async () => favoritesMenu.onOpen({ ...target, starredAt: 1, available: true, online: true }));
  else {
    await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
    await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>(':is(.lab-tracking-floating, .lab-launcher-track) .lab-session-row')].find(row => row.textContent?.includes(target.title))!.click());
  }
  // Rule 6: X is a bot and keeps its conversation; D opens beside it as a new primary group, selected.
  const selectedGroup = () => f.view.querySelector<HTMLElement>('[data-primary-group-id][data-selected="true"]');
  await settleApp(() => {
    expect(selectedGroup()?.getAttribute('data-primary-group-id')).not.toBe('primary-X');
    expect(selectedGroup()?.textContent).toContain('Destination D');
  });
  expect(f.view.querySelector('[data-primary-group-id="primary-A"]')).toBe(originalA);
  // A compact layout shows only the selected group; elsewhere X still shows its own conversation.
  if (navigation !== 'Favorites') expect(x()?.textContent).toContain('Secondary X');
  const current = navigation === 'Track' || navigation === 'Favorites' ? setup.windowDocument : JSON.parse(localStorage.getItem(`agent-remote:recovery:${f.scope}:shared-window:${document.id}`)!).window;
  const opened = current.views.find((view: { binding?: { nativeSessionId: string } }) => view.binding?.nativeSessionId === 'D');
  expect(opened?.placement).toBe('primary');
  expect(current.selectedPrimaryViewId).toBe(opened.id);
  expect(current.views.find((view: { id: string }) => view.id === 'primary-A')?.binding?.nativeSessionId).toBe('A');
  expect(current.views.find((view: { id: string }) => view.id === 'primary-X')?.binding?.nativeSessionId).toBe('X');
});

it('selects another primary group while a native attachment is pending without restoring stale selection', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const realManager = managerComponents.ChatSessionManager;
  let manager!: ComponentProps<typeof realManager>;
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { if (props.current.nativeSessionId === 'X') manager = props; return realManager(props); });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Group ${id}` });
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'pending-primary-test', title: 'Parallel pending', revision: 0,
    selectedPrimaryViewId: 'primary-X', selectedViewId: 'primary-X',
    views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('primary-X', binding('X'), 'primary')] };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, { chain: [], seed(scope) {
    localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${document.id}`, JSON.stringify(document));
  } });
  const selectA = () => f.view.querySelector<HTMLElement>('[data-primary-group-id="primary-A"]');
  await settleApp(() => { expect(selectA()).not.toBeNull(); expect(manager).toBeDefined(); });
  const release = f.holdAttach('D');
  try {
    await act(async () => { manager.onOpen({ ...binding('D'), agentId: 'agent-D' }); });
    await settleApp(() => expect(f.requests.some(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'D')).toBe(true));
    expect(JSON.parse(localStorage.getItem(`agent-remote:recovery:${f.scope}:shared-window:${document.id}`)!).window.views
      .find((view: { id: string }) => view.id === 'primary-X')?.binding?.nativeSessionId).toBe('D');
    expect(selectA()!.closest('[hidden]')).toBeNull();
    await act(async () => { selectA()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    await settleApp(() => expect(selectA()?.getAttribute('data-selected')).toBe('true'));
  } finally { await act(async () => release()); }
  await settleApp(() => expect(f.frames.some(frame => frame.type === 'subscribe' && frame.agentId === 'agent-D')).toBe(true));
  expect(selectA()?.getAttribute('data-selected')).toBe('true');
  await settleApp(() => {
    const saved = JSON.parse(localStorage.getItem(`agent-remote:recovery:${f.scope}:shared-window:${document.id}`)!).window;
    expect(saved.selectedPrimaryViewId).toBe('primary-A');
    expect(saved.views.find((view: { id: string }) => view.id === 'primary-X')?.binding?.nativeSessionId).toBe('D');
  });
});


it.each([false, true])('opens the global directory selection in a focused empty dock, or beside a focused dock bot (empty=%s), without replacing primary', async empty => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const realDirectory = directoryComponents.SessionDirectory;
  let directory!: ComponentProps<typeof realDirectory>;
  vi.spyOn(directoryComponents, 'SessionDirectory').mockImplementation(props => { directory = props; return realDirectory(props); });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Group ${id}` });
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'focused-dock-test', title: 'Dock navigation', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A',
    views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('ordinary-dock', empty ? undefined : binding('X'), 'dock')] };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, { chain: [], seed(scope) {
    localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${document.id}`, JSON.stringify(document));
  } });
  const dock = () => f.view.querySelector<HTMLElement>('[data-view-id="ordinary-dock"]');
  await settleApp(() => { expect(dock()).not.toBeNull(); expect(directory).toBeDefined(); });
  await act(async () => dock()!.focus());
  await settleApp(() => expect(dock()?.getAttribute('data-active')).toBe('true'));
  await act(async () => directory.onSelect({ ...binding('D'), agentId: 'agent-D' }));
  await settleApp(() => {
    const saved = JSON.parse(localStorage.getItem(`agent-remote:recovery:${f.scope}:shared-window:${document.id}`)!).window;
    expect(saved.selectedPrimaryViewId).toBe('primary-A');
    expect(saved.views.find((view: { id: string }) => view.id === 'primary-A')?.binding?.nativeSessionId).toBe('A');
    expectDockedBeside(saved.views, empty);
  });
  expect(f.view.querySelector('[data-primary-group-id="primary-A"]')).not.toBeNull();
});

/** An empty dock takes the session; a dock bot keeps X and the session opens in a new dock right after it (rule 6). */


it.each([false, true])('uses the focused mobile dock for Favorites context, opening beside a dock bot (empty=%s)', async empty => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  const realFavorites = favoritesComponents.FavoritesMenu;
  let menu!: ComponentProps<typeof realFavorites>;
  vi.spyOn(favoritesComponents, 'FavoritesMenu').mockImplementation(props => { menu = props; return realFavorites(props); });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Group ${id}` });
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'mobile-favorites-dock', title: 'Mobile dock', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'ordinary-dock',
    views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('ordinary-dock', empty ? undefined : binding('X'), 'dock')] };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  await settleApp(() => {
    expect(menu).toBeDefined();
    expect(menu.currentSession?.nativeSessionId).toBe(empty ? undefined : 'X');
    expect(menu.title).toBe(empty ? 'Select session' : 'Group X');
    expect(menu.activeKey).toBe(empty ? undefined : sessionKey(binding('X')));
  });
  await act(async () => menu.onOpen({ ...binding('D'), starredAt: 1, available: true, online: true }));
  await settleApp(() => {
    expect(setup.windowDocument.selectedPrimaryViewId).toBe('primary-A');
    expect(setup.windowDocument.views.find(view => view.id === 'primary-A')?.binding?.nativeSessionId).toBe('A');
    expectDockedBeside(setup.windowDocument.views, empty);
    expect(menu.currentSession?.nativeSessionId).toBe('D');
  });
});

it.each([false, true])('keeps the global Ask preference independent of the focused dock and prevents creation from an empty dock (empty=%s)', async empty => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const realAsk = askHooks.useAskConversations, realSuccession = successionHooks.useSessionSuccession;
  let ask!: ReturnType<typeof realAsk>, succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const binding = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Same native A' };
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'focused-ask-dock', title: 'Ask owner selection', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'ordinary-dock',
    views: [createWindowView('primary-A', binding, 'primary'), createWindowView('ordinary-dock', empty ? undefined : binding, 'dock')] };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, { chain: [], seed(scope) {
    localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:${document.id}`, JSON.stringify(document));
  } });
  await settleApp(() => expect(f.view.querySelector('[data-view-id="ordinary-dock"]')).not.toBeNull());
  expect(f.view.querySelector('[aria-label="Ask about this session"]')).toBeNull();
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="View options"]')!.click());
  const toggle = () => f.view.querySelector<HTMLInputElement>('[aria-label="Ask view"]');
  await settleApp(() => expect(toggle()).not.toBeNull());
  expect(toggle()!.closest('label')?.textContent).toBe('Ask view');
  expect(toggle()!.disabled).toBe(false);
  expect(toggle()!.checked).toBe(false);
  await act(async () => toggle()!.click());
  expect(toggle()!.checked).toBe(true);
  expect(localStorage.getItem('agent-remote:ask-view')).toBe('true');
  const trigger = () => f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]');
  await settleApp(() => expect(trigger()).not.toBeNull());
  expect(f.view.querySelectorAll('[aria-label="Ask about this session"]')).toHaveLength(1);
  expect(trigger()!.closest('[data-view-id], [data-primary-group-id]')).toBeNull();
  expect(trigger()!.disabled).toBe(empty);
  expect(f.requests.filter(request => request.url.endsWith('/create'))).toHaveLength(0);
  if (empty) {
    await act(async () => trigger()!.click());
    expect(f.view.querySelector('[role="dialog"][aria-label="Ask"]')).toBeNull();
    expect(f.requests.filter(request => request.url.endsWith('/create'))).toHaveLength(0);
    return;
  }
  await act(async () => trigger()!.click());
  await settleApp(() => {
    const dockBinding = succession.document.windowBindings!.find(item => item.viewId === 'ordinary-dock')!;
    const primaryBinding = succession.document.windowBindings!.find(item => item.viewId === 'primary-A')!;
    expect(dockBinding).toBeDefined(); expect(primaryBinding).toBeDefined();
    const dockOwner = succession.ownerFor(dockBinding.slotId), primaryOwner = succession.ownerFor(primaryBinding.slotId);
    expect(dockOwner).not.toBe(primaryOwner);
    expect(ask.isEnabled({ ...binding, agentId: 'agent-A' }, dockOwner)).toBe(true);
    expect(ask.isEnabled({ ...binding, agentId: 'agent-A' }, primaryOwner)).toBe(false);
    expect(ask.entryFor({ ...binding, agentId: 'agent-A' }, dockOwner).record?.source.nativeSessionId).toBe('A');
    expect(f.view.querySelector('[role="dialog"][aria-label="Ask"]')).not.toBeNull();
  });
  expect(f.requests.filter(request => request.url.endsWith('/create')).map(request => request.body?.sourceNativeSessionId)).toEqual(['A']);
}, testDeadline);

it.each((['dock', 'attached', 'float'] as const).flatMap(placement => [false, true].map(empty => ({ placement, empty, mobile: false }))).concat([{ placement: 'dock', empty: true, mobile: true }]))
('opens Track into the selected empty $placement view, or beside a bot there (empty=$empty, mobile=$mobile), and preserves primary', async ({ placement, empty, mobile }) => {
  if (mobile) vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const realAttention = attentionHooks.useSessionAttention;
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((...args) => ({ ...realAttention(...args), trackVisible: true }));
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Track ${id}` });
  const selected = createWindowView('selected-ordinary', empty ? undefined : binding('X'), placement);
  if (placement === 'attached') selected.attachedTo = 'primary-A';
  if (placement === 'float') selected.geometry = { x: 40, y: 60, width: 500, height: 600 };
  const document: WorkspaceWindow = { schemaVersion: 3, id: `track-destination-${placement}-${empty}`, title: 'Track destination', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: selected.id,
    views: [createWindowView('primary-A', binding('A'), 'primary'), selected] };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document,
    seed(scope: string) { saveTrackedSessions(scope, [{ ...binding('D'), starredAt: 1 }]); } };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  const trigger = () => f.view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]');
  await settleApp(() => { expect(trigger()).not.toBeNull(); expect(setup.windowDocument.selectedViewId).toBe(selected.id); });
  await act(async () => trigger()!.click());
  const row = () => [...f.view.querySelectorAll<HTMLButtonElement>(':is(.lab-tracking-floating, .lab-launcher-track) .lab-session-row')].find(item => item.textContent?.includes('Track D'));
  await settleApp(() => { expect(row()).toBeDefined(); expect(row()!.disabled).toBe(false); });
  await act(async () => row()!.click());
  const openedD = () => setup.windowDocument.views.find(view => view.binding?.nativeSessionId === 'D');
  await settleApp(() => expect(openedD()).toBeDefined());
  expect(setup.windowDocument.views.find(view => view.id === 'primary-A')?.binding?.nativeSessionId).toBe('A');
  const opened = openedD()!;
  if (empty) {
    // An empty view takes the session in place.
    expect(setup.windowDocument.selectedPrimaryViewId).toBe('primary-A');
    expect(setup.windowDocument.selectedViewId).toBe(selected.id);
    expect(setup.windowDocument.views.map(view => view.id)).toEqual(['primary-A', selected.id]);
    expect(opened.id).toBe(selected.id);
    expect(opened.placement).toBe(placement);
    expect(opened.attachedTo).toBe(selected.attachedTo);
    expect(opened.geometry).toEqual(selected.geometry);
    return;
  }
  // A bot keeps X; D opens beside it: a dock after the dock, a float for a float, a primary group for a Side.
  expect(setup.windowDocument.views.find(view => view.id === selected.id)?.binding?.nativeSessionId).toBe('X');
  expect(opened.id).not.toBe(selected.id);
  expect(opened.placement).toBe(placement === 'attached' ? 'primary' : placement);
  expect(opened.attachedTo).toBeUndefined();
  expect(setup.windowDocument.selectedViewId).toBe(opened.id);
  if (placement === 'dock') expect(setup.windowDocument.views.map(view => view.id)).toEqual(['primary-A', selected.id, opened.id]);
});

it('rejects Track replacement of the selected managed view without changing primary', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const realAttention = attentionHooks.useSessionAttention;
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((...args) => ({ ...realAttention(...args), trackVisible: true }));
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Managed ${id}` });
  const managed = { ...createWindowView('managed-dock', binding('X'), 'dock'), bindingPolicy: 'managed' as const };
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'track-managed-destination', title: 'Managed Track boundary', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: managed.id, views: [createWindowView('primary-A', binding('A'), 'primary'), managed] };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document,
    seed(scope: string) { saveTrackedSessions(scope, [{ ...binding('D'), starredAt: 1 }]); } };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  await settleApp(() => expect(f.view.querySelector('[aria-label="Tracked sessions"]')).not.toBeNull());
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
  const row = () => [...f.view.querySelectorAll<HTMLButtonElement>(':is(.lab-tracking-floating, .lab-launcher-track) .lab-session-row')].find(item => item.textContent?.includes('Managed D'));
  await settleApp(() => { expect(row()).toBeDefined(); expect(row()!.disabled).toBe(false); });
  await act(async () => row()!.click());
  await settleApp(() => expect(f.view.textContent).toContain('Select an ordinary session view or create an empty view first.'));
  expect(setup.windowDocument.views.find(view => view.id === 'primary-A')?.binding?.nativeSessionId).toBe('A');
  expect(setup.windowDocument.views.find(view => view.id === managed.id)?.binding?.nativeSessionId).toBe('X');
  expect(setup.windowDocument.selectedViewId).toBe(managed.id);
});

it('opens Track beside a dock bot whose replacement is still saving, leaving that dock to its own save', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const realAttention = attentionHooks.useSessionAttention, realWindow = windowWorkspaceHooks.useWindowWorkspace;
  let workspace!: ReturnType<typeof realWindow>;
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((...args) => ({ ...realAttention(...args), trackVisible: true }));
  vi.spyOn(windowWorkspaceHooks, 'useWindowWorkspace').mockImplementation((...args) => { workspace = realWindow(...args); return workspace; });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Queued ${id}` });
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'queued-track-destination', title: 'Queued Track', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'ordinary-dock',
    views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('ordinary-dock', binding('X'), 'dock')] };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document,
    seed(scope: string) { saveTrackedSessions(scope, [{ ...binding('D'), starredAt: 1 }]); },
    async beforeWindowMutation(mutation: WindowMutation) {
      if (mutation.operation.type === 'view.bind' && mutation.operation.binding.nativeSessionId === 'Y') { entered = true; await held; }
    } };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  await settleApp(() => expect(workspace.window?.selectedViewId).toBe('ordinary-dock'));
  let replacement!: Promise<void>;
  await act(async () => { replacement = workspace.operate({ type: 'view.bind', viewId: 'ordinary-dock', binding: binding('Y') }); });
  try {
    await settleApp(() => expect(entered).toBe(true));
    await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
    const row = () => [...f.view.querySelectorAll<HTMLButtonElement>(':is(.lab-tracking-floating, .lab-launcher-track) .lab-session-row')].find(item => item.textContent?.includes('Queued D'));
    await settleApp(() => { expect(row()).toBeDefined(); expect(row()!.disabled).toBe(false); });
    await act(async () => row()!.click());
    // The dock is a bot showing Y (still saving): D opens beside it in a new dock, queued after that save, and the dock keeps Y.
    expect(workspace.readWindow()?.views.find(view => view.id === 'ordinary-dock')?.binding?.nativeSessionId).toBe('Y');
    expect(setup.windowDocument.views.find(view => view.id === 'ordinary-dock')?.binding?.nativeSessionId).toBe('X');
  } finally { await act(async () => { release(); await replacement; }); }
  const opened = () => setup.windowDocument.views.find(view => view.binding?.nativeSessionId === 'D');
  await settleApp(() => expect(opened()).toBeDefined());
  expect(setup.windowDocument.views.find(view => view.id === 'ordinary-dock')?.binding?.nativeSessionId).toBe('Y');
  expect(opened()!.placement).toBe('dock');
  expect(setup.windowDocument.views.map(view => view.id)).toEqual(['primary-A', 'ordinary-dock', opened()!.id]);
  const operation = f.requests.map(request => request.body?.operation as WindowMutation['operation'] | undefined)
    .find(operation => operation?.type === 'view.bind' && operation.binding.nativeSessionId === 'D');
  expect(operation).toMatchObject({ type: 'view.bind', viewId: opened()!.id });
  expect(setup.windowDocument.views.find(view => view.id === 'primary-A')?.binding?.nativeSessionId).toBe('A');
  expect(setup.windowDocument.selectedViewId).toBe(opened()!.id);
});

it.each((['dock', 'attached', 'empty-dock'] as const).flatMap(destination => (['Team', 'TPM'] as const).map(feature => ({ destination, feature }))))
('creates $feature from the selected $destination binding without falling back to primary', async ({ destination, feature }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  localStorage.setItem('agent-remote:tpm-view', 'true');
  const teamCreate = vi.spyOn(RemoteTeamClient.prototype, 'create').mockImplementation(async input => ({
    id: 'created-selected-team', operationId: input.operationId, revision: 1, title: 'Selected source Team', status: 'active', source: input.source,
    members: [
      { id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'S', role: 'leader', name: 'Selected Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 },
      { id: 'member', hostId: 'host', providerId: 'recorded', nativeSessionId: 'T', role: 'member', name: 'Selected Member', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 },
    ], messages: [], createdAt: 1, updatedAt: 1,
  }));
  const tpmCreate = vi.fn().mockRejectedValue(new Error('TPM creation observed'));
  const hostService = {
    hosts: async () => ({ hosts: [{ id: 'host', name: 'Fixture Host', online: true, teamManagement: true as const, providers: [] }] }),
    pair: async () => { throw new Error('No pairing'); }, revoke: async () => {},
    tpmList: async () => ({ supported: true, supportedProviders: ['recorded'], works: [] }),
    tpmWork: async () => { throw new Error('No TPM detail expected'); }, tpmCreate,
    tpmAction: async () => { throw new Error('No TPM action expected'); },
  };
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Source ${id}` });
  const selected = createWindowView('feature-source', destination === 'empty-dock' ? undefined : binding('X'), destination === 'attached' ? 'attached' : 'dock');
  if (destination === 'attached') selected.attachedTo = 'primary-A';
  const document: WorkspaceWindow = { schemaVersion: 3, id: `feature-selected-${destination}-${feature}`, title: 'Selected feature source', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A', views: [createWindowView('primary-A', binding('A'), 'primary'), selected] };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document, hostService };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  await settleApp(() => expect(f.view.querySelector('[data-window-view-id="feature-source"]')).not.toBeNull());
  await act(async () => f.view.querySelector<HTMLButtonElement>(':is(.lab-launcher-window, .lab-window-floating) [aria-label="Groups"]')!.click());
  // The Windows entry's own row, not the hidden sidebar's.
  const destinationOption = [...f.view.querySelectorAll<HTMLButtonElement>('[data-window-view-id="feature-source"]')].find(option => option.closest('.lab-launcher-window, .lab-window-floating'))!;
  expect(destinationOption.closest('[hidden]')).toBeNull();
  await act(async () => destinationOption.click());
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Close groups"]')!.click());
  await settleApp(() => expect(setup.windowDocument.selectedViewId).toBe('feature-source'));
  if (destination !== 'attached') {
    await settleApp(() => expect(f.view.querySelector('[data-primary-group-id="primary-A"]')?.hasAttribute('data-selected')).toBe(false));
  }
  const trigger = feature === 'Team' ? '[aria-label="Teams"]' : '[aria-label="TPM works"]';
  await act(async () => f.view.querySelector<HTMLButtonElement>(trigger)!.click());
  const create = () => feature === 'Team'
    ? [...f.view.querySelectorAll<HTMLButtonElement>('[aria-label="Teams"] button')].find(button => button.textContent === 'New team')
    : f.view.querySelector<HTMLButtonElement>('[aria-label="Create TPM work"]');
  if (destination === 'empty-dock') {
    await settleApp(() => { expect(feature === 'Team' ? create()?.disabled === true : !create() || create()!.disabled).toBe(true); });
    expect(teamCreate).not.toHaveBeenCalled(); expect(tpmCreate).not.toHaveBeenCalled();
    expect(f.view.querySelector('.lab-tpm-panel [data-creation-source]')).toBeNull();
    return;
  }
  await settleApp(() => { expect(create()).toBeTruthy(); expect(create()!.disabled).toBe(false); });
  await act(async () => create()!.click());
  if (feature === 'Team') {
    await settleApp(() => expect(teamCreate).toHaveBeenCalledOnce());
    expect(teamCreate.mock.calls[0]![0]).toMatchObject({ source: binding('X'), operationId: expect.any(String) });
    expect(tpmCreate).not.toHaveBeenCalled();
    await settleApp(() => {
      const teamViews = setup.windowDocument.views.filter(view => view.feature?.kind === 'team' && view.feature.id === 'created-selected-team');
      expect(teamViews.map(view => view.binding?.nativeSessionId).sort()).toEqual(['S', 'T']);
      expect(teamViews.every(view => view.placement === 'dock' && view.bindingPolicy === 'managed')).toBe(true);
    });
    expect(setup.windowDocument.views.find(view => view.id === selected.id)?.binding?.nativeSessionId).toBe('X');
  } else {
    await settleApp(() => expect(tpmCreate).toHaveBeenCalledOnce());
    expect(tpmCreate).toHaveBeenCalledWith('host', expect.objectContaining({ providerId: 'recorded', mainNativeSessionId: 'X', operationId: expect.any(String) }));
    expect(teamCreate).not.toHaveBeenCalled();
  }
  expect(setup.windowDocument.views.find(view => view.id === 'primary-A')?.binding?.nativeSessionId).toBe('A');
});


// After a handoff the view keeps the member's original binding and shows its current session.
it.each([false, true])('offers Side and Handoff in a Team member view, keeping the member name as its title (handed off: %s)', async handedOff => {
  const current = handedOff ? 'Y' : 'X';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  const real = workbenchComponents.LabWorkbench;
  let member: ComponentProps<typeof real> | undefined;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.sessionIdentity?.nativeSessionId === current && props.state?.agent) member = props; return real(props); });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: id });
  const team: Team = { id: 'actions-team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: binding('A'),
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'L', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 },
      { id: 'worker', hostId: 'host', providerId: 'recorded', nativeSessionId: current, role: 'member', name: 'Worker', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }],
    messages: [], createdAt: 1, updatedAt: 1 };
  const managed = { ...createWindowView('team-worker', { ...binding('X'), title: 'Worker' }, 'dock'), bindingPolicy: 'managed' as const,
    feature: createWindowFeature({ kind: 'team', id: team.id, role: 'member', memberId: 'worker' }) };
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'team-actions', title: 'Team actions', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A', views: [createWindowView('primary-A', binding('A'), 'primary'), managed] };
  const description: SuccessionDescription = { role: { id: 'worker-role', revision: handedOff ? 2 : 1, origin: native('X'), current: native(current), workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } },
    targets: [{ providerId: 'recorded', displayName: 'Recorded' }, { providerId: 'claude-code', displayName: 'Claude Code' }], eligibility: { status: 'ready' } };
  const setup = { chain: handedOff ? [committed('X', 'Y', 2, 'worker-role')] : [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document, teams: () => [team], successionDescription: description };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  // The view can try to open before the Team roster arrives; it opens on retry once the roster names its member.
  const retry = () => [...f.view.querySelectorAll<HTMLButtonElement>('[data-view-id="team-worker"] button')].find(button => button.textContent === 'Retry');
  await settleApp(() => expect(member?.sessionStatus === 'ready' || !!retry()).toBe(true));
  if (retry()) await act(async () => retry()!.click());
  await settleApp(() => { expect(member?.sessionStatus).toBe('ready'); });
  const commands = member!.consoleCommands?.map(command => command.id) ?? [];
  expect(commands).toEqual(expect.arrayContaining(['console:side', 'console:fork', 'console:handoff']));
  expect(f.view.querySelector('[data-view-id="team-worker"] .agent-session-title')?.textContent).toBe('Worker');
  // A Side is a temporary bot the member's session organizes, its mission what the person wrote (bots design 9).
  await act(async () => { await member!.onExecuteConsoleCommand!('console:side', 'Check the logs.').catch(() => undefined); });
  expect(f.requests.find(request => request.url.endsWith('/v1/remote/teams/create'))?.body).toMatchObject({ source: { providerId: 'recorded', nativeSessionId: current }, bot: { name: 'Check the logs.', mission: 'Check the logs.' } });
  await act(async () => { await member!.onExecuteConsoleCommand!('console:handoff', 'claude'); });
  await settleApp(() => expect(f.requests.find(request => request.url.endsWith('/succession/describe'))?.body).toEqual({ providerId: 'recorded', nativeSessionId: current }));
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
});

it('quotes messages of several turns selected in one session view into another view, which sends them with its next message', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const real = workbenchComponents.LabWorkbench;
  const views = new Map<string, ComponentProps<typeof real>>();
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent && props.sessionIdentity) views.set(props.sessionIdentity.nativeSessionId, props); return real(props); });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Session ${id}` });
  const row = (seq: number, type: 'user_message' | 'assistant_message', text: string) => ({ providerId: 'recorded', seqStart: seq, seqEnd: seq, timestamp: 'now', turnId: `turn-${Math.ceil(seq / 2)}`,
    resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], item: { type, text } }) as ProjectedTimelineEntry;
  const timeline = [row(1, 'user_message', 'First prompt'), row(2, 'assistant_message', 'First reply'), row(3, 'user_message', 'Second prompt'), row(4, 'assistant_message', 'Second reply'), row(5, 'user_message', 'Third prompt')];
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'quotes', title: 'Quotes', revision: 0, selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A',
    views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('dock-Q', binding('Q'), 'dock')] };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document, timeline };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  const source = () => f.view.querySelector<HTMLElement>('[data-primary-group-id="primary-A"]')!;
  const entry = (text: string) => [...source().querySelectorAll<HTMLElement>('.agent-timeline-entry')].find(node => node.textContent?.includes(text))!;
  await settleApp(() => { expect(views.get('Q')?.sessionStatus).toBe('ready'); expect(entry('Third prompt')).toBeDefined(); });
  await act(async () => entry('First prompt').querySelector<HTMLButtonElement>('[aria-label="Quote this message"]')!.click());
  await act(async () => entry('Second prompt').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
  // Messages outside one range: unselected messages between selected ones separate the excerpt's parts.
  await act(async () => entry('Third prompt').querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  await act(async () => entry('First reply').querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
  const bar = () => source().querySelector<HTMLElement>('.lab-quote-bar');
  expect(bar()?.querySelector('[role="status"]')?.textContent).toContain('3 messages selected');
  expect([...bar()!.querySelectorAll<HTMLSelectElement>('select')[1]!.options].map(option => option.textContent)).toEqual(['Session Q · Docked', 'New session in this workspace']);
  await act(async () => [...bar()!.querySelectorAll('button')].find(button => button.textContent === 'Quote')!.click());
  await settleApp(() => expect(bar()).toBeNull());
  const chips = () => [...f.view.querySelectorAll('[data-view-id="dock-Q"] .lab-quote-attachments li')];
  await settleApp(() => expect(chips().map(chip => chip.textContent)).toEqual([`Quote${source().querySelector('.agent-session-title')!.textContent}3 messages×`]));
  expect(setup.windowDocument.selectedViewId).toBe('dock-Q');
  await act(async () => { await views.get('Q')!.actions!.sendMessage!('Compare these.'); });
  const sent = f.frames.filter(frame => frame.message?.type === 'send_message').map(frame => ({ agentId: frame.agentId, text: String(frame.message!.payload!.text) }));
  expect(sent).toHaveLength(1);
  const quoted = splitSessionExcerpts(sent[0]!.text);
  expect(quoted.text).toBe('Compare these.');
  expect(quoted.excerpts[0]).toMatchObject({ source: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A' },
    segments: [[{ role: 'user', text: 'First prompt' }], [{ role: 'user', text: 'Second prompt' }], [{ role: 'user', text: 'Third prompt' }]] });
  await settleApp(() => expect(chips()).toEqual([]));
});

it.each(['other Window', 'new session'] as const)('quotes into a session view of the %s', async destination => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Session ${id}` });
  const timeline = [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', turnId: 'turn', resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    item: { type: 'assistant_message', text: 'Worth quoting' } }] as ProjectedTimelineEntry[];
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'quotes', title: 'Quotes', revision: 0, selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A',
    views: [createWindowView('primary-A', binding('A'), 'primary')] };
  const other: WorkspaceWindow = { schemaVersion: 3, id: 'other', title: 'Other work', revision: 0, selectedPrimaryViewId: 'primary-R', selectedViewId: 'primary-R',
    views: [createWindowView('primary-R', binding('R'), 'primary')] };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document, otherWindows: [other], timeline };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  const source = () => f.view.querySelector<HTMLElement>('[data-primary-group-id="primary-A"]')!;
  const quote = () => source().querySelector<HTMLButtonElement>('[aria-label="Quote this message"]');
  await settleApp(() => expect(quote()).not.toBeNull());
  await act(async () => quote()!.click());
  const selects = () => source().querySelectorAll<HTMLSelectElement>('.lab-quote-bar select');
  await settleApp(() => expect([...selects()[0]!.options].map(option => option.textContent)).toEqual(['Quotes (this Window)', 'Other work']));
  // This Window has no other view, so only a new session can receive the quote here.
  expect([...selects()[1]!.options].map(option => option.textContent)).toEqual(['New session in this workspace']);
  if (destination === 'other Window') {
    await act(async () => { selects()[0]!.value = 'other'; selects()[0]!.dispatchEvent(new Event('change', { bubbles: true })); });
    expect([...selects()[1]!.options].map(option => option.textContent)).toEqual(['Session R · Main']);
  }
  await act(async () => [...source().querySelectorAll<HTMLButtonElement>('.lab-quote-bar button')].find(button => button.textContent === 'Quote')!.click());
  if (destination === 'other Window') {
    await settleApp(() => expect(source().querySelector('.lab-quote-notice')?.textContent).toContain('Quoted into “Session R” in Window “Other work”.'));
    expect(readQuotes(f.scope, 'primary-R').map(excerpt => excerpt.segments)).toEqual([[[{ role: 'assistant', text: 'Worth quoting' }]]]);
    expect(f.requests.some(request => request.url.endsWith('/create'))).toBe(false);
  } else {
    await settleApp(() => expect(setup.windowDocument.views.find(view => view.binding?.nativeSessionId === 'S')?.placement).toBe('dock'));
    expect(f.requests.find(request => request.url.endsWith('/create'))?.body).toMatchObject({ providerId: 'recorded' });
    const created = setup.windowDocument.views.find(view => view.binding?.nativeSessionId === 'S')!;
    expect(readQuotes(f.scope, created.id)).toHaveLength(1);
    await settleApp(() => expect(f.view.querySelector(`[data-view-id="${created.id}"] .lab-quote-attachments li`)).not.toBeNull());
  }
});

it('selects a managed Team view directly for pointer and focus without first selecting primary', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: id });
  const team: Team = { id: 'focus-team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: binding('A'),
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'X', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }],
    messages: [], createdAt: 1, updatedAt: 1 };
  const managed = { ...createWindowView('team-leader', binding('X'), 'dock'), bindingPolicy: 'managed' as const,
    feature: createWindowFeature({ kind: 'team', id: team.id, role: 'leader', memberId: 'leader' }) };
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'team-direct-focus', title: 'Team focus', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: 'primary-A', views: [createWindowView('primary-A', binding('A'), 'primary'), managed] };
  const selections: string[] = [];
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document, teams: () => [team],
    async beforeWindowMutation(mutation: WindowMutation) { if (mutation.operation.type === 'view.select') selections.push(mutation.operation.viewId); } };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  const input = () => f.view.querySelector<HTMLElement>('[data-view-id="team-leader"] [data-testid="prompt-input"]');
  await settleApp(() => expect(input()).not.toBeNull());
  for (const event of ['pointerdown', 'focusin']) {
    await act(async () => f.view.querySelector<HTMLButtonElement>(':is(.lab-launcher, .lab-window-floating, .lab-toolbar-launchers, #lab-context) [aria-label="Groups"]')!.click());
    await act(async () => f.view.querySelector<HTMLButtonElement>('[data-window-view-id="primary-A"]')!.click());
    await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Close groups"]')!.click());
    await settleApp(() => expect(setup.windowDocument.selectedViewId).toBe('primary-A'));
    selections.length = 0;
    await act(async () => input()!.dispatchEvent(event === 'pointerdown' ? new MouseEvent(event, { bubbles: true }) : new FocusEvent(event, { bubbles: true })));
    await settleApp(() => { expect(selections).toContain('team-leader'); expect(setup.windowDocument.selectedViewId).toBe('team-leader'); });
    expect(selections, event).not.toContain('primary-A');
    expect(setup.windowDocument.selectedPrimaryViewId).toBe('primary-A');
    selections.length = 0;
    await act(async () => { input()!.dispatchEvent(event === 'pointerdown' ? new MouseEvent(event, { bubbles: true }) : new FocusEvent(event, { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(selections, `repeated ${event}`).not.toContain('primary-A');
    expect(setup.windowDocument.selectedViewId).toBe('team-leader');
  }
});

it('keeps the selected shared attached child on repeated pointer and focus without selecting its dock root', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: id });
  const child = { ...createWindowView('attached-child', binding('Y'), 'attached'), attachedTo: 'dock-root' };
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'attached-direct-focus', title: 'Attached focus', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: child.id,
    views: [createWindowView('primary-A', binding('A'), 'primary'), createWindowView('dock-root', binding('X'), 'dock'), child] };
  const selections: string[] = [];
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document,
    async beforeWindowMutation(mutation: WindowMutation) { if (mutation.operation.type === 'view.select') selections.push(mutation.operation.viewId); } };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  const input = () => f.view.querySelector<HTMLElement>('[data-view-id="dock-root"] .lab-session-family-pane[aria-label="Y"] [data-testid="prompt-input"]');
  await settleApp(() => { expect(input()).not.toBeNull(); expect(setup.windowDocument.selectedViewId).toBe(child.id); });
  for (const event of ['pointerdown', 'focusin', 'pointerdown', 'focusin']) {
    selections.length = 0;
    await act(async () => { input()!.dispatchEvent(event === 'pointerdown' ? new MouseEvent(event, { bubbles: true }) : new FocusEvent(event, { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(selections, event).not.toContain('dock-root');
    expect(selections, event).not.toContain('primary-A');
    expect(setup.windowDocument.selectedViewId).toBe(child.id);
  }
});

it('opens an existing Team from a managed view by selecting its new ordinary source on mobile', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('max-width: 1180px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Session ${id}` });
  const originalTeam: Team = { id: 'original-team', operationId: 'original-create', revision: 1, title: 'Original Team', status: 'active', source: binding('A'),
    members: [{ id: 'original-leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'X', role: 'leader', name: 'Original Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }],
    messages: [], createdAt: 1, updatedAt: 1 };
  const unopenedTeam: Team = { ...originalTeam, id: 'unopened-team', operationId: 'unopened-create', title: 'Unopened Team', source: binding('S'),
    members: [{ ...originalTeam.members[0]!, id: 'unopened-leader', nativeSessionId: 'T', name: 'Unopened Leader' }] };
  const managed = { ...createWindowView('original-leader-view', binding('X'), 'dock'), bindingPolicy: 'managed' as const,
    feature: createWindowFeature({ kind: 'team', id: originalTeam.id, role: 'leader', memberId: 'original-leader' }) };
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'team-managed-fallback', title: 'Team navigation', revision: 0,
    selectedPrimaryViewId: 'primary-A', selectedViewId: managed.id, views: [createWindowView('primary-A', binding('A'), 'primary'), managed] };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document, teams: () => [originalTeam, unopenedTeam] };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  await settleApp(() => {
    expect(setup.windowDocument.selectedViewId).toBe(managed.id);
    expect(f.view.querySelector(`[data-view-id="${managed.id}"]`)?.closest('[hidden]')).toBeNull();
  });
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Teams"]')!.click());
  const openTeam = () => [...f.view.querySelectorAll<HTMLButtonElement>(':is(.lab-team-floating, .lab-launcher-team) .lab-session-row')]
    .find(button => button.textContent?.includes('Unopened Team'));
  await settleApp(() => expect(openTeam()).toBeDefined());
  await act(async () => openTeam()!.click());
  await settleApp(() => expect(setup.windowDocument.views.some(view => view.feature?.id === unopenedTeam.id)).toBe(true));
  const source = setup.windowDocument.views.find(view => view.binding?.nativeSessionId === 'S');
  expect(source).toBeDefined();
  expect(source?.bindingPolicy).not.toBe('managed');
  expect(source?.feature).toBeUndefined();
  expect(setup.windowDocument.views.find(view => view.id === managed.id)).toEqual(managed);
  expect(setup.windowDocument.views.find(view => view.id === 'primary-A')?.binding).toEqual(binding('A'));
  expect(setup.windowDocument.selectedViewId).toBe(source!.id);
  await settleApp(() => expect(f.view.querySelector(`[data-view-id="${source!.id}"]`)?.closest('[hidden]')).toBeNull());
});
