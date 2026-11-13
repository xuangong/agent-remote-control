import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { applyGroupOperation, createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument, compositionRoleKey, type RoleCheckpoint } from '../session-composition.js';
import { ensureWindowCompositionSlot } from '../window-composition.js';
import { WindowWorkspaceStore } from '../window-workspace-store.js';
import type { GroupHandle } from './useWindowWorkspace.js';
import { useWindowWorkspace } from './useWindowWorkspace.js';
import { useBotWorkspace } from './useBotWorkspace.js';
import type { BotPlace } from '../workbench-mode.js';

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });
const binding = { hostId: 'h', providerId: 'p', nativeSessionId: 'a', title: 'A' };
const group = (id: string): WindowGroup => ({ window: { schemaVersion: 3, id, revision: 0, title: id, selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', binding, 'primary')] }, bots: { rank: 'm', members: {} }, presentation: { window: false } });
async function mount(initial: BotPlace = { kind: 'bot', groupId: 'section', viewId: 'main' }, acquireOverride?: (id: string) => Promise<GroupHandle>) {
  const scope = 'bot-test', document = createCompositionDocument(scope), section = group('section');
  localStorage.setItem(`agent-remote:recovery:${scope}:shared-window:section`, JSON.stringify(section));
  let place = initial, enabled = true, current!: ReturnType<typeof useBotWorkspace>, workspace!: ReturnType<typeof useWindowWorkspace>;
  const succession = { document, discovering: false, ensureWindowView: vi.fn((id: string, view: string, b: typeof binding) => ensureWindowCompositionSlot(document, id, view, b)), save: vi.fn(), refresh: vi.fn(async () => {}) };
  function Harness() { workspace = useWindowWorkspace(scope, false, true, document); current = useBotWorkspace(acquireOverride ? { ...workspace, acquireGroup: acquireOverride } : workspace, succession, place, enabled); return null; }
  root = createRoot(globalThis.document.createElement('div')); await act(async () => root!.render(<StrictMode><Harness /></StrictMode>));
  return { read: () => current, workspace: () => workspace, succession, section, render: async (next = place, active = enabled) => { place = next; enabled = active; await act(async () => root!.render(<StrictMode><Harness /></StrictMode>)); } };
}
function handoff(document: ReturnType<typeof createCompositionDocument>, slot: NonNullable<ReturnType<typeof ensureWindowCompositionSlot>>, status: 'applied' | 'pending' | 'failed' = 'applied') {
  const from = { controllerId: 'controller', providerId: 'p', nativeSessionId: 'a' }, to = { ...from, nativeSessionId: 'b' };
  const checkpoint: RoleCheckpoint = { scope: document.scope, hostId: 'h', controllerId: 'controller', roleId: 'role', appliedRevision: 1,
    desired: { operationId: 'handoff', expectedRevision: 0, committedRevision: 1, from, to, projectionDigest: { version: 1, algorithm: 'sha256', hex: 'a'.repeat(64) } },
    documents: Object.fromEntries(['composition', 'track', 'ask', 'draftViews'].map(key => [key, { revision: 1, status, retention: 'session' }])) as RoleCheckpoint['documents'] };
  document.roles.push(checkpoint); slot.intent = { kind: 'role', roleKey: compositionRoleKey(checkpoint), revision: 1, target: { hostId: 'h', native: to } }; document.editRevision++; return checkpoint;
}
it('enrolls a section without selecting it as the Window and refreshes one locator set', async () => {
  const harness = await mount(); expect(harness.read().group?.window.id).toBe('section'); expect(harness.read().view?.id).toBe('main'); expect(harness.read().slot).toBeDefined();
  expect(harness.workspace().window?.id).not.toBe('section'); const selected = harness.workspace().window!; const url = location.href;
  await harness.render(); expect(harness.workspace().window).toBe(selected); expect(location.href).toBe(url); expect(harness.succession.refresh).toHaveBeenCalledTimes(1); expect(harness.succession.save).toHaveBeenCalledTimes(1);
});
it('applies one verified handoff layout while retaining view and text/image owners', async () => {
  const harness = await mount(); const slot = harness.read().slot!; const owners = structuredClone(slot.owners), selected = harness.workspace().window, url = location.href;
  const operations = vi.spyOn(WindowWorkspaceStore.prototype, 'operate'); handoff(harness.succession.document, slot); await harness.render(); await harness.render();
  expect(harness.read().view?.binding?.nativeSessionId).toBe('b'); expect(harness.read().slot).toBe(slot); expect(slot.owners).toEqual(owners); expect(harness.read().view?.id).toBe('main'); expect(harness.workspace().window).toBe(selected); expect(location.href).toBe(url);
  expect(operations.mock.calls.map(call => call[0].type)).toEqual(['layout.apply']);
});
it.each(['pending', 'failed'] as const)('does not synthesize a replacement from %s discovery', async status => {
  const harness = await mount(); handoff(harness.succession.document, harness.read().slot!, status); await harness.render(); expect(harness.read().view?.binding?.nativeSessionId).toBe('a');
});
it('keeps missing, hidden or ineligible bot identity unavailable without selecting another view', async () => {
  const harness = await mount({ kind: 'bot', groupId: 'section', viewId: 'missing' }); expect(harness.read().view).toBeUndefined(); expect(harness.read().error).toMatch(/unavailable/);
  await act(async () => harness.workspace().operateGroup('section', { type: 'bot.update', viewId: 'main', details: { hidden: true } })); await harness.render({ kind: 'bot', groupId: 'section', viewId: 'main' }); expect(harness.read().view).toBeUndefined(); expect(harness.read().error).toMatch(/unavailable/);
});
it('releases every late acquisition after StrictMode cancellation', async () => {
  const store = new WindowWorkspaceStore(group('section')); const releases: Array<ReturnType<typeof vi.fn>> = [], resolves: Array<(handle: GroupHandle) => void> = [];
  const acquire = () => new Promise<GroupHandle>(done => { resolves.push(done); }); const harness = await mount(undefined, acquire); await harness.render(undefined, false);
  await act(async () => { for (const resolve of resolves) { const release = vi.fn(); releases.push(release); resolve({ getGroup: store.getGroup, getSyncState: store.getSyncState, subscribe: store.subscribe, operate: store.operate.bind(store), retry: store.retry.bind(store), release }); } });
  expect(harness.read().group).toBeUndefined(); expect(releases.length).toBeGreaterThan(0); expect(releases.every(release => release.mock.calls.length === 1)).toBe(true);
});
it('clears a selected group only after confirmed local deletion', async () => {
  const harness = await mount(); const key = 'agent-remote:recovery:bot-test:shared-window:section';
  await act(async () => { localStorage.removeItem(key); dispatchEvent(new StorageEvent('storage', { key, newValue: null })); });
  expect(harness.read().group).toBeUndefined(); expect(harness.read().view).toBeUndefined(); expect(harness.read().error).toMatch(/unavailable/);
});
it('retries a failed selected group acquisition without changing the Window', async () => {
  let available = false; const store = new WindowWorkspaceStore(group('section'));
  const acquire = async (): Promise<GroupHandle> => {
    if (!available) throw new Error('Read unavailable');
    return { getGroup: store.getGroup, getSyncState: store.getSyncState, subscribe: store.subscribe, operate: store.operate.bind(store), retry: store.retry.bind(store), release: () => {} };
  };
  const harness = await mount(undefined, acquire); const selected = harness.workspace().window; expect(harness.read().error).toBe('Read unavailable'); available = true;
  await act(async () => harness.read().retry()); expect(harness.read().view?.id).toBe('main'); expect(harness.workspace().window).toBe(selected);
});
it('refreshes the section catalog when Bot mode enters or receives focus', async () => {
  const harness = await mount(); const added = group('added'); localStorage.setItem('agent-remote:recovery:bot-test:shared-window:added', JSON.stringify(added));
  await act(async () => dispatchEvent(new Event('focus'))); expect(harness.workspace().groups.some(group => group.window.id === 'added')).toBe(true);
});
it('does not apply a discovered old successor after the current group source changed', async () => {
  const harness = await mount(); const slot = harness.read().slot!; const checkpoint = handoff(harness.succession.document, slot, 'pending');
  const current = harness.workspace().readGroup('section')!; const { schemaVersion: _, id: __, revision: ___, ...layout } = current.window;
  await act(async () => harness.workspace().operateGroup('section', { type: 'layout.apply', layout: { ...layout, views: current.window.views.map(view => ({ ...view, binding: { ...binding, nativeSessionId: 'c', title: 'C' } })) } }));
  checkpoint.documents.composition.status = 'applied'; harness.succession.document.editRevision++; const operations = vi.spyOn(WindowWorkspaceStore.prototype, 'operate'); await harness.render();
  expect(harness.read().view?.binding?.nativeSessionId).toBe('c'); expect(operations).not.toHaveBeenCalled();
});
it('leases only the selected group and enrols the bots of every catalog group for handoffs', async () => {
  const other = group('other'); other.window.views = [createWindowView('main', { ...binding, nativeSessionId: 'z', title: 'Z' }, 'primary')]; delete other.bots; delete other.presentation;
  localStorage.setItem('agent-remote:recovery:bot-test:shared-window:other', JSON.stringify(other));
  const acquired: string[] = [];
  const acquire = async (id: string): Promise<GroupHandle> => {
    acquired.push(id); const store = new WindowWorkspaceStore(id === 'other' ? other : group(id));
    return { getGroup: store.getGroup, getSyncState: store.getSyncState, subscribe: store.subscribe, operate: store.operate.bind(store), retry: store.retry.bind(store), release: () => {} };
  };
  const harness = await mount(undefined, acquire);
  await act(async () => harness.workspace().refreshGroups());
  await harness.render();
  expect([...new Set(acquired)]).toEqual(['section']);
  expect(harness.succession.ensureWindowView).toHaveBeenCalledWith('other', 'main', expect.objectContaining({ nativeSessionId: 'z' }));
  expect(harness.succession.ensureWindowView).toHaveBeenCalledWith('section', 'main', expect.objectContaining({ nativeSessionId: 'a' }));
  await harness.render({ kind: 'bot', groupId: 'other', viewId: 'main' });
  expect([...new Set(acquired)]).toEqual(['section', 'other']);
  expect(harness.read().view?.binding.nativeSessionId).toBe('z');
});
