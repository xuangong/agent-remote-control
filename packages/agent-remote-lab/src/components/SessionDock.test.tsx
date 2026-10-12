import { act, StrictMode, useEffect, useState } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionDockProvider, SessionDockRail, SessionViewPlacement } from './SessionDock.js';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => vi.unstubAllGlobals());
it('docks, reorders, resizes and floats existing view instances without losing drafts', async () => {
  let mounts = 0;
  function Chat() { const [draft, setDraft] = useState('Kept draft'); useEffect(() => { mounts++; }, []); return <textarea value={draft} onChange={event => setDraft(event.target.value)} />; }
  const view = await render(<SessionDockProvider enabled><SessionDockRail><div>Main and child</div></SessionDockRail>
    {['one', 'two'].map(id => <SessionViewPlacement key={id} id={id} title={id} visible>{({ controls }) => <section>{controls}<Chat /></section>}</SessionViewPlacement>)}
  </SessionDockProvider>);
  const firstInput = view.querySelector('textarea')!;
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock one"]')!.click());
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock two"]')!.click());
  const one = view.querySelector<HTMLElement>('[data-dock-id="one"]')!;
  const two = view.querySelector<HTMLElement>('[data-dock-id="two"]')!;
  expect(one.querySelector('textarea')).toBe(firstInput);
  expect(mounts).toBe(2);
  await act(async () => two.querySelector('[aria-label="Move two"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  expect(Number(two.style.order)).toBeLessThan(Number(one.style.order));
  const separator = one.querySelector('[role="separator"]')!;
  await act(async () => separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(separator.getAttribute('aria-valuenow')).toBe('450');
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Float one"]')!.click());
  expect(view.querySelector('[data-dock-id="one"]')).toBeNull();
  expect(view.querySelectorAll('textarea')).toHaveLength(2);
  expect(firstInput.value).toBe('Kept draft');
  expect(mounts).toBe(2);
});
it('temporarily returns docked views to mobile presentation and preserves desktop order', async () => {
  let enable!: (value: boolean) => void, show!: (value: boolean) => void;
  function Harness() {
    const [enabled, setEnabled] = useState(true); enable = setEnabled;
    const [visible, setVisible] = useState(true); show = setVisible;
    return <SessionDockProvider enabled={enabled}><SessionDockRail><div>Main</div></SessionDockRail>
      <SessionViewPlacement id="one" title="one" visible={visible}>{({ controls }) => <section hidden={!visible}>{controls}<textarea defaultValue="Kept" /></section>}</SessionViewPlacement>
    </SessionDockProvider>;
  }
  const view = await render(<Harness />);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock one"]')!.click());
  const input = view.querySelector('textarea')!;
  await act(async () => enable(false));
  expect(view.querySelector('[data-dock-id]')).toBeNull();
  expect(view.querySelector('textarea')).toBe(input);
  expect(view.querySelector('[aria-label="Dock one"]')).toBeNull();
  await act(async () => enable(true));
  expect(view.querySelector('[data-dock-id="one"] textarea')).toBe(input);
  await act(async () => show(false));
  expect(view.querySelector('[data-dock-id="one"]')).toBeNull();
  await act(async () => show(true));
  expect(view.querySelector('[data-dock-id="one"] textarea')).toBe(input);
});

it('keeps its portal host connected through Strict Mode effect replay', async () => {
  const view = await render(<StrictMode><SessionDockProvider enabled><SessionDockRail><div>Main</div></SessionDockRail>
    <SessionViewPlacement id="strict" title="Strict" visible>{({ controls }) => <section>{controls}<input defaultValue="Retained" /></section>}</SessionViewPlacement>
  </SessionDockProvider></StrictMode>);
  const input = view.querySelector('input')!;
  expect(input?.isConnected).toBe(true);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock Strict"]')!.click());
  expect(view.querySelector('[data-dock-id="strict"] input')).toBe(input);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Float Strict"]')!.click());
  expect(input.isConnected).toBe(true);
});
