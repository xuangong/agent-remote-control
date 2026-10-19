import { act, useEffect, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionDockProvider, SessionDockRail } from './SessionDock.js';

it('keeps every primary group mounted while selection, collapse and compact presentation change', async () => {
  const mounts = new Map<string, number>();
  const resized = vi.fn(), collapsed = vi.fn(), selected = vi.fn();
  let select!: (id: string) => void, compact!: (value: boolean) => void, collapse!: (value: boolean) => void;
  function Chat({ id }: { id: string }) { useEffect(() => { mounts.set(id, (mounts.get(id) ?? 0) + 1); }, [id]); return <textarea aria-label={`${id} draft`} defaultValue={id} />; }
  function Harness() {
    const [current, setCurrent] = useState('a'), [narrow, setNarrow] = useState(false), [minimized, setMinimized] = useState(false);
    select = setCurrent; compact = setNarrow; collapse = setMinimized;
    return <SessionDockProvider enabled={!narrow}><SessionDockRail compact={narrow} minimizedHeader={<button type="button" aria-label="View options">View</button>} primaryGroups={['a', 'b'].map(id => ({ id, title: id, width: 400, additionalWidth: id === 'a' ? 240 : 0, collapsed: id === 'a' && minimized, selected: id === current, content: <Chat id={id} /> }))}
      onSelectPrimaryGroup={selected} onResizePrimaryGroup={resized} onCollapsePrimaryGroup={collapsed} /></SessionDockProvider>;
  }
  const view = await render(<Harness />);
  const first = view.querySelector<HTMLTextAreaElement>('[aria-label="a draft"]')!;
  expect(first).not.toBeNull();
  const a = () => view.querySelector<HTMLElement>('[data-primary-group-id="a"]')!;
  expect(a().style.width).toBe('640px');
  expect(a().dataset.selected).toBe('true');
  await act(async () => a().dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(selected).toHaveBeenCalledWith('a');
  await act(async () => view.querySelector('[aria-label="a width"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(resized).toHaveBeenCalledWith('a', 410);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Minimize primary group: a"]')!.click());
  expect(collapsed).toHaveBeenCalledWith('a', true);
  await act(async () => collapse(true));
  expect(a().style.width).toBe('44px');
  expect(a().querySelector<HTMLElement>('.lab-primary-group-content')!.hidden).toBe(true);
  expect(a().querySelector('[aria-label="View options"]')?.closest('[hidden]')).toBeNull();
  expect(a().querySelector('[aria-label="View options"]')).not.toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Restore primary group: a"]')!.click());
  expect(collapsed).toHaveBeenCalledWith('a', false);
  await act(async () => { compact(true); select('b'); });
  expect(a().hidden).toBe(true);
  expect(view.querySelector<HTMLElement>('[data-primary-group-id="b"]')!.hidden).toBe(false);
  await act(async () => select('a'));
  expect(a().hidden).toBe(false);
  expect(a().querySelector<HTMLElement>('.lab-primary-group-content')!.hidden).toBe(false);
  expect(view.querySelector('[aria-label="a draft"]')).toBe(first);
  expect([...mounts.values()]).toEqual([1, 1]);
});

it('retains attached widths during a primary group resize preview and commits only its own width', async () => {
  const { WindowLayoutContext } = await import('../window-workspace-context.js');
  const { createWindowView } = await import('@orchardworks/agent-remote-protocol');
  const resized = vi.fn();
  const view = await render(<WindowLayoutContext.Provider value={{ window: { schemaVersion: 3, id: 'window', title: 'Window', revision: 0, selectedPrimaryViewId: 'a', selectedViewId: 'a', views: [createWindowView('a', undefined, 'primary')] }, operate() {} }}>
    <SessionDockRail primaryGroups={[{ id: 'a', title: 'A', width: 400, additionalWidth: 240, collapsed: false, selected: true, content: <div>Attached session</div> }]} onResizePrimaryGroup={resized} />
  </WindowLayoutContext.Provider>);
  const pane = view.querySelector<HTMLElement>('[data-primary-group-id="a"]')!;
  const separator = pane.querySelector<HTMLElement>('[role="separator"]')!;
  separator.setPointerCapture = () => {};
  separator.hasPointerCapture = () => false;
  await act(async () => separator.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100 })));
  await act(async () => separator.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 120 })));
  expect(pane.style.width).toBe('660px');
  expect(resized).not.toHaveBeenCalled();
  await act(async () => separator.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 120 })));
  expect(resized).toHaveBeenCalledTimes(1);
  expect(resized).toHaveBeenCalledWith('a', 420);
  expect(pane.style.width).toBe('640px');
});

it('does not change the selected view when using global controls inside a pane', async () => {
  const selected = vi.fn();
  const view = await render(<SessionDockProvider enabled><SessionDockRail
    primaryGroups={[{ id: 'a', title: 'A', width: 400, collapsed: false, selected: false,
      content: <div data-pane-selection-ignore><button type="button">View</button></div> }]}
    onSelectPrimaryGroup={selected} /></SessionDockProvider>);
  const button = view.querySelector<HTMLButtonElement>('button')!;
  await act(async () => { button.dispatchEvent(new Event('pointerdown', { bubbles: true })); button.focus(); });
  expect(selected).not.toHaveBeenCalled();
});

it('can close a minimized group without restoring or selecting it first', async () => {
  const selected = vi.fn(), closed = vi.fn();
  const view = await render(<SessionDockProvider enabled><SessionDockRail
    primaryGroups={[{ id: 'a', title: 'A', width: 400, collapsed: true, selected: false, content: <div>Conversation</div> }]}
    onSelectPrimaryGroup={selected} onClosePrimaryGroup={closed} /></SessionDockProvider>);
  const button = view.querySelector<HTMLButtonElement>('[aria-label="Close primary group: A"]')!;
  await act(async () => { button.dispatchEvent(new Event('pointerdown', { bubbles: true })); button.focus(); button.click(); });
  expect(closed).toHaveBeenCalledWith('a');
  expect(selected).not.toHaveBeenCalled();
});
