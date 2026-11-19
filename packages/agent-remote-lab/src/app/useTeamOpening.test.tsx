import { describe, expect, it, vi } from 'vitest';
import { buildBinding, buildView, buildWindow } from '../test/window-builders.js';
import { mockScope, renderHook } from '../test/render-hook.js';
import { useTeamOpening } from './useTeamOpening.js';

const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'source', title: 'Source' };
const team = { id: 'team-1', source, members: [
  { id: 'm-lead', role: 'leader', creation: 'ready', hostId: 'local', providerId: 'codex', nativeSessionId: 'lead', name: 'Lead' },
  { id: 'm-worker', role: 'worker', creation: 'ready', hostId: 'local', providerId: 'codex', nativeSessionId: 'worker', name: 'Worker' },
] } as never;
const sourceView = buildView('source', 'primary', { binding: buildBinding('source') });
const leaderView = { ...buildView('lead', 'dock'), feature: { kind: 'team', id: 'team-1', metadata: { role: 'leader' } } };

function scopeOf(window: ReturnType<typeof buildWindow> | undefined, facts: Record<string, unknown> = {}) {
  const scope = {
    editWindow: vi.fn(), presentedSelection: () => window?.views[0], sessionWindows: { open: vi.fn() }, windowWorkspace: { readWindow: () => window },
    openSession: vi.fn(async () => true), bindDirectorySession: vi.fn(async () => true), ...facts,
  };
  return { scope, mock: mockScope<typeof useTeamOpening>(scope) };
}

async function open(window: ReturnType<typeof buildWindow> | undefined, facts: Record<string, unknown> = {}, viewAddress?: string) {
  const built = scopeOf(window, facts);
  const { result } = await renderHook(() => useTeamOpening(built.mock));
  return { ...built, opened: await result.current.openTeamLayout(team, viewAddress) };
}

describe('opening a Team', () => {
  it('shows the Team dock beside its source session that is already shown', async () => {
    const { scope, opened } = await open(buildWindow([sourceView]));
    expect(opened).toBe(true);
    expect(scope.sessionWindows.open).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ teamMemberId: 'm-lead' }), expect.objectContaining({ teamMemberId: 'm-worker' })]),
      expect.objectContaining({ teamMemberId: 'm-lead' }), 'team-1');
    expect(scope.editWindow).not.toHaveBeenCalled();
  });
  it('selects an existing leader view instead of making another, and shows the dock', async () => {
    const window = buildWindow([sourceView, leaderView]);
    const { scope, opened } = await open(window);
    expect(opened).toBe(true);
    expect(scope.editWindow).toHaveBeenCalledWith({ type: 'view.select', viewId: 'lead' });
    expect(scope.sessionWindows.open).toHaveBeenCalled();
  });
  it('gives up when the selected leader view is no longer the Team leader after the selection', async () => {
    const window = buildWindow([sourceView, leaderView]);
    const swapped = buildWindow([sourceView, { ...leaderView, feature: undefined }]);
    let reads = 0;
    const { scope, opened } = await open(window, { windowWorkspace: { readWindow: () => reads++ === 0 ? window : swapped } });
    expect(opened).toBe(false);
    expect(scope.sessionWindows.open).not.toHaveBeenCalled();
  });
  it('makes a new source view when the selected one is another session and is managed', async () => {
    const managed = buildView('other', 'primary', { bindingPolicy: 'managed' });
    const { scope, opened } = await open(buildWindow([managed]));
    expect(opened).toBe(true);
    const operation = scope.editWindow.mock.calls[0]![0];
    expect(operation.type).toBe('batch');
    expect(operation.operations.map((step: { type: string }) => step.type)).toEqual(['view.create', 'view.select']);
    expect(scope.bindDirectorySession).not.toHaveBeenCalled();
  });
  it('rebinds the selected view to the source when it is not managed', async () => {
    const other = buildView('other', 'primary');
    const { scope, opened } = await open(buildWindow([other]));
    expect(opened).toBe(true);
    expect(scope.bindDirectorySession).toHaveBeenCalledWith(source, { windowId: 'W', viewId: 'other', binding: JSON.stringify(other.binding) });
  });
  it('stops when the rebinding is refused', async () => {
    const { scope, opened } = await open(buildWindow([buildView('other', 'primary')]), { bindDirectorySession: vi.fn(async () => false) });
    expect(opened).toBe(false);
    expect(scope.sessionWindows.open).not.toHaveBeenCalled();
  });
  it('stops when the Window changed while the source was being bound', async () => {
    const window = buildWindow([buildView('other', 'primary')]);
    let reads = 0;
    const { opened } = await open(window, { windowWorkspace: { readWindow: () => reads++ < 1 ? window : buildWindow([], undefined, { id: 'moved' }) } });
    expect(opened).toBe(false);
  });
  it('opens the source session first when there is no Window', async () => {
    const { scope, opened } = await open(undefined);
    expect(opened).toBe(true);
    expect(scope.openSession).toHaveBeenCalledWith(source, undefined, undefined, false, undefined, undefined, undefined, undefined, 'primary');
  });
  it('stops when the source session cannot be opened', async () => {
    const { opened } = await open(undefined, { openSession: vi.fn(async () => false) });
    expect(opened).toBe(false);
  });
});

describe('opening a Team from a view that was clicked', () => {
  it('refuses when the clicked view belongs to another Window', async () => {
    expect((await open(buildWindow([sourceView]), {}, 'elsewhere/source')).opened).toBe(false);
  });
  it('refuses when the clicked view is gone or does not show the Team source', async () => {
    expect((await open(buildWindow([sourceView]), {}, 'W/gone')).opened).toBe(false);
    expect((await open(buildWindow([buildView('other', 'primary')]), {}, 'W/other')).opened).toBe(false);
  });
  it('shows the dock for the clicked view that shows the source', async () => {
    const { scope, opened } = await open(buildWindow([sourceView]), {}, 'W/source');
    expect(opened).toBe(true);
    expect(scope.sessionWindows.open).toHaveBeenCalled();
  });
});
