import { act, useReducer } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import { render } from '../test/setup.js';
import { WindowWorkspaces } from './WindowWorkspaces.js';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  let window: WorkspaceWindow = { schemaVersion: 2, id: 'window', title: 'Project', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] };
  let rejectSave!: (error: Error) => void;
  const saved = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  let redraw!: () => void, rejectLocal = false;
  let saveState = { state: 'saving' as 'saving' | 'offline' | 'error', pending: 1, error: undefined as string | undefined };
  const retry = vi.fn(async () => {});
  const discard = vi.fn(() => saved);
  function Harness() {
    const [, update] = useReducer(value => value + 1, 0); redraw = update;
    const workspace = { window, windows: [window], hasActiveWindow: true, unavailable: false, saveState,
      retrySave: retry, discardLocalChanges: discard, open: async () => {}, create: async () => {}, remove: async () => {},
      operate(operation: WindowOperation) {
        if (rejectLocal) throw new Error('This Window cannot be edited.');
        window = applyWindowOperation(window, operation); update(); return saved;
      },
    } as unknown as ReturnType<typeof useWindowWorkspace>;
    return <WindowWorkspaces workspace={workspace} />;
  }
  const container = await render(<Harness />);
  const button = (title: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === title)!;
  return { container, button, read: () => window, retry, discard, rejectSave,
    rejectLocal: () => { rejectLocal = true; },
    async offline() { await act(async () => { saveState = { state: 'offline', pending: 1, error: 'Network unavailable' }; redraw(); }); },
    async unsettled() { await act(async () => { saveState = { state: 'error', pending: 1, error: 'The save receipt expired' }; redraw(); }); },
  };
}

it('keeps pane controls available and closes rename immediately while layout saves remain pending', async () => {
  const test = await fixture();
  await act(async () => test.button('New session view').click());
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
  expect(test.button('New session view').disabled).toBe(false);
  await act(async () => test.container.querySelector<HTMLButtonElement>('[data-window-view-id="main"]')!.click());
  expect(test.read().selectedViewId).toBe('main');
  await act(async () => test.button('Rename Window').click());
  const input = test.container.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => test.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(test.read().title).toBe('Renamed');
  expect(test.container.querySelector('form')).toBeNull();
  expect(test.button('New session view').disabled).toBe(false);
  expect(test.container.textContent).toContain('Saving');
});

it('preserves local pane edits and exposes a save retry while offline', async () => {
  const test = await fixture();
  await act(async () => test.button('New session view').click());
  await test.offline();
  expect(test.container.textContent).toContain('not saved');
  expect(test.button('New session view').disabled).toBe(false);
  await act(async () => test.button('Retry').click());
  expect(test.retry).toHaveBeenCalledOnce();
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
  await act(async () => test.rejectSave(new Error('The server refused this change.')));
  expect(test.container.textContent).toContain('The server refused this change.');
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
});

it('keeps the rename form open when local validation rejects the operation', async () => {
  const test = await fixture();
  await act(async () => test.button('Rename Window').click());
  const input = test.container.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Rejected');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  test.rejectLocal();
  await act(async () => test.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(test.read().title).toBe('Project');
  expect(test.container.querySelector('form')).not.toBeNull();
  expect(test.container.textContent).toContain('This Window cannot be edited.');
});

it('offers an explicit saved-layout fallback without blocking pane edits during recovery', async () => {
  const test = await fixture();
  await test.unsettled();
  const fallback = test.button('Use saved layout');
  expect(fallback).toBeDefined();
  expect(fallback.title).toContain('Discard unsaved local layout edits');
  await act(async () => fallback.click());
  expect(test.discard).toHaveBeenCalledOnce();
  expect(test.button('New session view').disabled).toBe(false);
  await act(async () => test.button('New session view').click());
  expect(test.container.querySelectorAll('[data-window-view-id]')).toHaveLength(2);
});
