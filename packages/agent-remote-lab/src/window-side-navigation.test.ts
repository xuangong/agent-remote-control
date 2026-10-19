import { expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { sideWindowOperation } from './window-side-navigation.js';

const binding: WindowSessionBinding = { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' };
const target = { ...binding, nativeSessionId: 'side', title: 'Side' };
const source = { windowId: 'window', viewId: 'dock', binding };
function fixture(): WorkspaceWindow {
  return { schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'dock',
    views: [createWindowView('main', target, 'primary'), createWindowView('dock', binding)] };
}

it('opens a Side beside its source when another Pane already displays the target', () => {
  const window = fixture();
  const opened = applyWindowOperation(window, sideWindowOperation(window, source, target, 'child').operation);
  expect(opened.views.map(view => [view.id, view.attachedTo])).toEqual([['main', undefined], ['dock', undefined], ['child', 'dock']]);
  expect(opened.selectedViewId).toBe('child');
  const selected = sideWindowOperation(opened, source, target, 'duplicate');
  expect(selected).toEqual({ operation: { type: 'view.select', viewId: 'child' }, viewId: 'child' });
});

it('replaces only the source attached branch and keeps independent panes', () => {
  const window = fixture();
  window.views.push({ ...createWindowView('previous', { ...target, nativeSessionId: 'previous' }, 'attached'), attachedTo: 'dock' },
    { ...createWindowView('leaf', target, 'attached'), attachedTo: 'previous' }, createWindowView('independent', target));
  const opened = applyWindowOperation(window, sideWindowOperation(window, source, target, 'child').operation);
  expect(opened.views.map(view => view.id)).toEqual(['main', 'dock', 'child', 'independent']);
});

it.each(['closed', 'rebound', 'history', 'window', 'missing'] as const)('rejects an async Side result after its source is %s', change => {
  const window = fixture();
  if (change === 'closed') window.views.pop();
  if (change === 'rebound') window.views[1]!.binding = { ...binding, nativeSessionId: 'replacement' };
  if (change === 'history') window.views[1]!.binding = { ...binding, sessionIntent: 'history' };
  if (change === 'window') window.id = 'other-window';
  expect(() => sideWindowOperation(change === 'missing' ? undefined : window, source, target, 'child')).toThrow('source view changed');
});
