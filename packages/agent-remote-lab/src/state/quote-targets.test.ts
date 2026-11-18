// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildBinding, buildView, buildWindow } from '../test/window-builders.js';
import { quoteTargets } from './quote-targets.js';

const source = { viewId: 'S', session: buildBinding('s') };
const open = buildWindow([buildView('S', 'primary', { binding: buildBinding('s') }), buildView('D', 'dock'), buildView('F', 'float'), buildView('X', 'attached')], 'S', { id: 'open', title: '' });
const other = buildWindow([buildView('O1', 'primary')], 'O1', { id: 'other', title: 'Other' });
const empty = buildWindow([], undefined, { id: 'empty', title: 'Empty' });

describe('quote targets', () => {
  it('lists the open Window first, without the source, and labels each view by its placement', () => {
    const windows = quoteTargets([other, open], open, source);
    expect(windows.map(window => window.id)).toEqual(['open', 'other']);
    expect(windows[0]).toMatchObject({ title: 'Untitled Window', current: true });
    expect(windows[0]!.views).toEqual([
      { viewId: 'D', title: 'D', detail: 'Docked' }, { viewId: 'F', title: 'F', detail: 'Floating' }, { viewId: 'X', title: 'X', detail: 'Side' },
    ]);
    expect(windows[1]!.views).toEqual([{ viewId: 'O1', title: 'O1', detail: 'Main' }]);
  });

  it('lists a Window once even when the catalog also holds the open one', () => {
    expect(quoteTargets([open, open], open, source)).toHaveLength(1);
  });

  it('keeps the open Window without targets and drops other Windows without any', () => {
    const windows = quoteTargets([empty, buildWindow([buildView('S', 'primary')], 'S', { id: 'solo' })], buildWindow([], undefined, { id: 'cur' }), source);
    expect(windows.map(window => window.id)).toEqual(['cur']);
  });

  it('skips views of the same session, history and Ask children, and views without a session', () => {
    const window = buildWindow([
      buildView('same', 'dock', { binding: buildBinding('s') }),
      buildView('history', 'dock', { binding: buildBinding('h', { sessionIntent: 'history' }) }),
      buildView('child', 'dock', { binding: buildBinding('c', { parentNativeSessionId: 's' }) }),
      buildView('blank', 'dock', { binding: undefined }),
      buildView('ok', 'dock'),
    ], 'ok', { id: 'w' });
    expect(quoteTargets([], window, source)[0]!.views.map(view => view.viewId)).toEqual(['ok']);
  });

  it('titles an untitled session', () => {
    const window = buildWindow([buildView('u', 'dock', { binding: buildBinding('u', { title: '' }) })], 'u', { id: 'w' });
    expect(quoteTargets([], window, source)[0]!.views[0]!.title).toBe('Untitled session');
  });

  it('lists Team conversations but no other feature view', () => {
    const window = buildWindow([
      buildView('team', 'dock', { feature: { kind: 'team', id: 't', metadata: { role: 'leader' } } as never }),
      buildView('ask', 'dock', { feature: { kind: 'ask', id: 'k' } as never }),
      buildView('tpm', 'dock', { feature: { kind: 'tpm', id: 'p', metadata: { hostId: 'h' } } as never }),
    ], 'team', { id: 'w' });
    expect(quoteTargets([], window, source)[0]!.views.map(view => view.viewId)).toEqual(['team']);
  });
});
