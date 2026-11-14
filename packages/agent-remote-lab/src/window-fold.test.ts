import { describe, expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowSessionBinding, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { foldOperation } from './window-fold.js';

const target = (id: string): WindowSessionBinding => ({ hostId: 'local', providerId: 'codex', nativeSessionId: id, title: id });
const view = (id: string, placement: WindowView['placement'], extra: Partial<WindowView> = {}): WindowView => ({ ...createWindowView(id, target(id), placement), ...extra });
function window(views: WindowView[], selectedViewId: string, selectedPrimaryViewId = selectedViewId): WorkspaceWindow {
  return { schemaVersion: 3, id: 'W', revision: 0, title: 'W', views, selectedViewId, selectedPrimaryViewId };
}
const fold = (source: WorkspaceWindow, viewId: string) => applyWindowOperation(source, foldOperation(source, viewId));

describe('foldOperation', () => {
  it('folds a pane that is not selected without moving the selection', () => {
    const result = fold(window([view('A', 'primary'), view('B', 'primary')], 'A'), 'B');
    expect(result.views.find(item => item.id === 'B')?.collapsed).toBe(true);
    expect(result.selectedViewId).toBe('A');
  });

  it('moves the selection from a folded primary group to the nearest open one, preferring the one before it', () => {
    const result = fold(window([view('A', 'primary'), view('B', 'primary'), view('C', 'primary')], 'B'), 'B');
    expect(result.views.find(item => item.id === 'B')?.collapsed).toBe(true);
    expect(result.selectedViewId).toBe('A');
    expect(result.selectedPrimaryViewId).toBe('A');
  });

  it('never unfolds another pane to move the selection', () => {
    const result = fold(window([view('A', 'primary', { collapsed: true }), view('B', 'primary'), view('C', 'primary')], 'B'), 'B');
    expect(result.selectedViewId).toBe('C');
    expect(result.views.find(item => item.id === 'A')?.collapsed).toBe(true);
  });

  it('keeps the selection on the last open pane when nothing else is open', () => {
    const result = fold(window([view('A', 'primary', { collapsed: true }), view('B', 'primary')], 'B'), 'B');
    expect(result.views.find(item => item.id === 'B')?.collapsed).toBe(true);
    expect(result.selectedViewId).toBe('B');
  });

  it('moves the selection from a folded Side, or anything in it, back to its source', () => {
    const views = [view('A', 'primary'), view('S', 'attached', { attachedTo: 'A' }), view('T', 'attached', { attachedTo: 'S' })];
    const result = fold(window(views, 'T', 'A'), 'S');
    expect(result.views.find(item => item.id === 'S')?.collapsed).toBe(true);
    expect(result.selectedViewId).toBe('A');
  });

  it('moves the selection to an open dock when no primary group is open', () => {
    const views = [view('A', 'primary'), view('S', 'attached', { attachedTo: 'A' }), view('D', 'dock', { collapsed: true }), view('E', 'dock')];
    const result = fold(window(views, 'S', 'A'), 'A');
    expect(result.views.find(item => item.id === 'A')?.collapsed).toBe(true);
    expect(result.selectedViewId).toBe('E');
  });

  it('moves the selection from a folded dock to the selected primary group', () => {
    const result = fold(window([view('A', 'primary'), view('B', 'primary'), view('D', 'dock')], 'D', 'B'), 'D');
    expect(result.views.find(item => item.id === 'D')?.collapsed).toBe(true);
    expect(result.selectedViewId).toBe('B');
  });
});
