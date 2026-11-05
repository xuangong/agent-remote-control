import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { WindowRequestError, type WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { WindowWorkspaceStore } from './window-workspace-store.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearLayoutDiagnostics, exportLayoutDiagnostics, getLayoutDiagnosticsStatus, recordKeyboardRefocus, recordWindowSelection, startLayoutDiagnostics, stopLayoutDiagnostics } from './layout-diagnostics.js';

function readReport() {
  const report = JSON.parse(exportLayoutDiagnostics());
  let previous = {};
  report.samples = report.samples.map((sample: Record<string, unknown>) => previous = { ...previous, ...sample });
  return report;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), {
    width: 390, height: 844, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
  }) });
  document.body.insertAdjacentHTML('beforeend', '<main class="lab-shell"><header class="lab-mobile-navigation">private session title</header><section class="lab-composer-dock"><textarea>private draft</textarea></section></main>');
});
afterEach(() => {
  clearLayoutDiagnostics();
  document.querySelector('.lab-shell')?.remove();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

it('records geometry only after opting in, retains it when stopped and clears it explicitly', () => {
  expect(getLayoutDiagnosticsStatus().recording).toBe(false);
  expect(readReport().samples).toEqual([]);
  startLayoutDiagnostics();
  Object.assign(window.visualViewport!, { height: 400, offsetTop: 44 });
  window.dispatchEvent(new Event('orientationchange'));
  vi.advanceTimersByTime(40);
  stopLayoutDiagnostics();
  const report = readReport();
  expect(report.samples.some((sample: any) => sample.viewport?.offsetTop === 44 && sample.viewport.height === 400)).toBe(true);
  expect(report.samples.some((sample: any) => sample.shell !== null && sample.header !== null && sample.composers.length === 1)).toBe(true);
  expect(exportLayoutDiagnostics()).not.toContain('private');
  expect(getLayoutDiagnosticsStatus().hasRecording).toBe(true);
  Object.assign(window.visualViewport!, { offsetTop: 88 });
  window.dispatchEvent(new Event('resize'));
  vi.advanceTimersByTime(4000);
  expect(readReport().samples).toEqual(report.samples);
  clearLayoutDiagnostics();
  expect(readReport().samples).toEqual([]);
  expect(getLayoutDiagnosticsStatus().hasRecording).toBe(false);
  expect(document.querySelector('[data-layout-safe-area-probe]')).toBeNull();
});

it('bounds retained samples and automatically stops instead of sampling indefinitely', () => {
  startLayoutDiagnostics();
  for (let i = 0; i < 1200; i++) {
    Object.assign(window.visualViewport!, { offsetTop: i });
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(17);
  }
  let report = readReport();
  expect(report.samples.length).toBeLessThanOrEqual(report.limits.maxSamples);
  expect(report.droppedSamples).toBeGreaterThan(0);
  expect(report.samples.at(-1).viewport.offsetTop).toBe(1199);
  vi.advanceTimersByTime(600_000);
  report = readReport();
  expect(getLayoutDiagnosticsStatus().recording).toBe(false);
  expect(report.stopReason).toBe('timeout');
  const count = report.samples.length;
  window.dispatchEvent(new Event('orientationchange'));
  vi.advanceTimersByTime(4000);
  expect(readReport().samples).toHaveLength(count);
});

it('stops frame sampling after settling and while hidden, then captures restoration', () => {
  startLayoutDiagnostics();
  vi.advanceTimersByTime(3500);
  const count = readReport().samples.length;
  vi.advanceTimersByTime(5000);
  expect(readReport().samples).toHaveLength(count);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  const hiddenCount = readReport().samples.length;
  vi.advanceTimersByTime(5000);
  expect(readReport().samples).toHaveLength(hiddenCount);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange'));
  expect(readReport().samples.at(-1).reason).toBe('visibilitychange');
  window.dispatchEvent(new Event('pagehide'));
  expect(getLayoutDiagnosticsStatus().recording).toBe(false);
});

it('records element focus and the shell asking the browser not to scroll', () => {
  startLayoutDiagnostics();
  document.querySelector('textarea')!.focus();
  recordKeyboardRefocus('focusin');
  stopLayoutDiagnostics();
  const reasons = readReport().samples.map((sample: any) => sample.reason);
  expect(reasons).toEqual(expect.arrayContaining(['focus', 'focusin', 'refocus-focusin']));
  expect(readReport().samples.at(-1).pageFocused).toEqual(expect.any(Boolean));
  expect(exportLayoutDiagnostics()).not.toContain('private');
});


it('records control events and anonymous pane selection without titles, drafts or identifiers', () => {
  const shell = document.querySelector('.lab-shell')!;
  shell.innerHTML = '<section class="lab-session-family-pane" data-view-id="private-primary-id" data-selected="true"><textarea>private primary draft</textarea></section><section class="lab-session-family-pane" data-view-id="private-side-id" hidden><button data-action-id="model" title="private model name">private label</button></section>';
  const panes = shell.querySelectorAll<HTMLElement>('.lab-session-family-pane');
  startLayoutDiagnostics();
  panes[0]!.hidden = true; panes[0]!.removeAttribute('data-selected');
  panes[1]!.hidden = false; panes[1]!.dataset.selected = 'true';
  const button = panes[1]!.querySelector('button')!;
  button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  panes[0]!.querySelector('textarea')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: button }));
  recordWindowSelection({ source: 'local', previous: 1, selected: 0, revision: 4, pending: 1, operation: 'view.select' });
  const report = readReport();
  const tap = report.samples.find((sample: any) => sample.reason === 'pointerdown');
  expect(tap.interaction.target).toMatchObject({ control: 'model', pane: 2, hidden: false });
  const focus = report.samples.findLast((sample: any) => sample.reason === 'focusin');
  expect(focus.interaction.target).toMatchObject({ control: 'editor', pane: 1, hidden: true });
  expect(focus.interaction.relatedTarget).toMatchObject({ control: 'model', pane: 2 });
  expect(report.samples.at(-1).selection).toEqual({ source: 'local', previous: 1, selected: 0, revision: 4, pending: 1, operation: 'view.select' });
  expect(exportLayoutDiagnostics()).not.toContain('private');
  stopLayoutDiagnostics();
  const count = readReport().samples.length;
  button.click();
  recordWindowSelection({ source: 'remote', previous: 0, selected: 1, revision: 5, pending: 0 });
  expect(readReport().samples).toHaveLength(count);
});


it('distinguishes local selection, a rejected save and a remote selection in the real Window store', async () => {
  const primary = createWindowView('private-primary', undefined, 'primary');
  const side = { ...createWindowView('private-side', undefined, 'attached'), attachedTo: primary.id };
  const initial: WorkspaceWindow = { schemaVersion: 3, id: 'private-window', title: 'private title', revision: 0,
    selectedPrimaryViewId: primary.id, selectedViewId: primary.id, views: [primary, side] };
  const client = { mutate: async () => { throw new WindowRequestError('private server error', 403); } } as unknown as WindowWorkspaceClient;
  const store = new WindowWorkspaceStore(initial, client, undefined, undefined, { paused: true });
  try {
    startLayoutDiagnostics();
    const pending = store.operate({ type: 'view.select', viewId: side.id });
    const rejected = expect(pending).rejects.toThrow('private server error');
    store.setEnabled(true);
    await rejected;
    store.accept(applyWindowOperation(initial, { type: 'view.select', viewId: side.id }));
    const changes = readReport().samples.filter((sample: any) => sample.reason === 'window-selection').map((sample: any) => sample.selection);
    expect(changes).toEqual([
      { source: 'local', previous: 0, selected: 1, revision: 1, pending: 1, operation: 'view.select', window: 1 },
      { source: 'rejected', previous: 1, selected: 0, revision: 0, pending: 0, operation: 'view.select', window: 1 },
      { source: 'remote', previous: 0, selected: 1, revision: 1, pending: 0, window: 1 },
    ]);
    expect(exportLayoutDiagnostics()).not.toContain('private');
  } finally { store.dispose(); }
});


it('keeps Window notifications and commit settlement working when diagnostic measurement fails', async () => {
  const initial: WorkspaceWindow = { schemaVersion: 3, id: 'window', title: 'Window', revision: 0,
    selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary'), createWindowView('side')] };
  const store = new WindowWorkspaceStore(initial);
  const notified = vi.fn(); store.subscribe(notified);
  startLayoutDiagnostics();
  const measurement = vi.spyOn(document.querySelector('.lab-shell')!, 'getBoundingClientRect').mockImplementationOnce(() => { throw new Error('Measurement unavailable'); });
  try {
    await expect(store.operate({ type: 'view.select', viewId: 'side' })).resolves.toBeUndefined();
    expect(notified).toHaveBeenCalled();
    expect(store.getCommittedSnapshot().selectedViewId).toBe('side');
    expect(store.getSyncState()).toEqual({ state: 'saved', pending: 0 });
  } finally { measurement.mockRestore(); store.dispose(); }
});

it('records a conflict snapshot that removes the optimistically selected Side', async () => {
  const initial: WorkspaceWindow = { schemaVersion: 3, id: 'window', title: 'Window', revision: 0,
    selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary'), createWindowView('side')] };
  const remote = applyWindowOperation(initial, { type: 'view.close', viewId: 'side' });
  const client = { mutate: async () => ({ window: remote, result: { status: 'rejected', code: 'revision_conflict' } }) } as unknown as WindowWorkspaceClient;
  const store = new WindowWorkspaceStore(initial, client);
  try {
    startLayoutDiagnostics();
    await expect(store.operate({ type: 'view.select', viewId: 'side' })).rejects.toThrow();
    const changes = readReport().samples.filter((sample: any) => sample.reason === 'window-selection').map((sample: any) => sample.selection);
    expect(changes.map((change: any) => [change.source, change.previous, change.selected])).toEqual([['local', 0, 1], ['conflict', 1, 0]]);
    expect(store.getSnapshot().selectedViewId).toBe('main');
  } finally { store.dispose(); }
});
