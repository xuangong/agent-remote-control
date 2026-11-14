import { expect, it } from 'vitest';
import { applyGroupOperation, applyWindowOperation, createWindowView, type WindowGroup, type WindowGroupOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sessionKey } from './session-tree.js';
import { windowTitleEdits } from './window-titles.js';
import { WindowWorkspaceStore } from './window-workspace.js';

const binding = (nativeSessionId: string, title: string) => ({ hostId: 'host', providerId: 'claude', nativeSessionId, title });
const window = (...views: WorkspaceWindow['views']): WorkspaceWindow => ({ schemaVersion: 3, id: 'window', title: 'Window', revision: 0,
  selectedPrimaryViewId: views[0]!.id, selectedViewId: views[0]!.id, views });
const titles = (...entries: [string, string][]) => new Map(entries.map(([nativeSessionId, title]) => [sessionKey(binding(nativeSessionId, title)), title]));

it('renames ordinary views in place and only for the session they still show', () => {
  const initial = window(createWindowView('main', binding('created', 'New session'), 'primary'), createWindowView('dock', binding('named', 'Plan')),
    createWindowView('empty'));
  expect(windowTitleEdits(initial, titles(['created', 'Fix the build'], ['named', 'Plan'], ['elsewhere', 'Other']))).toEqual([
    { type: 'view.bind', viewId: 'main', binding: binding('created', 'Fix the build'), expectedBinding: binding('created', 'New session') },
  ]);
  expect(windowTitleEdits(initial, titles(['named', 'Plan']))).toEqual([]);
});

it('renames views an Ask, Team or TPM manages through one layout edit before the others', () => {
  const managed = { ...createWindowView('ask', binding('asked', 'Session'), 'float'), bindingPolicy: 'managed' as const };
  const initial = window(createWindowView('main', binding('created', 'New session'), 'primary'), managed);
  const [layout, ...rest] = windowTitleEdits(initial, titles(['created', 'Fix the build'], ['asked', 'Why is CI red?']));
  expect(layout!.type).toBe('layout.apply');
  expect(applyWindowOperation(initial, layout!).views.map(view => view.binding?.title)).toEqual(['New session', 'Why is CI red?']);
  expect(rest).toEqual([{ type: 'view.bind', viewId: 'main', binding: binding('created', 'Fix the build'), expectedBinding: binding('created', 'New session') }]);
});

it('applies a title that arrives while another edit of the Window is still saving', async () => {
  const initial = window(createWindowView('main', binding('created', 'New session'), 'primary'));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let commits = 0;
  const store = new WindowWorkspaceStore(initial, undefined, undefined, async (source: WindowGroup, operation: WindowGroupOperation) => {
    if (commits++ === 0) await held;
    return applyGroupOperation(source, operation);
  });
  // The page creates a view; the session's title arrives before that edit is saved.
  const created = store.operate({ type: 'view.create', view: createWindowView('dock', binding('docked', 'Notes')) });
  const renamed = windowTitleEdits(store.getSnapshot(), titles(['created', 'Fix the build'])).map(edit => store.operate(edit));
  release();
  await created; await Promise.all(renamed);
  expect(store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
  expect(store.getCommittedSnapshot().views.map(view => [view.id, view.binding?.title])).toEqual([['main', 'Fix the build'], ['dock', 'Notes']]);
});

it('leaves a view that was given another session meanwhile with that session', async () => {
  const initial = window(createWindowView('main', binding('created', 'New session'), 'primary'));
  const store = new WindowWorkspaceStore(initial);
  const [rename] = windowTitleEdits(initial, titles(['created', 'Fix the build']));
  await store.operate({ type: 'view.bind', viewId: 'main', binding: binding('other', 'Other') });
  await expect(store.operate(rename!)).rejects.toThrow('The target session view changed');
  expect(store.getCommittedSnapshot().views[0]!.binding).toEqual(binding('other', 'Other'));
});

it('renames a Window named after its primary session together with that session, and keeps any other title', () => {
  const named = { ...window(createWindowView('main', binding('created', 'New session'), 'primary'), createWindowView('dock', binding('docked', 'Notes'))), title: 'New session' };
  const bind = { type: 'view.bind', viewId: 'main', binding: binding('created', 'Fix the build'), expectedBinding: binding('created', 'New session') };
  expect(windowTitleEdits(named, titles(['created', 'Fix the build']))).toEqual([bind, { type: 'rename', title: 'Fix the build' }]);
  expect(windowTitleEdits({ ...named, title: 'Release' }, titles(['created', 'Fix the build']))).toEqual([bind]);
  // A docked session never names its Window.
  expect(windowTitleEdits({ ...named, title: 'Notes' }, titles(['docked', 'Meeting notes']))).toEqual([
    { type: 'view.bind', viewId: 'dock', binding: binding('docked', 'Meeting notes'), expectedBinding: binding('docked', 'Notes') }]);
});
