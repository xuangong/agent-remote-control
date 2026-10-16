import { describe, expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { attributionWindowOperation } from './session-attribution-navigation.js';

const binding = (nativeSessionId: string, hostId = 'mac') => ({ hostId, providerId: 'codex', nativeSessionId, title: nativeSessionId });
function layout() {
  const window: WorkspaceWindow = { schemaVersion: 2, id: 'window', title: 'Window', revision: 0,
    selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', binding('main'), 'primary')] };
  window.views.push(createWindowView('dock', binding('source')), createWindowView('other', binding('other')));
  return window;
}

describe('attribution navigation', () => {
  it('selects an existing matching session without replacing any pane', () => {
    const window = layout();
    const next = applyWindowOperation(window, attributionWindowOperation(window, { ...binding('source'), kind: 'session' }, 'Source', 'new'));
    expect(next.selectedViewId).toBe('dock');
    expect(next.views.map(view => [view.id, view.binding])).toEqual(window.views.map(view => [view.id, view.binding]));
  });
  it('opens a missing source in a new dock while keeping the current main and unrelated docks', () => {
    const window = layout();
    const next = applyWindowOperation(window, attributionWindowOperation(window, { ...binding('missing'), kind: 'session' }, 'Original discussion', 'new'));
    expect(next.views.slice(0, 3)).toEqual(window.views);
    expect(next.views.at(-1)).toMatchObject({ id: 'new', placement: 'dock', binding: { nativeSessionId: 'missing', title: 'Original discussion' } });
    expect(next.selectedViewId).toBe('new');
  });
  it('does not reuse a same-named session from another host or a pane rebound to another session', () => {
    const window = layout();
    window.views[1]!.binding = binding('source', 'windows');
    const next = applyWindowOperation(window, attributionWindowOperation(window, { ...binding('source'), kind: 'session' }, 'Source', 'new'));
    expect(next.selectedViewId).toBe('new');
    expect(next.views[1]!.binding!.hostId).toBe('windows');
  });
  it('prefers the selected duplicate and keeps historical source navigation fixed', () => {
    const window = layout();
    window.views.push(createWindowView('duplicate', binding('source')));
    window.selectedViewId = 'duplicate';
    expect(attributionWindowOperation(window, { ...binding('source'), kind: 'session' }, 'Source', 'new')).toEqual({ type: 'view.select', viewId: 'duplicate' });
    const next = applyWindowOperation(window, attributionWindowOperation(window, { ...binding('source'), kind: 'session', sessionIntent: 'history' }, 'Original', 'history'));
    expect(next.selectedViewId).toBe('history');
    expect(next.views.at(-1)!.binding!.sessionIntent).toBe('history');
  });
});
