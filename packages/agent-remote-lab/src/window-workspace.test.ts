import { describe, expect, it } from 'vitest';
import { applyGroupOperation, createWindowView, type WindowGroup, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowWorkspaceStore } from './window-workspace.js';
const initial = (): WorkspaceWindow => ({ schemaVersion: 3, id: 'window-test', title: 'Test', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] });
describe('Window shared store', () => {
  it('serializes commands and preserves stable view identities without native connections', async () => {
    const store = new WindowWorkspaceStore(initial());
    await Promise.all([store.operate({ type: 'view.create', view: createWindowView('empty') }), store.operate({ type: 'view.select', viewId: 'empty' }), store.operate({ type: 'view.resize', viewId: 'empty', width: 620 })]);
    expect(store.getSnapshot()).toMatchObject({ revision: 3, selectedViewId: 'empty', views: [{ id: 'main' }, { id: 'empty', width: 620 }] });
  });
  it('does not let an older cache overwrite a committed revision', async () => {
    const store = new WindowWorkspaceStore(initial());
    await store.operate({ type: 'rename', title: 'Committed' }); store.accept(initial());
    expect(store.getSnapshot().title).toBe('Committed');
  });
  it('failed layout changes leave the observable document unchanged', async () => {
    const store = new WindowWorkspaceStore(initial()); const before = store.getSnapshot();
    await expect(store.operate({ type: 'view.close', viewId: 'missing' })).rejects.toThrow();
    expect(store.getSnapshot()).toBe(before);
  });
});

it('imports legacy layout once without copying native content or losing offline references', async () => {
  const { importCompositionWindow } = await import('./window-workspace.js');
  const { createCompositionDocument, createCompositionSlot } = await import('./session-composition.js');
  const document = createCompositionDocument('migration');
  const target = { hostId: 'offline-host', providerId: 'codex', nativeSessionId: 'native', title: 'Offline' };
  const slot = createCompositionSlot('slot', target, 'migration'); document.slots.push(slot); document.primary = slot.id;
  document.windows = [{ id: 'view:stable', slotId: slot.id }, { id: 'view:empty' }];
  sessionStorage.setItem('agent-remote:recovery:migration:workspace-dock', JSON.stringify({ panes: [{ id: 'view:empty', width: 650 }, { id: 'view:stable', width: 510 }], mainMinimized: true }));
  const window = importCompositionWindow(document);
  expect(window.views.map(view => view.id)).toEqual(['main', 'view:empty', 'view:stable']);
  expect(window.views[1]).toMatchObject({ width: 650, placement: 'dock' });
  expect(window.views[2]?.binding).toEqual(target);
  expect(window.views.find(view => view.id === window.selectedPrimaryViewId)?.collapsed).toBe(true);
  expect(JSON.stringify(window)).not.toContain('owners');
});

it('settles a lost mutation reply by its original receipt without reissuing the command', async () => {
  const { applyWindowOperation } = await import('@orchardworks/agent-remote-protocol');
  let current = initial(), mutations = 0;
  const client = {
    async mutate(_id: string, input: any) { mutations++; current = applyWindowOperation(current, input.operation); throw new Error('Connection closed after commit'); },
    async operation(_id: string, operationId: string) { return { operationId, status: 'committed' as const, revision: current.revision, committedAt: 1, expiresAt: 100 }; },
    async inspect() { return { window: current }; },
  };
  const store = new WindowWorkspaceStore(initial(), client as any);
  await store.operate({ type: 'view.create', view: createWindowView('only-once') });
  expect(mutations).toBe(1); expect(store.getSnapshot().views).toHaveLength(2);
});

it('keeps later local edits available while an earlier mutation is unresolved', async () => {
  let mutations = 0;
  const client = { async mutate() { mutations++; throw new Error('Offline'); }, async operation() { throw new Error('Offline'); } };
  const store = new WindowWorkspaceStore(initial(), client as any);
  void store.operate({ type: 'rename', title: 'Uncertain' });
  await store.retry();
  void store.operate({ type: 'rename', title: 'Later' });
  expect(store.getSnapshot().title).toBe('Later');
  expect(store.getSyncState()).toMatchObject({ state: 'offline', pending: 2 });
  expect(mutations).toBe(1);
  store.dispose();
});

it('rejects a queued stale full layout instead of overwriting an earlier local edit', async () => {
  const window = initial(); const store = new WindowWorkspaceStore(window);
  const rename = store.operate({ type: 'rename', title: 'New' });
  const { schemaVersion: _schema, id: _id, revision: _revision, ...layout } = window;
  const replace = store.operate({ type: 'layout.apply', layout });
  await rename; await expect(replace).rejects.toThrow('changed');
  expect(store.getSnapshot().title).toBe('New');
});

it('migrates Team members from composition and legacy snapshots with stable roster identities', async () => {
  const { importCompositionWindow } = await import('./window-workspace.js');
  const { createCompositionDocument, createCompositionSlot } = await import('./session-composition.js');
  const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'retired', title: 'Member', teamId: 'team', teamMemberId: 'member' };
  const slot = createCompositionSlot('team-slot', target, 'team-migration');
  const document = createCompositionDocument('team-migration', [slot]);
  document.windows = [{ id: 'leader', groupId: 'team', managed: true }, { id: 'member', slotId: slot.id, closeWith: 'leader', managed: true, teamMemberId: 'member' }];
  expect(importCompositionWindow(document).views.find(view => view.id === 'member')?.feature).toMatchObject({ kind: 'team', id: 'team', metadata: { memberId: 'member', role: 'member' } });
  const legacy = createCompositionDocument('legacy-team-migration');
  const root = { ...target, nativeSessionId: 'leader', teamMemberId: 'leader' };
  sessionStorage.setItem('agent-remote:recovery:legacy-team-migration:session-windows', JSON.stringify([
    { target: root, groupId: 'team' }, { target, closeWith: `session:${JSON.stringify(['host', 'recorded', 'leader'])}` },
  ]));
  const migrated = importCompositionWindow(legacy);
  expect(migrated.views.find(view => view.binding?.nativeSessionId === 'retired')?.feature).toMatchObject({ kind: 'team', id: 'team', metadata: { memberId: 'member', role: 'member' } });
});

it('leaves failed import candidates unclaimed and claims only a committed Window', async () => {
  const { importCompositionWindow, commitImportedWindowComposition } = await import('./window-workspace.js');
  const { createCompositionDocument, createCompositionSlot, createAskOwner } = await import('./session-composition.js');
  const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'source', title: 'Source' };
  const source = createCompositionSlot('native-source', target, 'candidate-import');
  const document = createCompositionDocument('candidate-import', [source]);
  document.asks.push(createAskOwner(source, document.scope));
  const before = JSON.stringify(document);
  const rejected = importCompositionWindow(document);
  expect(JSON.stringify(document)).toBe(before);
  const retry = importCompositionWindow(document);
  expect(retry.id).not.toBe(rejected.id);
  commitImportedWindowComposition(document, retry, JSON.parse(JSON.stringify(retry)));
  expect(document.windowBindings).toEqual([{ windowId: retry.id, viewId: 'main', bindingKey: JSON.stringify(['host', 'recorded', 'source']), slotId: source.id }]);
  expect(document.asks[0]!.sourceSlot).toBe(source.id);
});

it('restores a pending import mapping without claiming owners before creation settles', async () => {
  const { importCompositionWindow, captureImportedWindowComposition, restoreImportedWindowComposition, commitImportedWindowComposition } = await import('./window-workspace.js');
  const { createCompositionDocument, createCompositionSlot } = await import('./session-composition.js');
  const target = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'source', title: 'Source' };
  const source = createCompositionSlot('retained-source', target, 'retained-import');
  const document = createCompositionDocument('retained-import', [source]);
  const candidate = importCompositionWindow(document);
  const saved = JSON.parse(JSON.stringify({ candidate, bindings: captureImportedWindowComposition(candidate) }));
  restoreImportedWindowComposition(document, saved.candidate, saved.bindings);
  expect(document.windowBindings).toBeUndefined();
  commitImportedWindowComposition(document, saved.candidate);
  expect(document.windowBindings).toEqual([{ windowId: candidate.id, viewId: 'main', bindingKey: JSON.stringify(['host', 'recorded', 'source']), slotId: source.id }]);
  const other = importCompositionWindow(document);
  restoreImportedWindowComposition(document, other, [[source.id, 'main'], ['missing', 'main']]);
  commitImportedWindowComposition(document, other);
  expect(document.windowBindings).toHaveLength(1);
});

const bound = (): WorkspaceWindow => ({ ...initial(), views: [createWindowView('main', { hostId: 'mac', providerId: 'claude', nativeSessionId: 'one', title: 'One' }, 'primary')] });
const offline = { async mutate() { throw new Error('Offline'); }, async operation() { throw new Error('Offline'); } } as any;

it('applies a group edit at once and sends it with the next revision', async () => {
  const store = new WindowWorkspaceStore(bound());
  await store.operate({ type: 'bots.add', rank: 'm' });
  expect(store.getGroup().bots).toEqual({ rank: 'm', members: {} });
  expect(store.getSnapshot().revision).toBe(1);
  await store.operate({ type: 'bot.update', viewId: 'main', details: { label: 'Release' } });
  expect(store.getGroup().bots?.members).toEqual({ main: { label: 'Release' } });
  expect(store.getCommittedGroup()).toEqual(store.getGroup());
});

it('keeps a Window reading of a group it holds', async () => {
  const group: WindowGroup = { window: bound(), bots: { rank: 'm', members: { main: { pinned: true } } } };
  const store = new WindowWorkspaceStore(group);
  expect(store.getSnapshot()).toEqual(group.window);
  await store.operate({ type: 'rename', title: 'Renamed' });
  expect(store.getSnapshot().title).toBe('Renamed');
  expect(store.getGroup().bots).toEqual(group.bots);
});

it('adopts the appearances a snapshot carries and ignores an older one', () => {
  const store = new WindowWorkspaceStore(bound());
  const window = applyGroupOperation({ window: bound() }, { type: 'rename', title: 'Remote' }).window;
  store.accept({ window, bots: { rank: 'n', members: {} }, manager: { session: window.views[0]!.binding!, generation: 1 } });
  expect(store.getGroup()).toEqual({ window, bots: { rank: 'n', members: {} } });
  store.accept(bound());
  expect(store.getSnapshot().title).toBe('Remote');
});

it('recovers a journal written before groups and one written with them', async () => {
  const legacy = new WindowWorkspaceStore(bound(), undefined, undefined, undefined,
    { recovery: { version: 1, committed: bound(), edits: [{ operation: { type: 'rename', title: 'Pending' }, revision: 0 }] } });
  expect(legacy.getSnapshot().title).toBe('Pending');
  expect(legacy.getGroup().bots).toBeUndefined();
  let saved: unknown;
  const store = new WindowWorkspaceStore({ window: bound(), bots: { rank: 'm', members: {} } }, offline,
    undefined, undefined, { persist: value => { saved = value; } });
  void store.operate({ type: 'bot.update', viewId: 'main', details: { pinned: true } });
  await store.retry();
  expect(saved).toMatchObject({ version: 2, committed: { bots: { rank: 'm' } } });
  const restored = new WindowWorkspaceStore(bound(), undefined, undefined, undefined, { recovery: saved });
  expect(restored.getGroup().bots?.members).toEqual({ main: { pinned: true } });
  store.dispose();
});

it('keeps showing an appearance an echo already applied and settles the edit against it', async () => {
  const store = new WindowWorkspaceStore(bound());
  const pending = store.operate({ type: 'bots.add', rank: 'm' });
  store.accept({ window: store.getCommittedSnapshot(), bots: { rank: 'm', members: {} } });
  expect(store.getGroup().bots).toEqual({ rank: 'm', members: {} });
  expect(store.getSnapshot().revision).toBe(1);
  await expect(pending).rejects.toThrow('already a section');
  expect(store.getGroup()).toEqual({ window: store.getCommittedSnapshot(), bots: { rank: 'm', members: {} } });
});
