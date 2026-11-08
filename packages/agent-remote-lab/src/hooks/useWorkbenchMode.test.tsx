import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { conversationSessionStorage } from '../conversation-storage.js';
import { useWorkbenchMode } from './useWorkbenchMode.js';
import { useWindowWorkspace } from './useWindowWorkspace.js';
import { createCompositionDocument } from '../session-composition.js';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { WindowWorkspaceStore } from '../window-workspace-store.js';
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });
async function mount(scope = 'scope') { let value!: ReturnType<typeof useWorkbenchMode>; const node = document.createElement('div'); root = createRoot(node); function Harness() { value = useWorkbenchMode(scope); return null; } await act(async () => root!.render(<Harness />)); return () => value; }
it('restores independent places and compact home across mode switches', async () => {
  history.replaceState(null, '', '/?window=w&debug=1'); const read = await mount();
  await act(async () => { read().setMode('bot'); read().select({ kind: 'bot', groupId: 's', viewId: 'v' }); read().back(); });
  expect(read().rosterVisible).toBe(true); expect(read().place).toEqual({ kind: 'bot', groupId: 's', viewId: 'v' });
  await act(async () => read().setMode('window')); expect(location.search).toBe('?debug=1&window=w');
  await act(async () => read().setMode('bot')); expect(location.search).toBe('?debug=1&mode=bot&section=s&bot=v'); expect(read().rosterVisible).toBe(true);
});
it('honors explicit links over stored preferences and handles popstate', async () => {
  localStorage.setItem('agent-remote:workbench-mode', 'bot'); history.replaceState(null, '', '/?window=w'); const read = await mount(); expect(read().mode).toBe('window');
  await act(async () => { history.pushState(null, '', '/?mode=bot&section=s&bot=v'); dispatchEvent(new PopStateEvent('popstate')); });
  expect(read().mode).toBe('bot'); expect(read().rosterVisible).toBe(false);
  await act(async () => { history.pushState(null, '', '/?host=h&provider=p&session=n'); dispatchEvent(new PopStateEvent('popstate')); }); expect(read().mode).toBe('window');
});
it('does not copy an initial Bot native target into Window restoration', async () => {
  history.replaceState(null, '', '/?mode=bot&host=h&provider=p&session=n&debug=1'); const read = await mount();
  await act(async () => read().setMode('window')); expect(location.search).toBe('?debug=1'); expect(sessionStorage.getItem('agent-remote:recovery:scope:window-route')).toBeNull();
});
it('persists only fallback locator/title and retains page-local operation on storage failures', async () => {
  const read = await mount(); await act(async () => { read().setMode('bot'); read().select({ kind: 'session', session: { hostId: 'h', providerId: 'p', nativeSessionId: 'n', title: 'Title', agentId: 'credential', parentAgentId: 'attachment' } }); });
  const saved = sessionStorage.getItem('agent-remote:recovery:scope:bot-place')!; expect(saved).not.toContain('credential'); expect(saved).not.toContain('attachment');
  vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation(() => { throw new Error('full'); });
  await act(async () => read().acceptSectionRoute('another')); expect(read().place).toEqual({ kind: 'section', groupId: 'another' }); expect(read().rosterVisible).toBe(true);
});
it.each([
  '/?mode=bot&host=h&provider=p&session=bot-native&debug=1',
  '/?mode=bot&section=section&bot=main&debug=1',
  '/?window=section&host=stale&provider=p&session=old&debug=1',
])('restores the saved Window without consuming the previous Bot route: %s', async route => {
  const scope = 'combined-route', key = `agent-remote:recovery:${scope}:shared-window`;
  const binding = (id: string) => ({ hostId: 'h', providerId: 'p', nativeSessionId: id, title: id });
  const saved: WindowGroup = { window: { schemaVersion: 3, id: 'a', revision: 0, title: 'A', views: [createWindowView('main', binding('a'), 'primary'), createWindowView('dock', binding('other'), 'dock')], selectedPrimaryViewId: 'main', selectedViewId: 'dock' } };
  const section: WindowGroup = { window: { ...saved.window, id: 'section', title: 'Section' }, bots: { rank: 'm', members: {} }, presentation: { window: false } };
  localStorage.setItem(`${key}:a`, JSON.stringify(saved)); localStorage.setItem(`${key}:section`, JSON.stringify(section)); localStorage.setItem(`${key}:last-window`, 'a'); sessionStorage.setItem(key, 'a'); history.replaceState(null, '', route);
  const composition = createCompositionDocument(scope); let mode!: ReturnType<typeof useWorkbenchMode>, workspace!: ReturnType<typeof useWindowWorkspace>;
  function Harness() { mode = useWorkbenchMode(scope); workspace = useWindowWorkspace(scope, false, true, composition, true, { mode: mode.mode, onSectionRoute: mode.acceptSectionRoute }); return null; }
  root = createRoot(document.createElement('div')); await act(async () => root!.render(<Harness />));
  expect(mode.mode).toBe('bot'); expect(workspace.window).toBeUndefined(); expect(sessionStorage.getItem(key)).toBe('a'); expect(localStorage.getItem(`${key}:last-window`)).toBe('a');
  const operations = vi.spyOn(WindowWorkspaceStore.prototype, 'operate');
  await act(async () => mode.setMode('window'));
  expect(mode.mode).toBe('window'); expect(workspace.window).toEqual(saved.window); expect(location.search).toBe('?debug=1&window=a'); expect(operations).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).toBe('a'); expect(localStorage.getItem(`${key}:last-window`)).toBe('a');
});
