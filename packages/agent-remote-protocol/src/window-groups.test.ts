import { expect, it } from 'vitest';
import type { WorkspaceWindow } from './window-workspace.js';
import { WindowLayoutError, createWindowView } from './window-workspace-operations.js';
import {
  WindowGroupError, applyGroupOperation, decodeWindowGroup, duplicateBot, hasBotAppearance, isBotView, isWindowGroup, isWindowGroupCreateRequest, isWindowGroupMutation,
  isWindowGroupOperation, isWindowMergeRequest, isWindowSplitRequest, isWindowTransferRequest, mergeGroups, splitGroup, toWindowGroup, transferBot, type WindowGroup,
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

it('counts every view with a current session as a bot except Asks, history, subagents and empty views', () => {
  expect(isBotView(createWindowView('main', session('a'), 'primary'))).toBe(true);
  expect(isBotView(createWindowView('dock', session('b')))).toBe(true);
  expect(isBotView({ ...createWindowView('side', session('d'), 'attached'), attachedTo: 'main' })).toBe(true);
  expect(isBotView({ ...createWindowView('team', session('f')), feature: { kind: 'team', id: 'release', metadata: { role: 'member' } }, bindingPolicy: 'managed' })).toBe(true);
  expect(isBotView({ ...createWindowView('tpm', session('t')), feature: { kind: 'tpm', id: 'work', metadata: { hostId: 'mac' } }, bindingPolicy: 'managed' })).toBe(true);
  expect(isBotView({ ...createWindowView('ask', session('e'), 'float'), feature: { kind: 'ask', id: 'ask-1' }, bindingPolicy: 'managed' })).toBe(false);
  expect(isBotView(createWindowView('empty'))).toBe(false);
  expect(isBotView(createWindowView('past', { ...session('c'), sessionIntent: 'history' }))).toBe(false);
  expect(isBotView(createWindowView('child', { ...session('g'), parentNativeSessionId: 'a' }))).toBe(false);
});

it('lets a feature rebind its managed bot through the layout but keeps an ordinary bot on its conversation', () => {
  const managed = { ...createWindowView('member', session('m1')), feature: { kind: 'team', id: 'release', metadata: { role: 'member' } }, bindingPolicy: 'managed' as const };
  const group = section(windowOf('w', createWindowView('main', session('a'), 'primary'), managed));
  const { schemaVersion: _version, id: _id, revision: _revision, ...layout } = group.window;
  const rebound = applyGroupOperation(group, { type: 'layout.apply', layout: { ...layout, views: layout.views.map(view => view.id === 'member' ? { ...view, binding: session('m2') } : view) } });
  expect(rebound.window.views[1]?.binding?.nativeSessionId).toBe('m2');
  expect(refusal(() => applyGroupOperation(group, { type: 'view.bind', viewId: 'member', binding: session('m2') }))).toBe('bot_view');
  expect(refusal(() => applyGroupOperation(group, { type: 'view.bind', viewId: 'main', binding: session('b') }))).toBe('bot_view');
});

it('keeps every group visible in at least one mode, with bot details only for bots', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'), createWindowView('empty'));
  expect(isWindowGroup({ window })).toBe(true);
  expect(isWindowGroup({ window, presentation: { window: false } })).toBe(true);
  expect(isWindowGroup({ window, presentation: { bots: false } })).toBe(true);
  expect(isWindowGroup({ window, presentation: { window: false, bots: false } })).toBe(false);
  expect(isWindowGroup({ window, presentation: {} })).toBe(false);
  expect(isWindowGroup({ ...section(window), presentation: { window: false } })).toBe(true);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { label: 'Release notes' } } } })).toBe(true);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { empty: { label: 'Nobody' } } } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'M', members: {} } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'a0', members: {} } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { picture: { shape: 'star', color: '#ff0000' } } } } })).toBe(false);
  expect(isWindowGroup({ window, bots: { rank: 'm', members: { main: { picture: { shape: 'circle', color: 'red' } } } } })).toBe(false);
});

it('hides and shows a group in Bot mode and never hides it in both modes', () => {
  const group: WindowGroup = { window: windowOf('w', createWindowView('main', session('a'), 'primary')) };
  expect(hasBotAppearance(group)).toBe(true);
  const hidden = applyGroupOperation(group, { type: 'bots.hide' });
  expect(hidden.presentation).toEqual({ bots: false });
  expect(hasBotAppearance(hidden)).toBe(false);
  expect(refusal(() => applyGroupOperation(hidden, { type: 'bots.hide' }))).toBe('bots_hidden');
  expect(refusal(() => applyGroupOperation(hidden, { type: 'window.remove' }))).toBe('last_appearance');
  expect(applyGroupOperation(hidden, { type: 'bots.show' }).presentation).toBeUndefined();
  expect(refusal(() => applyGroupOperation(group, { type: 'bots.show' }))).toBe('bots_shown');
  const windowHidden = applyGroupOperation(group, { type: 'window.remove' });
  expect(windowHidden.presentation).toEqual({ window: false });
  expect(refusal(() => applyGroupOperation(windowHidden, { type: 'bots.hide' }))).toBe('last_appearance');
  expect(applyGroupOperation(windowHidden, { type: 'window.add' }).presentation).toBeUndefined();
  // A group hidden in Bot mode keeps its bot details and their checks, but its bots do not count as bots elsewhere.
  const detailed = applyGroupOperation(section(group.window), { type: 'batch', operations: [{ type: 'bot.update', viewId: 'main', details: { label: 'Writer' } }, { type: 'bots.hide' }] });
  expect(detailed.bots?.members.main).toEqual({ label: 'Writer' });
  expect(duplicateBot([detailed], [section(windowOf('other', createWindowView('main', session('a'), 'primary')))])).toBeUndefined();
});

it('accepts plain Window requests as group requests and checks group creation', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'rename', title: 'Renamed' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.add', rank: 'm' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.add', rank: 'm', extra: 1 } })).toBe(false);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window })).toBe(true);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window, presentation: { window: false } })).toBe(true);
  expect(isWindowGroupCreateRequest({ operationId: 'op', issuedAt: 1, window, presentation: { window: false, bots: false } })).toBe(false);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.hide' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.show' } })).toBe(true);
  expect(isWindowGroupMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'bots.hide', mode: 'bot' } })).toBe(false);
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
  // Bot mode shows a group without details too, so dropping them or hiding the Window of a plain group keeps one appearance.
  expect(applyGroupOperation(sectionOnly, { type: 'bots.remove' })).toEqual({ window: { ...sectionOnly.window, revision: 3 }, presentation: { window: false } });
  expect(applyGroupOperation(group, { type: 'window.remove' }).presentation).toEqual({ window: false });
  expect(refusal(() => applyGroupOperation(both, { type: 'bots.add', rank: 'n' }))).toBe('section_exists');
  expect(applyGroupOperation(sectionOnly, { type: 'window.add' }).presentation).toBeUndefined();
  expect(applyGroupOperation(both, { type: 'section.rank', rank: 'n' }).bots?.rank).toBe('n');
  expect(refusal(() => applyGroupOperation(group, { type: 'bots.remove' }))).toBe('section_missing');
  expect(refusal(() => applyGroupOperation(group, { type: 'window.add' }))).toBe('window_exists');
  expect(refusal(() => applyGroupOperation(sectionOnly, { type: 'window.remove' }))).toBe('window_missing');
  expect(refusal(() => applyGroupOperation({ ...both, window: { ...both.window, revision: Number.MAX_SAFE_INTEGER } }, { type: 'section.rank', rank: 'n' })))
    .toBe('other:The Window revision limit has been reached.');
});

it('puts a bot to sleep and wakes it as a detail of the group, shared by every device', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  const asleep = applyGroupOperation(section(window), { type: 'bot.update', viewId: 'main', details: { label: 'Night shift', asleep: true } });
  expect(asleep.bots?.members.main).toEqual({ label: 'Night shift', asleep: true });
  expect(isWindowGroup(asleep)).toBe(true);
  expect(applyGroupOperation(asleep, { type: 'bot.update', viewId: 'main', details: { label: 'Night shift' } }).bots?.members.main).toEqual({ label: 'Night shift' });
  expect(isWindowGroup({ ...asleep, bots: { ...asleep.bots!, members: { main: { asleep: false } } } })).toBe(false);
});

it('keeps details only for views that are still bots', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'), createWindowView('dock', session('b')));
  let group = applyGroupOperation(section(window), { type: 'batch', operations: [
    { type: 'bot.update', viewId: 'main', details: { label: 'Writes the release notes', picture: { shape: 'hexagon', color: '#2f6fed' }, pinned: true } },
    { type: 'bot.update', viewId: 'dock', details: { label: 'Reviews' } },
  ] });
  expect(group.window.revision).toBe(1);
  expect(group.bots?.members.main).toEqual({ label: 'Writes the release notes', picture: { shape: 'hexagon', color: '#2f6fed' }, pinned: true });
  // A view id reused within one batch starts without the details of the bot that held it.
  expect(applyGroupOperation(group, { type: 'batch', operations: [
    { type: 'view.close', viewId: 'dock' }, { type: 'view.create', view: createWindowView('dock', session('z')) },
  ] }).bots?.members.dock).toBeUndefined();
  // A batch of several layout edits advances the revision once.
  expect(applyGroupOperation(section(window), { type: 'batch', operations: [
    { type: 'rename', title: 'First' }, { type: 'view.collapse', viewId: 'dock', collapsed: true }, { type: 'rename', title: 'Second' },
  ] }).window.revision).toBe(1);
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
  // Rule 1 follows the state within a batch.
  expect(refusal(() => applyGroupOperation({ window: group.window }, { type: 'batch', operations: [
    { type: 'bots.add', rank: 'm' }, { type: 'view.bind', viewId: 'main', binding: session('b') },
  ] }))).toBe('bot_view');
  expect(applyGroupOperation({ window: group.window }, { type: 'batch', operations: [
    { type: 'view.bind', viewId: 'main', binding: session('b') }, { type: 'bots.add', rank: 'm' },
  ] }).window.views[0]?.binding?.nativeSessionId).toBe('b');
  // Succession rebinds through the layout, which stays allowed.
  const { schemaVersion: _version, id: _id, revision: _revision, ...layout } = group.window;
  const succeeded = applyGroupOperation(group, { type: 'layout.apply', layout: { ...layout, views: [{ ...layout.views[0]!, binding: session('c') }] } });
  expect(succeeded.window.views[0]?.binding?.nativeSessionId).toBe('c');
});

it('refuses an invalid group or operation and leaves a refused batch without effect', () => {
  const group = section(windowOf('w', createWindowView('main', session('a'), 'primary')));
  expect(refusal(() => applyGroupOperation({ window: group.window, presentation: { window: false, bots: false } }, { type: 'window.add' }))).toBe('other:The group or operation is invalid.');
  const before = JSON.stringify(group);
  expect(refusal(() => applyGroupOperation(group, { type: 'batch', operations: [{ type: 'rename', title: 'Changed' }, { type: 'bots.add', rank: 'n' }] }))).toBe('section_exists');
  expect(JSON.stringify(group)).toBe(before);
});

it('finds a session that is a bot in two places', () => {
  const first = section(windowOf('one', createWindowView('main', session('a'), 'primary')));
  const second = section(windowOf('two', createWindowView('main', session('a'), 'primary')));
  expect(duplicateBot([first], [second])?.group.window.id).toBe('one');
  expect(duplicateBot([second], [first])?.group.window.id).toBe('two');
  expect(duplicateBot([], [first, second])?.group.window.id).toBe('one');
  expect(duplicateBot([first], [{ window: second.window }])).toBeUndefined();
  const twice = section(windowOf('three', createWindowView('main', session('b'), 'primary'), createWindowView('dock', session('b'))));
  expect(duplicateBot([], [twice])?.session.nativeSessionId).toBe('b');
  // A duplicate among unchanged groups, such as one an older Worker left, does not block a change elsewhere.
  expect(duplicateBot([first, second], [section(windowOf('four', createWindowView('main', session('c'), 'primary')))])).toBeUndefined();
});

it('merges a Window into a section, keeping both appearances and the section identity', () => {
  const target: WindowGroup = { window: windowOf('section', createWindowView('writer', session('a'), 'primary')),
    bots: { rank: 'm', members: { writer: { label: 'Writer' } } }, presentation: { window: false } };
  const source: WindowGroup = { window: windowOf('window', createWindowView('main', session('b'), 'primary'),
    { ...createWindowView('side', session('c'), 'attached'), attachedTo: 'main' }) };
  const merged = mergeGroups(target, source);
  expect(merged.window.id).toBe('section');
  expect(merged.window.views.map(view => view.id)).toEqual(['writer', 'main', 'side']);
  expect(merged.window.revision).toBe(1);
  expect(merged.presentation).toBeUndefined();
  expect(merged.bots?.members).toEqual({ writer: { label: 'Writer' } });
  expect(refusal(() => mergeGroups(target, { window: windowOf('clash', createWindowView('writer', session('d'), 'primary')) })))
    .toBe('view_exists');
  expect(refusal(() => mergeGroups(target, target))).toBe('same_group');
});

it('separates a linked group into a Window and a section', () => {
  const linked = applyGroupOperation(section(windowOf('w', createWindowView('main', session('a'), 'primary'))),
    { type: 'bot.update', viewId: 'main', details: { label: 'Writer' } });
  const { kept, created } = splitGroup(linked, 'w-section');
  expect(kept).toEqual({ window: { ...linked.window, revision: 2 }, presentation: { bots: false } });
  expect(created).toEqual({ window: { ...linked.window, id: 'w-section', revision: 0 }, bots: linked.bots, presentation: { window: false } });
  expect(refusal(() => splitGroup(kept, 'again'))).toBe('not_linked');
  expect(refusal(() => splitGroup(linked, 'w'))).toBe('window_exists');
});

it('moves a bot with its attached views to another section', () => {
  const source = applyGroupOperation(section(windowOf('one', createWindowView('main', session('a'), 'primary'), createWindowView('dock', session('b')),
    { ...createWindowView('side', session('c'), 'attached'), attachedTo: 'dock' })), { type: 'bot.update', viewId: 'dock', details: { label: 'Reviewer' } });
  const target = section(windowOf('two', createWindowView('lead', session('d'), 'primary')));
  const moved = transferBot(source, target, 'dock');
  expect(moved.source.window.views.map(view => view.id)).toEqual(['main']);
  expect(moved.source.bots?.members).toEqual({});
  expect(moved.target.window.views.map(view => view.id)).toEqual(['lead', 'dock', 'side']);
  expect(moved.target.bots?.members).toEqual({ dock: { label: 'Reviewer' } });
  expect(refusal(() => transferBot(source, { window: target.window }, 'dock'))).toBe('section_missing');
  // A Side is a bot, but it cannot leave without the view it is attached to.
  expect(refusal(() => transferBot(source, target, 'side'))).toBe('bot_attached_elsewhere');
  expect(refusal(() => transferBot(source, target, 'missing'))).toBe('bot_not_found');
  expect(refusal(() => transferBot(source, source, 'dock'))).toBe('same_group');
  expect(moved.source.window.revision).toBe(source.window.revision + 1);
  expect(moved.target.window.revision).toBe(1);
  const asking = applyGroupOperation(section(windowOf('three', createWindowView('main', session('a'), 'primary'),
    { ...createWindowView('ask', session('e'), 'float'), closeWith: 'dock' }, createWindowView('dock', session('b')),
    { ...createWindowView('side', session('c'), 'attached'), attachedTo: 'dock' })),
    { type: 'batch', operations: [{ type: 'bot.update', viewId: 'dock', details: { label: 'Reviewer' } }, { type: 'bot.update', viewId: 'ask', details: { label: 'Asks' } }] });
  const carried = transferBot(asking, target, 'dock');
  expect(carried.source.window.views.map(view => view.id)).toEqual(['main']);
  expect(carried.target.window.views.map(view => view.id)).toEqual(['lead', 'dock', 'side', 'ask']);
  expect(carried.target.bots?.members).toEqual({ dock: { label: 'Reviewer' }, ask: { label: 'Asks' } });
  const tangled = section(windowOf('four', createWindowView('dock', session('b')), createWindowView('main', session('a'), 'primary'),
    { ...createWindowView('x', session('f'), 'attached'), attachedTo: 'main', closeWith: 'dock' }));
  expect(refusal(() => transferBot(tangled, target, 'dock'))).toBe('bot_attached_elsewhere');
});

it('reads the group a Window, a snapshot or a group describes', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  expect(toWindowGroup(window)).toEqual({ window });
  expect(toWindowGroup({ window, manager: { session: session('a'), generation: 1 } })).toEqual({ window });
  const group = section(window);
  expect(toWindowGroup(group)).toEqual(group);
  expect(toWindowGroup({ window, bots: group.bots, presentation: { window: false } })).toEqual({ ...group, presentation: { window: false } });
});

it('decodes a stored or transported group, including a Window saved before groups', () => {
  const window = windowOf('w', createWindowView('main', session('a'), 'primary'));
  const group = { ...section(window), presentation: { window: false } as const };
  expect(decodeWindowGroup(JSON.parse(JSON.stringify(window)))).toEqual({ window });
  expect(decodeWindowGroup(JSON.parse(JSON.stringify(group)))).toEqual(group);
  expect(decodeWindowGroup({ window, manager: { session: session('a'), generation: 1 } })).toEqual({ window });
  expect(decodeWindowGroup({ window, bots: { rank: '', members: {} } })).toBeUndefined();
  expect(decodeWindowGroup({ window, bots: { rank: 'm', members: { missing: {} } } })).toBeUndefined();
  expect(decodeWindowGroup({ window: { ...window, views: [] } })).toBeUndefined();
  expect(decodeWindowGroup(undefined)).toBeUndefined();
});

it('accepts every group operation and refuses anything else', () => {
  expect(isWindowGroupOperation({ type: 'bots.add', rank: 'm' })).toBe(true);
  expect(isWindowGroupOperation({ type: 'rename', title: 'Release' })).toBe(true);
  expect(isWindowGroupOperation({ type: 'batch', operations: [{ type: 'bots.add', rank: 'm' }, { type: 'rename', title: 'Release' }] })).toBe(true);
  expect(isWindowGroupOperation({ type: 'bots.add' })).toBe(false);
  expect(isWindowGroupOperation({ type: 'delete' })).toBe(false);
  expect(isWindowGroupOperation(undefined)).toBe(false);
});
