import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpened, mockScope, renderHook } from '../test/render-hook.js';
import { usePrimaryFocus } from './usePrimaryFocus.js';

const root = buildOpened('root');

function panel() {
  const element = document.createElement('div');
  element.innerHTML = '<div class="lab-primary-conversation"><textarea></textarea></div><input class="elsewhere">';
  document.body.append(element);
  return element;
}

function scopeOf(workbenchPanel: HTMLElement | undefined, facts: Record<string, unknown> = {}) {
  return mockScope<typeof usePrimaryFocus>({
    activeView: 'workbench', compositionProtected: false, primaryExpanded: true, sessionWindows: { focus: vi.fn() }, setSideFocus: vi.fn(), sharedWindow: undefined, sideFocus: 'view-root',
    stackRoot: root, windowMode: true, workbenchPanelRef: { current: workbenchPanel }, ...facts,
  });
}

afterEach(() => { document.body.replaceChildren(); });

describe('focusing the primary conversation of a Window', () => {
  it('puts the cursor in its composer when it is expanded and focused', async () => {
    const element = panel();
    await renderHook(() => usePrimaryFocus(scopeOf(element)));
    expect(document.activeElement).toBe(element.querySelector('textarea'));
  });
  it('leaves the cursor where it already is inside the conversation', async () => {
    const element = panel();
    const inside = element.querySelector<HTMLElement>('.lab-primary-conversation')!;
    inside.tabIndex = 0; inside.focus();
    await renderHook(() => usePrimaryFocus(scopeOf(element)));
    expect(document.activeElement).toBe(inside);
  });
  it.each([
    ['outside Window mode', { windowMode: false }], ['with a shared Window', { sharedWindow: {} }], ['while the composition is protected', { compositionProtected: true }],
    ['while the primary is collapsed', { primaryExpanded: false }], ['when another session has the focus', { sideFocus: 'view-else' }], ['without a primary session', { stackRoot: undefined }],
    ['on the Trace page', { activeView: 'trace' }],
  ])('does not move the cursor %s', async (_name, change) => {
    const element = panel();
    await renderHook(() => usePrimaryFocus(scopeOf(element, change)));
    expect(document.activeElement).not.toBe(element.querySelector('textarea'));
  });
  it('does nothing without a panel', async () => {
    await renderHook(() => usePrimaryFocus(scopeOf(undefined)));
    expect(document.activeElement).toBe(document.body);
  });
});

describe('focusing a session', () => {
  it('focuses its Window and its view', async () => {
    const scope = scopeOf(undefined);
    const { result } = await renderHook(() => usePrimaryFocus(scope));
    result.current.focusSession(buildOpened('side'));
    expect(scope.sessionWindows.focus).toHaveBeenCalled();
    expect(scope.setSideFocus).toHaveBeenCalledWith('view-side');
  });
  it('focuses the primary session when its content is clicked', async () => {
    const scope = scopeOf(undefined);
    const { result } = await renderHook(() => usePrimaryFocus(scope));
    result.current.focusPrimaryContent(document.createElement('p'));
    expect(scope.setSideFocus).toHaveBeenCalledWith('view-root');
  });
  it.each(['lab-conversation-history', 'lab-session-heading-actions-trigger', 'lab-timeline-tools-toggle', 'lab-session-main-minimize'])('does not focus for a click inside a %s control', async name => {
    const scope = scopeOf(undefined);
    const { result } = await renderHook(() => usePrimaryFocus(scope));
    const control = document.createElement('div'); control.className = name;
    const inner = document.createElement('span'); control.append(inner);
    result.current.focusPrimaryContent(inner);
    expect(scope.sessionWindows.focus).not.toHaveBeenCalled();
    expect(scope.setSideFocus).not.toHaveBeenCalled();
  });
  it('does nothing outside Window mode', async () => {
    const scope = scopeOf(undefined, { windowMode: false });
    const { result } = await renderHook(() => usePrimaryFocus(scope));
    result.current.focusPrimaryContent(document.createElement('p'));
    expect(scope.sessionWindows.focus).not.toHaveBeenCalled();
  });
  it('focuses the Window without a view when there is no primary session', async () => {
    const scope = scopeOf(undefined, { stackRoot: undefined });
    const { result } = await renderHook(() => usePrimaryFocus(scope));
    result.current.focusPrimaryContent(document.createElement('p'));
    expect(scope.sessionWindows.focus).toHaveBeenCalled();
    expect(scope.setSideFocus).not.toHaveBeenCalled();
  });
});
