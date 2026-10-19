import { expect, it } from 'vitest';
import { isWorkspaceWindow, isWindowMutation, decodeWorkspaceWindow, primaryWindowViews, windowPrimaryViewId, type WorkspaceWindow } from './window-workspace.js';
import { applyWindowOperation, createWindowView } from './window-workspace-operations.js';

const binding = { hostId: 'mac', providerId: 'codex', nativeSessionId: 's1', title: 'Project' };
function workspace(): WorkspaceWindow {
  return { schemaVersion: 3, id: 'w1', title: 'Project', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', binding, 'primary'), createWindowView('dock')] };
}
it('retains explicit concrete history intent without changing default current-role bindings', () => {
  const original = workspace();
  const history = applyWindowOperation(original, { type: 'view.bind', viewId: 'main', binding: { ...binding, sessionIntent: 'history' } });
  expect(history.views[0]?.binding).toEqual({ ...binding, sessionIntent: 'history' });
  expect(decodeWorkspaceWindow(JSON.parse(JSON.stringify(history)))).toEqual(history);
  expect(applyWindowOperation(history, { type: 'view.bind', viewId: 'main', binding }).views[0]?.binding).toEqual(binding);
  expect(isWorkspaceWindow({ ...history, views: [{ ...history.views[0], binding: { ...binding, sessionIntent: 'current' } }] })).toBe(false);
});
it('keeps presentation identities independent of empty and replacement session bindings', () => {
  const original = workspace();
  const bound = applyWindowOperation(original, { type: 'view.bind', viewId: 'dock', binding });
  const replaced = applyWindowOperation(bound, { type: 'view.bind', viewId: 'main', binding: { ...binding, nativeSessionId: 's2' } });
  expect(original.views[1]?.binding).toBeUndefined();
  expect(replaced.views.map(view => view.id)).toEqual(['main', 'dock']);
  expect(replaced.views[1]?.binding?.nativeSessionId).toBe('s1');
  expect(replaced.revision).toBe(2);
});
it('binds only the captured empty or native target while allowing title and role metadata updates', () => {
  const original = workspace();
  const next = { ...binding, nativeSessionId: 'created' };
  const renamed = { ...binding, title: 'Renamed', role: { controllerId: 'controller', roleId: 'role', revision: 2 } };
  original.views[0]!.binding = renamed;
  const bound = applyWindowOperation(original, { type: 'view.bind', viewId: 'main', binding: next, expectedBinding: binding });
  expect(bound.views[0]?.binding).toEqual(next);
  expect(applyWindowOperation(original, { type: 'view.bind', viewId: 'dock', binding: next, expectedBinding: null }).views[1]?.binding).toEqual(next);
  expect(original.views[0]?.binding).toEqual(renamed);
});
it.each([
  null,
  { ...binding, hostId: 'other-host' },
  { ...binding, providerId: 'other-provider' },
  { ...binding, nativeSessionId: 'other-session' },
  { ...binding, sessionIntent: 'history' as const },
  { ...binding, parentNativeSessionId: 'other-parent' },
])('rejects a stale expected binding atomically: %j', expectedBinding => {
  const original = workspace();
  expect(() => applyWindowOperation(original, { type: 'batch', operations: [
    { type: 'rename', title: 'Should not commit' },
    { type: 'view.bind', viewId: 'main', binding: { ...binding, nativeSessionId: 'created' }, expectedBinding },
  ] })).toThrow('The target session view changed');
  expect(original.revision).toBe(0);
  expect(original.title).toBe('Project');
  expect(original.views[0]?.binding).toEqual(binding);
});
it('rejects an expected native binding for an empty view and validates its public mutation shape', () => {
  const operation = { type: 'view.bind' as const, viewId: 'dock', binding, expectedBinding: binding };
  expect(isWindowMutation({ operationId: 'guarded', issuedAt: 1, baseRevision: 0, operation })).toBe(true);
  expect(isWindowMutation({ operationId: 'guarded', issuedAt: 1, baseRevision: 0, operation: { ...operation, expectedBinding: {} } })).toBe(false);
  expect(() => applyWindowOperation(workspace(), operation)).toThrow('The target session view changed');
});
it('moves attached descendants with their source and rejects moving a child independently', () => {
  const w = workspace();
  w.views.push({ ...createWindowView('child', binding, 'attached'), attachedTo: 'dock' }, createWindowView('other'));
  const moved = applyWindowOperation(w, { type: 'view.move', viewId: 'dock', afterId: 'other' });
  expect(moved.views.map(view => view.id)).toEqual(['main', 'other', 'dock', 'child']);
  expect(() => applyWindowOperation(w, { type: 'view.move', viewId: 'child', afterId: 'other' })).toThrow();
  expect(w.views.map(view => view.id)).toEqual(['main', 'dock', 'child', 'other']);
});
it('closes a view family without removing its native session from unrelated views', () => {
  const w = workspace();
  w.views.push({ ...createWindowView('member', binding), closeWith: 'dock' }, { ...createWindowView('child', binding, 'attached'), attachedTo: 'member' });
  w.selectedViewId = 'child';
  const closed = applyWindowOperation(w, { type: 'view.close', viewId: 'dock' });
  expect(closed.views.map(view => view.id)).toEqual(['main']);
  expect(closed.selectedViewId).toBe('main');
  expect(closed.views[0]?.binding).toEqual(binding);
});
it('validates complete structure including primary, selected view, cycles and unknown properties', () => {
  const w = workspace();
  expect(isWorkspaceWindow(w)).toBe(true);
  expect(isWorkspaceWindow({ ...w, secret: 'invalid' })).toBe(false);
  expect(isWorkspaceWindow({ ...w, selectedViewId: 'missing' })).toBe(false);
  expect(isWorkspaceWindow({ ...w, views: [w.views[0], { ...w.views[1], placement: 'attached', attachedTo: 'dock' }] })).toBe(false);
  expect(isWindowMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'view.select', viewId: 'dock' } })).toBe(true);
  expect(isWindowMutation({ operationId: 'op', issuedAt: 1, baseRevision: 0, operation: { type: 'view.select', viewId: 'dock', extra: true } })).toBe(false);
});
it('commits a batch once, preserving source state when a later edit fails', () => {
  const w = workspace();
  const result = applyWindowOperation(w, { type: 'batch', operations: [
    { type: 'view.resize', viewId: 'dock', width: 600 }, { type: 'view.select', viewId: 'dock' },
  ] });
  expect(result).toMatchObject({ revision: 1, selectedViewId: 'dock' });
  expect(result.views[1]?.width).toBe(600);
  expect(() => applyWindowOperation(w, { type: 'batch', operations: [
    { type: 'rename', title: 'Changed' }, { type: 'view.close', viewId: 'missing' },
  ] })).toThrow();
  expect(w.title).toBe('Project'); expect(w.revision).toBe(0);
});
it('stores display and preferred float geometry without native metadata or transient connection state', () => {
  const w = applyWindowOperation(workspace(), { type: 'batch', operations: [
    { type: 'view.place', viewId: 'dock', placement: 'float' },
    { type: 'view.display', viewId: 'dock', display: { mode: 'content', lettersVisible: false } },
    { type: 'view.geometry', viewId: 'dock', geometry: { x: 40, y: 60, width: 500, height: 600 } },
  ] });
  expect(w.views[1]).toMatchObject({ placement: 'float', display: { mode: 'content', lettersVisible: false }, geometry: { x: 40, y: 60, width: 500, height: 600 } });
  const { schemaVersion: _, id: __, revision: ___, ...layout } = w;
  const restored = applyWindowOperation(workspace(), { type: 'layout.apply', layout });
  expect(restored.views).toEqual(w.views);
  expect(restored.id).toBe('w1');
});
it('replacing the main binding clears attached views and keeps independent dock views', () => {
  const w = workspace();
  w.views.splice(1, 0, { ...createWindowView('child', binding, 'attached'), attachedTo: 'main' });
  w.selectedViewId = 'child';
  const changed = applyWindowOperation(w, { type: 'view.bind', viewId: 'main', binding: { ...binding, nativeSessionId: 'next' } });
  expect(changed.views.map(view => view.id)).toEqual(['main', 'dock']);
  expect(changed.selectedViewId).toBe('main');
});
it('rejects interleaved families and dependency cycles in imported layouts', () => {
  const w = workspace();
  w.views.push(createWindowView('other'), { ...createWindowView('child', binding, 'attached'), attachedTo: 'dock' });
  expect(isWorkspaceWindow(w)).toBe(false);
  const cyclic = workspace();
  cyclic.views[1]!.closeWith = 'dock';
  expect(isWorkspaceWindow(cyclic)).toBe(false);
  const before = workspace();
  const { schemaVersion: _, id: __, revision: ___, ...layout } = w;
  expect(() => applyWindowOperation(before, { type: 'batch', operations: [
    { type: 'layout.apply', layout }, { type: 'view.move', viewId: 'dock', afterId: 'child' },
  ] })).toThrow();
  expect(before.revision).toBe(0);
});
it('validates shared dependency paths without repeatedly traversing their history', () => {
  const w = workspace();
  for (let i = 0; i < 50; i++) w.views.push({ ...createWindowView(`v${i}`), closeWith: i ? `v${i - 1}` : 'dock',
    feature: { kind: 'opaque', id: `tag${i}`, metadata: { sourceViewId: 'missing-is-only-metadata' } } });
  expect(isWorkspaceWindow(w)).toBe(true);
});
it('rejects two selected attached branches at one source instead of accepting an unrenderable layout', () => {
  const w = workspace();
  w.views.push({ ...createWindowView('one', binding, 'attached'), attachedTo: 'dock' }, { ...createWindowView('two', binding, 'attached'), attachedTo: 'dock' });
  expect(isWorkspaceWindow(w)).toBe(false);
});

it('retains optional stable Team member identity through layout serialization', () => {
  const w = workspace();
  w.views[1]!.feature = { kind: 'team', id: 'team', metadata: { memberId: 'member', role: 'member' } };
  expect(isWorkspaceWindow(JSON.parse(JSON.stringify(w)))).toBe(true);
  const { schemaVersion: _, id: __, revision: ___, ...layout } = w;
  const restored = applyWindowOperation(workspace(), { type: 'layout.apply', layout });
  expect(restored.views[1]?.feature).toEqual(w.views[1]?.feature);
  const legacy = workspace(); legacy.views[1]!.feature = { kind: 'team', id: 'team', metadata: { role: 'member' } };
  expect(isWorkspaceWindow(legacy)).toBe(true);
});

it('uses explicit binding policy independently of opaque feature metadata', () => {
  const w = workspace();
  w.views[1]!.feature = { kind: 'external-tool', id: 'tool', metadata: { role: 'managed', sourceViewId: 'main' } };
  const bound = applyWindowOperation(w, { type: 'view.bind', viewId: 'dock', binding });
  expect(bound.views[1]?.binding).toEqual(binding);
  const managed = workspace();
  managed.views[1]!.bindingPolicy = 'managed';
  expect(() => applyWindowOperation(managed, { type: 'view.bind', viewId: 'dock', binding })).toThrow(/managed binding/);
  expect(applyWindowOperation(managed, { type: 'view.display', viewId: 'dock', display: { mode: 'simple', lettersVisible: false } }).views[1]?.display.mode).toBe('simple');
});
it('only cascades closure through explicit lifecycle relationships', () => {
  const w = workspace();
  w.views.push({ ...createWindowView('tagged'), feature: { kind: 'ask', id: 'note', metadata: { sourceViewId: 'dock' } } });
  w.views.push({ ...createWindowView('dependent'), closeWith: 'dock' });
  const closed = applyWindowOperation(w, { type: 'view.close', viewId: 'dock' });
  expect(closed.views.map(view => view.id)).toEqual(['main', 'tagged']);
});
it('bounds opaque feature metadata without interpreting application names', () => {
  const valid = workspace();
  valid.views[1]!.feature = { kind: 'future-tool', id: 'external', metadata: { arbitrary: 'value' } };
  expect(isWorkspaceWindow(valid)).toBe(true);
  for (const metadata of [Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, 'value'])), { ['x'.repeat(65)]: 'value' }, { key: 'x'.repeat(4097) }]) {
    expect(isWorkspaceWindow({ ...valid, views: [valid.views[0], { ...valid.views[1], feature: { ...valid.views[1]!.feature, metadata } }] })).toBe(false);
  }
});

it('selects and closes primary groups independently while keeping standalone docks', () => {
  let w = applyWindowOperation(workspace(), { type: 'view.create', view: createWindowView('second', binding, 'primary') });
  w = applyWindowOperation(w, { type: 'view.create', view: { ...createWindowView('child', binding, 'attached'), attachedTo: 'second' } });
  w = applyWindowOperation(w, { type: 'view.create', view: { ...createWindowView('ask'), closeWith: 'second', feature: { kind: 'ask', id: 'ask' } } });
  expect(primaryWindowViews(w).map(view => view.id)).toEqual(['main', 'second']);
  expect(windowPrimaryViewId(w, 'child')).toBe('second');
  expect(windowPrimaryViewId(w, 'ask')).toBeUndefined();
  w = applyWindowOperation(w, { type: 'view.select', viewId: 'child' });
  expect(w.selectedPrimaryViewId).toBe('second');
  w = applyWindowOperation(w, { type: 'view.select', viewId: 'dock' });
  expect(w.selectedPrimaryViewId).toBe('second'); expect(w.selectedViewId).toBe('dock');
  w = applyWindowOperation(w, { type: 'view.collapse', viewId: 'second', collapsed: true });
  expect(w.views.find(view => view.id === 'second')?.collapsed).toBe(true);
  w = applyWindowOperation(w, { type: 'view.close', viewId: 'second' });
  expect(w.views.map(view => view.id)).toEqual(['main', 'dock']);
  expect(w.selectedPrimaryViewId).toBe('main'); expect(w.selectedViewId).toBe('dock');
  const standalone = applyWindowOperation(w, { type: 'view.close', viewId: 'main' });
  expect(standalone).toMatchObject({ selectedPrimaryViewId: null, selectedViewId: 'dock' });
  expect(standalone.views).toEqual([createWindowView('dock')]);
});
it('moves a primary with its attached chain and rebinds only that chain', () => {
  const w = workspace();
  w.views.push(createWindowView('second', binding, 'primary'), { ...createWindowView('child', binding, 'attached'), attachedTo: 'second' }, { ...createWindowView('ask'), closeWith: 'second' });
  const moved = applyWindowOperation(w, { type: 'view.move', viewId: 'second', afterId: 'main' });
  expect(moved.views.map(view => view.id)).toEqual(['main', 'second', 'child', 'dock', 'ask']);
  const rebound = applyWindowOperation(moved, { type: 'view.bind', viewId: 'second', binding: { ...binding, nativeSessionId: 'replacement' } });
  expect(rebound.views.map(view => view.id)).toEqual(['main', 'second', 'dock', 'ask']);
  expect(rebound.views.find(view => view.id === 'ask')?.closeWith).toBe('second');
});
it('migrates a v1 Window deterministically without changing its identities or revision', () => {
  const { selectedPrimaryViewId, ...base } = workspace();
  const legacy = { ...base, schemaVersion: 1, primaryViewId: selectedPrimaryViewId, mainMinimized: true };
  const migrated = decodeWorkspaceWindow(legacy)!;
  expect(migrated).toMatchObject({ schemaVersion: 3, id: 'w1', revision: 0, selectedPrimaryViewId: 'main' });
  expect(migrated.views[0]).toMatchObject({ id: 'main', collapsed: true });
  expect(migrated.views[1]).toEqual(legacy.views[1]);
  expect(decodeWorkspaceWindow(legacy)).toEqual(migrated);
  expect(legacy.views[0]?.collapsed).toBe(false);
  expect(decodeWorkspaceWindow({ ...legacy, selectedPrimaryViewId: 'dock' })).toBeUndefined();
});

it('closes the last pane without replacing the Window or creating a new pane', () => {
  const original = workspace();
  original.views = [original.views[0]!];
  const empty = applyWindowOperation(original, { type: 'view.close', viewId: 'main' });
  expect(empty).toEqual({ ...original, revision: 1, views: [], selectedViewId: null, selectedPrimaryViewId: null });
  expect(isWorkspaceWindow(empty)).toBe(true);
  expect(original.views[0]?.binding).toEqual(binding);
});

it.each(['dock', 'float', 'primary'] as const)('selects the first %s pane created in an empty Window', placement => {
  const empty: WorkspaceWindow = { ...workspace(), views: [], selectedViewId: null, selectedPrimaryViewId: null };
  const created = applyWindowOperation(empty, { type: 'view.create', view: { ...createWindowView('first', binding, placement), collapsed: true } });
  expect(created).toMatchObject({ id: empty.id, revision: 1, selectedViewId: 'first', selectedPrimaryViewId: placement === 'primary' ? 'first' : null });
  expect(created.views[0]).toMatchObject({ id: 'first', placement, collapsed: false });
  expect(applyWindowOperation(created, { type: 'view.create', view: createWindowView('next-primary', undefined, 'primary') }))
    .toMatchObject({ selectedViewId: 'first', selectedPrimaryViewId: placement === 'primary' ? 'first' : 'next-primary' });
});

it('selects a surviving attached ancestor before a closer sibling and expands the family', () => {
  const original = workspace();
  original.views.splice(1, 0,
    { ...createWindowView('child', binding, 'attached'), attachedTo: 'main', collapsed: true },
    { ...createWindowView('grandchild', binding, 'attached'), attachedTo: 'child' });
  original.views[0]!.collapsed = true;
  original.selectedViewId = 'grandchild';
  const closed = applyWindowOperation(original, { type: 'view.close', viewId: 'grandchild' });
  expect(closed).toMatchObject({ selectedViewId: 'child', selectedPrimaryViewId: 'main' });
  expect(closed.views.slice(0, 2).every(view => !view.collapsed)).toBe(true);
});

it.each(['select', 'close'] as const)('expands all attached dock ancestors when %s changes the exact selection', action => {
  const original = workspace();
  original.views[1]!.collapsed = true;
  original.views.push(
    { ...createWindowView('child', binding, 'attached'), attachedTo: 'dock', collapsed: true },
    { ...createWindowView('grandchild', binding, 'attached'), attachedTo: 'child' },
    { ...createWindowView('unrelated'), collapsed: true });
  if (action === 'close') original.selectedViewId = 'grandchild';
  const changed = applyWindowOperation(original, { type: action === 'close' ? 'view.close' : 'view.select', viewId: 'grandchild' });
  expect(changed).toMatchObject({ selectedViewId: action === 'close' ? 'child' : 'grandchild', selectedPrimaryViewId: 'main' });
  expect(changed.views.filter(view => ['dock', 'child'].includes(view.id)).every(view => !view.collapsed)).toBe(true);
  expect(changed.views.find(view => view.id === 'unrelated')?.collapsed).toBe(true);
});

it('selects the closest surviving preceding pane before the next pane in document order after cascaded closure', () => {
  const original = workspace();
  original.views.push(createWindowView('before'),
    { ...createWindowView('dependent'), closeWith: 'dock' }, createWindowView('after'));
  original.views[2]!.collapsed = true;
  original.selectedViewId = 'dependent';
  const closed = applyWindowOperation(original, { type: 'view.close', viewId: 'dock' });
  expect(closed.views.map(view => view.id)).toEqual(['main', 'before', 'after']);
  expect(closed).toMatchObject({ selectedViewId: 'before', selectedPrimaryViewId: 'main' });
  expect(closed.views[1]?.collapsed).toBe(false);

  const right = applyWindowOperation(workspace(), { type: 'view.close', viewId: 'main' });
  expect(right).toMatchObject({ selectedViewId: 'dock', selectedPrimaryViewId: null });
});

it('preserves an unrelated exact selection when its selected primary closes', () => {
  const original = workspace();
  original.views.push(createWindowView('second', undefined, 'primary'));
  original.selectedViewId = 'dock';
  const closed = applyWindowOperation(original, { type: 'view.close', viewId: 'main' });
  expect(closed).toMatchObject({ selectedViewId: 'dock', selectedPrimaryViewId: 'second' });
});

it('rebinds a non-primary root and returns its selected attached descendant to the root', () => {
  const original = workspace();
  original.views.push({ ...createWindowView('child', binding, 'attached'), attachedTo: 'dock' });
  original.selectedViewId = 'child';
  original.views[1]!.collapsed = true;
  const changed = applyWindowOperation(original, { type: 'view.bind', viewId: 'dock', binding });
  expect(changed).toMatchObject({ selectedViewId: 'dock', selectedPrimaryViewId: 'main' });
  expect(changed.views.map(view => view.id)).toEqual(['main', 'dock']);
  expect(changed.views[1]?.collapsed).toBe(false);
});

it('applies an empty layout with explicit null selections and permits close-then-create batches', () => {
  const emptyLayout = { title: 'Empty', views: [], selectedViewId: null, selectedPrimaryViewId: null };
  const empty = applyWindowOperation(workspace(), { type: 'layout.apply', layout: emptyLayout });
  expect(empty).toEqual({ ...emptyLayout, schemaVersion: 3, id: 'w1', revision: 1 });
  const original = workspace(); original.views = [original.views[0]!];
  const replaced = applyWindowOperation(original, { type: 'batch', operations: [
    { type: 'view.close', viewId: 'main' }, { type: 'view.create', view: createWindowView('replacement') },
  ] });
  expect(replaced).toMatchObject({ revision: 1, selectedViewId: 'replacement', selectedPrimaryViewId: null });
  expect(replaced.views.map(view => view.id)).toEqual(['replacement']);
});

it('validates nullable selections against actual pane and primary membership', () => {
  const empty: WorkspaceWindow = { ...workspace(), views: [], selectedViewId: null, selectedPrimaryViewId: null };
  expect(isWorkspaceWindow(empty)).toBe(true);
  expect(isWorkspaceWindow({ ...empty, selectedViewId: 'main' })).toBe(false);
  expect(isWorkspaceWindow({ ...empty, selectedPrimaryViewId: 'main' })).toBe(false);
  const { selectedViewId: _, ...missingSelection } = empty;
  expect(isWorkspaceWindow(missingSelection)).toBe(false);
  expect(isWorkspaceWindow({ ...workspace(), selectedViewId: null })).toBe(false);
  expect(isWorkspaceWindow({ ...workspace(), selectedPrimaryViewId: null })).toBe(false);
  expect(isWorkspaceWindow({ ...empty, selectedViewId: 'dock', views: [createWindowView('dock')] })).toBe(true);
  expect(isWorkspaceWindow({ ...empty, selectedViewId: 'dock', selectedPrimaryViewId: 'dock', views: [createWindowView('dock')] })).toBe(false);
});

it('migrates only valid v2 Windows while preserving identity, bindings and revision', () => {
  const legacy = { ...workspace(), schemaVersion: 2, revision: 7 };
  expect(decodeWorkspaceWindow(legacy)).toEqual({ ...legacy, schemaVersion: 3 });
  expect(legacy.schemaVersion).toBe(2);
  expect(decodeWorkspaceWindow({ ...legacy, views: [], selectedViewId: null, selectedPrimaryViewId: null })).toBeUndefined();
  expect(decodeWorkspaceWindow({ ...legacy, views: [createWindowView('dock')], selectedViewId: 'dock', selectedPrimaryViewId: null })).toBeUndefined();
  expect(decodeWorkspaceWindow({ ...legacy, selectedPrimaryViewId: 'dock' })).toBeUndefined();
});
