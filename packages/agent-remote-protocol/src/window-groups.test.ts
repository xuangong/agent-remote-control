import { expect, it } from 'vitest';
import type { WorkspaceWindow } from './window-workspace.js';
import { WindowLayoutError, createWindowView } from './window-workspace-operations.js';
import {
  WindowGroupError, applyGroupOperation, isBotView, isWindowGroup, isWindowGroupCreateRequest, isWindowGroupMutation, isWindowMergeRequest,
  isWindowSplitRequest, isWindowTransferRequest, type WindowGroup,
} from './window-groups.js';

const session = (nativeSessionId: string, title = nativeSessionId) => ({ hostId: 'mac', providerId: 'claude', nativeSessionId, title });
function windowOf(id: string, ...views: WorkspaceWindow['views']): WorkspaceWindow {
  const primary = views.find(view => view.placement === 'primary')?.id ?? null;
  return { schemaVersion: 3, id, title: id, revision: 0, selectedPrimaryViewId: primary, selectedViewId: views[0]?.id ?? null, views };
}
const section = (window: WorkspaceWindow, rank = 'm'): WindowGroup => ({ window, bots: { rank, members: {} } });
/** The code of a group rule's refusal, or the message of any other error. */
function refusal(run: () => unknown): string {
  try { run(); } catch (error) { return error instanceof WindowGroupError ? error.code : `other:${(error as Error).message}`; }
  return 'none';
}

it('counts only ordinary views with a current session as bots', () => {
  expect(isBotView(createWindowView('main', session('a'), 'primary'))).toBe(true);
  expect(isBotView(createWindowView('dock', session('b')))).toBe(true);
  expect(isBotView(createWindowView('empty'))).toBe(false);
  expect(isBotView(createWindowView('past', { ...session('c'), sessionIntent: 'history' }))).toBe(false);
  expect(isBotView({ ...createWindowView('side', session('d'), 'attached'), attachedTo: 'main' })).toBe(false);
  expect(isBotView({ ...createWindowView('ask', session('e'), 'float'), bindingPolicy: 'managed' })).toBe(false);
  expect(isBotView({ ...createWindowView('team', session('f')), feature: { kind: 'team', id: 'release' } })).toBe(false);
  expect(isBotView(createWindowView('child', { ...session('g'), parentNativeSessionId: 'a' }))).toBe(false);
});

it('requires a Window or a section, and bot details only for bots', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'), createWindowView('empty'));
  expect(isWindowGroup({ window })).toBe(true);
  expect(isWindowGroup({ window, presentation: { window: false } })).toBe(false);
  expect(isWindowGroup({ ...section(window), presentation: { window: false } })).toBe(true);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { label: 'Release notes' } } } })).toBe(true);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { empty: { label: 'Nobody' } } } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'M', members: {} } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'a0', members: {} } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { picture: { shape: 'star', color: '#ff0000' } } } } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { picture: { shape: 'circle', color: 'red' } } } } })).toBe(false);
});

it('accepts plain Window requests as group requests and checks group creation', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'rename', title: 'Renamed' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.add', rank: 'm' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.add', rank: 'm', extra: 1 } })).toBe(false);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window })).toBe(true);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window, presentation: { window: false } })).toBe(false);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window, bots: { rank: 'm', members: {} }, presentation: { window: false } })).toBe(true);
  expect(refusal(() => { throw new WindowGroupError('bot_view', 'x'); })).toBe('bot_view');
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bot.update', viewId: 'main' } })).toBe(false);
  expect(isWindowMergeRequest({ operationId: 'op', issuedAt: 1, baseRevision: 0, source: 'other', sourceRevision: 2 })).toBe(true);
  expect(isWindowMergeRequest({ operationId: 'op', issuedAt: 1, baseRevision: 0, source: 'other' })).toBe(false);
  expect(isWindowSplitRequest({ operationId: 'op', issuedAt: 1, baseRevision: 0, newId: 'section' })).toBe(true);
  expect(isWindowSplitRequest({ operationId: 'op', issuedAt: 1, baseRevision: 0, newId: 'section', extra: 1 })).toBe(false);
  expect(isWindowTransferRequest({ operationId: 'op', issuedAt: 1, baseRevision: 0, viewId: 'main', target: 'other', targetRevision: 0 })).toBe(true);
  expect(isWindowTransferRequest({ operationId: 'op', issuedAt: 1, baseRevision: 0, viewId: 'main', target: 'other' })).toBe(false);
  expect(new WindowGroupError('bot_view', 'x')).toBeInstanceOf(WindowLayoutError);
});

it('adds and removes appearances, always keeping one', () => {
  const group: WindowGroup = { window: windowOf('w', createWindowView('main', session('a'), 'primary')) };
  const both = applyGroupOperation(group, { type: 'bots.add', rank: 'm' });
  expect(both.bots).toEqual({ rank: 'm', members: {} });
  expect(both.window.revision).toBe(1);
  const sectionOnly = applyGroupOperation(both, { type: 'window.remove' });
  expect(sectionOnly.presentation).toEqual({ window: false });
  expect(refusal(() => applyGroupOperation(sectionOnly, { type: 'bots.remove' }))).toBe('last_appearance');
  expect(refusal(() => applyGroupOperation(group, { type: 'window.remove' }))).toBe('last_appearance');
  expect(refusal(() => applyGroupOperation(both, { type: 'bots.add', rank: 'n' }))).toBe('section_exists');
  expect(applyGroupOperation(sectionOnly, { type: 'window.add' }).presentation).toBeUndefined();
  expect(applyGroupOperation(both, { type: 'section.rank', rank: 'n' }).bots?.rank).toBe('n');
});

it('keeps details only for views that are still bots', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'), createWindowView('dock', session('b')));
  let group = applyGroupOperation(section(window), { type: 'batch', operations: [
    { type: 'bot.update', viewId: 'main', details: { label: 'Writes the release notes', picture: { shape: 'hexagon', color: '#2f6fed' }, pinned: true } },
    { type: 'bot.update', viewId: 'dock', details: { label: 'Reviews' } },
  ] });
  expect(group.window.revision).toBe(1);
  expect(group.bots?.members.main).toEqual({ label: 'Writes the release notes', picture: { shape: 'hexagon', color: '#2f6fed' }, pinned: true });
  group = applyGroupOperation(group, { type: 'view.close', viewId: 'dock' });
  expect(Object.keys(group.bots?.members ?? {})).toEqual(['main']);
  expect(refusal(() => applyGroupOperation(group, { type: 'bot.update', viewId: 'dock', details: {} }))).toBe('bot_not_found');
});

it('lets a bot change its title but not its conversation', () => {
  const group = section(windowOf('w', createWindowView('main', session('a'), 'primary')));
  expect(applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: session('a', 'Renamed') }).window.views[0]?.binding?.title).toBe('Renamed');
  expect(refusal(() => applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: session('b') }))).toBe('bot_view');
  expect(refusal(() => applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: { ...session('a'), sessionIntent: 'history' } }))).toBe('bot_view');
  // Without a section the same view is an ordinary Window view and may show another session.
  expect(applyGroupOperation({ window: group.window }, { type: 'view.bind', viewId: 'main', binding: session('b') }).window.views[0]?.binding?.nativeSessionId).toBe('b');
  // Succession rebinds through the layout, which stays allowed.
  const { schemaVersion: _version, id: _id, revision: _revision, ...layout } = group.window;
  const succeeded = applyGroupOperation(group, { type: 'layout.apply', layout: { ...layout, views: [{ ...layout.views[0]!, binding: session('c') }] } });
  expect(succeeded.window.views[0]?.binding?.nativeSessionId).toBe('c');
});

it('refuses an invalid group or operation and leaves a refused batch without effect', () => {
  const group = section(windowOf('w', createWindowView('main', session('a'), 'primary')));
  expect(refusal(() => applyGroupOperation({ window: group.window, presentation: { window: false } }, { type: 'window.add' }))).toBe('invalid_window_operation');
  const before = JSON.stringify(group);
  expect(refusal(() => applyGroupOperation(group, { type: 'batch', operations: [{ type: 'rename', title: 'Changed' }, { type: 'bots.add', rank: 'n' }] }))).toBe('section_exists');
  expect(JSON.stringify(group)).toBe(before);
});
