import { describe, expect, it, vi } from 'vitest';
import { DirectoryError } from '../directory-client.js';
import { buildView, buildWindow } from '../test/window-builders.js';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { useSessionBinding } from './useSessionBinding.js';

const item = { providerId: 'codex', nativeSessionId: 'target', title: 'Target' };
const visible = buildOpened('target');

function scopeOf(facts: Record<string, unknown> = {}) {
  const scope = {
    activeAgentId: 'agent-active', ancestors: [], baseUrl: 'https://relay', closeContext: vi.fn(), closeInspector: vi.fn(), compactLayoutRef: { current: false },
    directory: {}, directoryDestination: () => undefined, editWindow: vi.fn(), letterRequest: { current: { abort: vi.fn() } }, navigation: {}, openedSessions: [],
    pendingViewRestore: { current: undefined as unknown }, providerId: 'codex', replicaFor: () => ({ getState: () => ({}) }), selectedHost: { id: 'local' }, sessionEntries: [],
    sessionWindows: { focus: vi.fn(), activeId: undefined, bind: vi.fn() }, setDetachedSideRoot: vi.fn(), setFailure: vi.fn(), setNativeTakeover: vi.fn(), setSessionNotice: vi.fn(),
    setSideAnchor: vi.fn(), setSideFocus: vi.fn(), sharedViewForSlot: () => undefined, sharedWindow: undefined, showView: vi.fn(),
    succession: { open: vi.fn(async () => true), refresh: vi.fn(), document: { slots: [], tracks: [] } }, trackedViews: { select: vi.fn(), getForSlot: vi.fn() },
    transitionRef: { current: false }, transport: 'transport', windowSession: { openPrimary: vi.fn(async () => true), openAttached: vi.fn(async () => true) },
    windowWorkspace: { readWindow: () => undefined, readGroup: () => undefined, operate: vi.fn(async () => undefined) },
    rememberTrackedView: vi.fn(), familyPath: [], expandedKeys: new Set<string>(), ...facts,
  };
  return { scope, mock: mockScope<typeof useSessionBinding>(scope) };
}

async function mount(facts: Record<string, unknown> = {}) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useSessionBinding(built.mock));
  return { ...built, hook: result.current };
}

describe('opening a session', () => {
  it('opens through the succession model and defaults the Host to the selected one', async () => {
    const { scope, hook } = await mount();
    expect(await hook.openSession(item)).toBe(true);
    expect(scope.succession.open).toHaveBeenCalledWith({ ...item, hostId: 'local' }, undefined, undefined, undefined, undefined, undefined);
    expect(scope.showView).toHaveBeenCalledWith('workbench');
    expect(scope.closeContext).toHaveBeenCalled();
    expect(scope.setSessionNotice).toHaveBeenLastCalledWith(undefined);
  });
  it('does nothing without a directory or while another session is opening', async () => {
    for (const change of [{ directory: undefined }, { transitionRef: { current: true } }]) {
      const { scope, hook } = await mount(change);
      expect(await hook.openSession(item)).toBe(false);
      expect(scope.succession.open).not.toHaveBeenCalled();
    }
  });
  it('opens in the shared Window when there is one', async () => {
    const { scope, hook } = await mount({ sharedWindow: buildWindow([buildView('p')]), windowWorkspace: { readWindow: () => buildWindow([buildView('p')]), readGroup: () => undefined, operate: vi.fn() } });
    await hook.openSession(item, undefined, undefined, false, undefined, 'history', true, 'slot', undefined, 'view-id');
    expect(scope.windowSession.openPrimary).toHaveBeenCalledWith({ ...item, hostId: 'local' }, undefined, false, true, 'slot', 'view-id', 'history');
    expect(scope.succession.open).not.toHaveBeenCalled();
    expect(scope.sessionWindows.focus).not.toHaveBeenCalled();
  });
  it('focuses a session already on screen instead of opening it again', async () => {
    const { scope, hook } = await mount({ familyPath: [visible], expandedKeys: new Set(['view-target']) });
    expect(await hook.openSession({ ...item, hostId: 'local' })).toBe(true);
    expect(scope.setSideFocus).toHaveBeenCalledWith('view-target');
    expect(scope.setSideAnchor).not.toHaveBeenCalled();
    expect(scope.succession.open).not.toHaveBeenCalled();
  });
  it('anchors the layout on a visible session that is not expanded', async () => {
    const { scope, hook } = await mount({ familyPath: [visible] });
    await hook.openSession(item);
    expect(scope.setSideAnchor).toHaveBeenCalledWith('view-target');
  });
  it('opens a visible session again when a native process owns it, or a target view is named', async () => {
    const owned = await mount({ familyPath: [visible], replicaFor: () => ({ getState: () => ({ sessionControl: { nativeOwner: { generation: 'g' } } }) }) });
    await owned.hook.openSession(item);
    expect(owned.scope.succession.open).toHaveBeenCalled();
    const targeted = await mount({ familyPath: [visible], sharedWindow: buildWindow([buildView('p')]), windowWorkspace: { readWindow: () => buildWindow([buildView('p')]), readGroup: () => undefined } });
    await targeted.hook.openSession(item, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined, 'view-id');
    expect(targeted.scope.setSideFocus).not.toHaveBeenCalled();
  });
  it('leaves the Track for other navigation, and stays in it when returning to a parent', async () => {
    const away = await mount();
    await away.hook.openSession(item);
    expect(away.scope.trackedViews.select).toHaveBeenCalled();
    const parent = await mount({ ancestors: [{ ...visible, nativeSessionId: 'target', providerId: 'codex', hostId: 'local' }] });
    await parent.hook.openSession(item);
    expect(parent.scope.trackedViews.select).not.toHaveBeenCalled();
  });
  it('remembers how to restore a tracked view for a primary slot', async () => {
    const read = vi.fn();
    const { scope, hook } = await mount();
    await hook.openSession(item, undefined, undefined, false, read, undefined, undefined, 'slot');
    expect(scope.pendingViewRestore.current).toEqual({ scope: 'https://relay', transport: 'transport', slotId: 'slot', read });
  });
  it('stops an open letter request, unless the open is the letter navigation itself', async () => {
    const plain = await mount();
    await plain.hook.openSession(item);
    expect(plain.scope.letterRequest.current.abort).toHaveBeenCalled();
    const letter = await mount();
    await letter.hook.openSession(item, undefined, undefined, true);
    expect(letter.scope.letterRequest.current.abort).not.toHaveBeenCalled();
  });
  it('reports a failure as a notice and answers false', async () => {
    const { scope, hook } = await mount({ succession: { open: vi.fn(async () => { throw new DirectoryError('offline', 'host_offline'); }), document: { slots: [], tracks: [] } } });
    expect(await hook.openSession(item)).toBe(false);
    expect(scope.setSessionNotice).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.any(String) }));
  });
  it('offers a takeover when a native process owns the session, and rethrows for a takeover attempt', async () => {
    const owner = { generation: 'g', kind: 'terminal' };
    const open = vi.fn(async () => { throw new DirectoryError('owned', 'native_owned', 409, undefined, owner as never); });
    const { scope, hook } = await mount({ succession: { open, document: { slots: [], tracks: [] } } });
    expect(await hook.openSession(item)).toBe(false);
    expect(scope.setNativeTakeover).toHaveBeenLastCalledWith({ item: { ...item, hostId: 'local' }, owner, message: 'owned' });
    await expect(hook.openSession(item, 'g')).rejects.toThrow('owned');
  });
});

describe('binding a session to a view', () => {
  const primary = buildView('p', 'primary'), dock = buildView('d', 'dock');
  const window = buildWindow([primary, dock]);
  const destination = (view: typeof primary, binding = JSON.stringify(view.binding)) => ({ windowId: window.id, viewId: view.id, binding });
  const shared = (facts: Record<string, unknown> = {}) => ({ windowWorkspace: { readWindow: () => window, readGroup: () => undefined, operate: vi.fn() }, ...facts });
  const session = { ...item, hostId: 'local', agentId: 'agent-target' };
  it('opens an attached session as it is when there is no destination view', async () => {
    const { scope, hook } = await mount();
    await hook.bindDirectorySession(session, undefined);
    expect(scope.windowSession.openAttached).toHaveBeenCalledWith(session);
  });
  it('opens a session without an agent by the ordinary opening when there is no destination view', async () => {
    const { scope, hook } = await mount();
    await hook.bindDirectorySession({ ...item, hostId: 'local' }, undefined);
    expect(scope.succession.open).toHaveBeenCalled();
  });
  it('answers false for a destination in another Window or a view that is gone', async () => {
    const { hook } = await mount(shared());
    expect(await hook.bindDirectorySession(session, { ...destination(primary), windowId: 'other' })).toBe(false);
    expect(await hook.bindDirectorySession(session, { ...destination(primary), viewId: 'gone' })).toBe(false);
  });
  it('refuses a destination whose binding changed since it was chosen', async () => {
    const { hook } = await mount(shared());
    await expect(hook.bindDirectorySession(session, destination(primary, 'null'))).rejects.toThrow('The target session view changed. Choose a session again.');
  });
  it('opens a primary view through the Window session with the binding it expects', async () => {
    const { scope, hook } = await mount(shared());
    await hook.bindDirectorySession(session, destination(primary));
    expect(scope.windowSession.openPrimary).toHaveBeenCalledWith(session, session, false, undefined, undefined, 'p', undefined, primary.binding);
  });
  it('binds a dock in place by editing the Window', async () => {
    const { scope, hook } = await mount(shared());
    expect(await hook.bindDirectorySession(session, destination(dock))).toBe(true);
    expect(scope.editWindow).toHaveBeenCalledWith(expect.objectContaining({ type: 'view.bind', viewId: 'd', expectedBinding: dock.binding }));
  });
  it('restores a tracked view only while its primary opening is pending', async () => {
    const read = vi.fn();
    const { scope, hook } = await mount({ ...shared(), windowSession: { openPrimary: vi.fn(async () => false), openAttached: vi.fn() } });
    await hook.bindDirectorySession(session, destination(primary), { primarySlot: 'slot', read });
    expect(scope.pendingViewRestore.current).toBeUndefined();
  });
});

describe('the entry points that open a session', () => {
  it('opens a directory session in place of the selected local view, without a Window', async () => {
    const { scope, hook } = await mount({ sessionWindows: { focus: vi.fn(), activeId: 'local-view', bind: vi.fn() } });
    expect(await hook.openDirectorySession(item)).toBe(true);
    expect(scope.sessionWindows.bind).toHaveBeenCalledWith('local-view', { ...item, hostId: 'local' });
    expect(scope.succession.refresh).toHaveBeenCalled();
    expect(scope.succession.open).not.toHaveBeenCalled();
  });
  it('opens an ordinary session when no local view is selected or the layout is compact', async () => {
    const none = await mount();
    await none.hook.openDirectorySession(item);
    expect(none.scope.succession.open).toHaveBeenCalled();
    const compact = await mount({ compactLayoutRef: { current: true }, sessionWindows: { focus: vi.fn(), activeId: 'local-view', bind: vi.fn() } });
    await compact.hook.openDirectorySession(item);
    expect(compact.scope.sessionWindows.bind).not.toHaveBeenCalled();
  });
  it('shows an open failure as a notice', async () => {
    const { scope, hook } = await mount({ directoryDestination: () => { throw new Error('no view'); } });
    expect(await hook.openDirectorySession(item)).toBe(false);
    expect(scope.setSessionNotice).toHaveBeenCalled();
  });
  it('selects the shared view of a local view entry, and its tracked entry', async () => {
    const selected = vi.fn();
    const document = { slots: [{ id: 's1', intent: { kind: 'session', target: { hostId: 'local', native: { providerId: 'codex', nativeSessionId: 'x' } } } }], tracks: [{ slotId: 's1', entryId: 'e1' }] };
    const { scope, hook } = await mount({ succession: { document, open: vi.fn() }, sharedWindow: buildWindow([buildView('p')]), sharedViewForSlot: () => ({ id: 'shared-view' }), trackedViews: { select: selected, getForSlot: vi.fn() } });
    await hook.openLocalView('s1');
    expect(scope.editWindow).toHaveBeenCalledWith({ type: 'view.select', viewId: 'shared-view' });
    expect(selected).toHaveBeenCalledWith('e1');
  });
  it('does nothing for a slot that is not in the document', async () => {
    const { scope, hook } = await mount();
    await hook.openLocalView('missing');
    expect(scope.rememberTrackedView).not.toHaveBeenCalled();
  });
  it('says so when a preview source is not in the session list', async () => {
    const { scope, hook } = await mount();
    await hook.openPreviewSource('agent-x', 'item', 'local');
    expect(scope.setFailure).toHaveBeenCalledWith('This preview source is not in the current session list. Open its session from the Host first.');
  });
  it('opens the session of a preview source unless it is already the active one', async () => {
    const source = buildOpened('src', { agentId: 'agent-src' });
    const inactive = await mount({ sessionEntries: [source] });
    await inactive.hook.openPreviewSource('agent-src', 'item', 'local');
    expect(inactive.scope.succession.open).toHaveBeenCalled();
    const active = await mount({ sessionEntries: [source], activeAgentId: 'agent-src' });
    await active.hook.openPreviewSource('agent-src', 'item', 'local');
    expect(active.scope.succession.open).not.toHaveBeenCalled();
  });
});
