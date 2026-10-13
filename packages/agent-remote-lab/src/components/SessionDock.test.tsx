import { act, StrictMode, useEffect, useState } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionDockProvider, SessionDockRail, SessionViewPlacement, MinimizeMainSession } from './SessionDock.js';

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

it('restores workspace dock order and widths after reload, including late mounted views', async () => {
  let reload!: () => void, reveal!: () => void;
  function Workspace() {
    const [late, setLate] = useState(false); reveal = () => setLate(true);
    return <SessionDockProvider enabled storageScope="dock-reload"><SessionDockRail mainTitle="Project"><MinimizeMainSession />Main</SessionDockRail>
      {(late ? ['one', 'two'] : ['one']).map(id => <SessionViewPlacement key={id} id={id} title={id} visible>{({ controls }) => controls}</SessionViewPlacement>)}
    </SessionDockProvider>;
  }
  function Harness() { const [revision, setRevision] = useState(0); reload = () => setRevision(v => v + 1); return <Workspace key={revision} />; }
  const view = await render(<Harness />);
  await act(async () => reveal());
  for (const id of ['one', 'two']) await act(async () => view.querySelector<HTMLButtonElement>(`[aria-label="Dock ${id}"]`)!.click());
  await act(async () => view.querySelector('[aria-label="Move two"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
  await act(async () => view.querySelector('[aria-label="one width"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Minimize main session area"]')!.click());
  await act(async () => reload());
  expect(view.querySelector<HTMLElement>('.lab-session-dock-main-content')?.hidden).toBe(true);
  expect(view.querySelector<HTMLElement>('[data-dock-id="one"]')?.style.width).toBe('450px');
  await act(async () => reveal());
  expect(Number(view.querySelector<HTMLElement>('[data-dock-id="two"]')?.style.order)).toBeLessThan(Number(view.querySelector<HTMLElement>('[data-dock-id="one"]')?.style.order));
});

it('ignores corrupt saved placement while keeping docking available', async () => {
  sessionStorage.setItem('agent-remote:recovery:corrupt:workspace-dock', '{broken');
  const view = await render(<SessionDockProvider enabled storageScope="corrupt"><SessionDockRail>Main</SessionDockRail>
    <SessionViewPlacement id="one" title="one" visible>{({ controls }) => controls}</SessionViewPlacement>
  </SessionDockProvider>);
  expect(view.querySelector('[data-dock-id]')).toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock one"]')!.click());
  expect(view.querySelector('[data-dock-id="one"]')).not.toBeNull();
});


it('minimizes the main composition without remounting it, restores on narrow screens and when the last dock closes', async () => {
  let enable!: (value: boolean) => void, show!: (value: boolean) => void, mount!: (value: boolean) => void;
  let mounts = 0;
  function Main() { useEffect(() => { mounts++; }, []); return <><MinimizeMainSession /><textarea defaultValue="Main draft" /><div>Child session</div></>; }
  function Harness() {
    const [enabled, setEnabled] = useState(true); enable = setEnabled;
    const [visible, setVisible] = useState(true); show = setVisible;
    const [mounted, setMounted] = useState(true); mount = setMounted;
    return <SessionDockProvider enabled={enabled}><SessionDockRail mainTitle="Project"><Main /></SessionDockRail>
      {mounted ? <SessionViewPlacement id="one" title="one" visible={visible}>{({ controls }) => <section hidden={!visible}>{controls}</section>}</SessionViewPlacement> : null}
    </SessionDockProvider>;
  }
  const view = await render(<Harness />);
  const button = () => view.querySelector<HTMLButtonElement>('[aria-label="Minimize main session area"]');
  expect(button()).toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock one"]')!.click());
  expect(button()).not.toBeNull();
  const input = view.querySelector('textarea')!;
  const content = () => view.querySelector<HTMLElement>('.lab-session-dock-main-content')!;
  await act(async () => button()!.click());
  expect(content().hidden).toBe(true);
  expect(view.querySelector('[aria-label="Restore main session: Project"]')).not.toBeNull();
  expect(view.querySelector('textarea')).toBe(input);
  expect(mounts).toBe(1);
  await act(async () => enable(false));
  expect(content().hidden).toBe(false);
  await act(async () => enable(true));
  expect(content().hidden).toBe(true);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Restore main session: Project"]')!.click());
  expect(content().hidden).toBe(false);
  expect(input.value).toBe('Main draft');
  await act(async () => button()!.click());
  await act(async () => show(false));
  expect(content().hidden).toBe(false);
  await act(async () => show(true));
  expect(content().hidden).toBe(false);
  await act(async () => button()!.click());
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Float one"]')!.click());
  expect(content().hidden).toBe(false);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock one"]')!.click());
  expect(content().hidden).toBe(false);
  await act(async () => button()!.click());
  await act(async () => mount(false));
  expect(content().hidden).toBe(false);
  await act(async () => mount(true));
  expect(content().hidden).toBe(false);
  expect(mounts).toBe(1);
});

it('moves an expanded session family as one dock without changing another dock or remounting it', async () => {
  let expand!: () => void;
  function Family() {
    const [width, setWidth] = useState(0); expand = () => setWidth(440);
    return <SessionViewPlacement id="family" title="Parent" visible dockRequest="open" additionalWidth={width}>
      {({ controls }) => <section>{controls}<input defaultValue="Parent draft" />{width ? <textarea defaultValue="Child draft" /> : null}</section>}
    </SessionViewPlacement>;
  }
  const view = await render(<SessionDockProvider enabled><SessionDockRail>Main</SessionDockRail><Family />
    <SessionViewPlacement id="other" title="Other" visible dockRequest="open">{({ controls }) => <section>{controls}<input defaultValue="Other draft" /></section>}</SessionViewPlacement>
  </SessionDockProvider>);
  const parent = view.querySelector('[data-dock-id="family"] input');
  await act(async () => expand());
  const family = view.querySelector<HTMLElement>('[data-dock-id="family"]')!;
  expect(family.style.width).toBe('880px');
  const child = family.querySelector('textarea');
  await act(async () => family.querySelector('[aria-label="Move Parent"]')!.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true})));
  expect(family.style.order).toBe('2');expect(family.querySelector('input')).toBe(parent);expect(family.querySelector('textarea')).toBe(child);
  await act(async () => family.querySelector<HTMLButtonElement>('[aria-label="Float Parent"]')!.click());
  expect(view.querySelectorAll('[data-dock-id]')).toHaveLength(1);expect(child?.isConnected).toBe(true);
});
