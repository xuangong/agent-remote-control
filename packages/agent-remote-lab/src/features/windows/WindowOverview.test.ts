import { expect, it } from 'vitest';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { windowThumbnail } from './WindowOverview.js';

const binding = (title: string) => ({ hostId: 'host', providerId: 'codex', nativeSessionId: title, title });

it('lays out a Window thumbnail in rail order, with attached views beside their parents and floating views counted', () => {
  const view = (id: string, placement: 'primary' | 'dock' | 'float' | 'attached', extra: Partial<WorkspaceWindow['views'][number]> = {}) =>
    ({ ...createWindowView(id, binding(id), placement), ...extra });
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'w', revision: 1, title: 'Work', selectedPrimaryViewId: 'main', selectedViewId: 'child', views: [
    view('dock', 'dock', { width: 600 }),
    view('child', 'attached', { attachedTo: 'main' }),
    view('float', 'float'),
    view('main', 'primary', { width: 800 }),
    view('folded', 'attached', { attachedTo: 'dock', collapsed: true }),
    { ...createWindowView('empty', undefined, 'dock') },
  ] };
  const { panes, floating } = windowThumbnail(window);
  expect(panes.map(pane => pane.id)).toEqual(['main', 'child', 'dock', 'folded', 'empty']);
  expect(panes.map(pane => pane.title)).toEqual(['main', 'child', 'dock', 'folded', 'Empty view']);
  expect(panes.find(pane => pane.selected)?.id).toBe('child');
  expect(panes.find(pane => pane.id === 'main')?.width).toBe(800);
  expect(panes.find(pane => pane.id === 'folded')).toMatchObject({ collapsed: true, attached: true, width: 44 });
  expect(panes.find(pane => pane.id === 'empty')?.providerId).toBeUndefined();
  expect(floating).toBe(1);
});
