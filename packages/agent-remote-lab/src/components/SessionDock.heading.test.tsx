import { act, useState, type ReactNode } from 'react';
import { applyWindowOperation, createWindowView, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { WindowLayoutContext } from '../window-workspace-context.js';
import { SessionDockHeadingStart, SessionDockProvider, SessionDockRail, SessionViewPlacement } from './SessionDock.js';
import { SessionHeading } from './SessionHeading.js';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }));
afterEach(() => vi.unstubAllGlobals());

const globalControls = <button type="button" aria-label="Global View options">View</button>;
const viewButton = '[aria-label="Global View options"]';

function Pane({ id, visible = true }: { id: string; visible?: boolean }) {
  return <SessionViewPlacement id={id} title={id} visible={visible}>{({ controls }) => <section hidden={!visible} data-test-pane={id}>
    <SessionHeading leading={<><SessionDockHeadingStart /><a href={`#${id}`}>Session link</a></>} trailing={controls}>{id}</SessionHeading>
    <textarea aria-label={`${id} draft`} defaultValue={`Draft for ${id}`} />
  </section>}</SessionViewPlacement>;
}

function sharedHarness(leadingControls?: ReactNode) {
  let operate!: (operation: WindowOperation) => void;
  let show!: (id: string, visible: boolean) => void;
  let enable!: (enabled: boolean) => void;
  function Harness() {
    const [window, setWindow] = useState<WorkspaceWindow>({ schemaVersion: 3, id: 'heading-window', revision: 0, title: 'Window',
      selectedPrimaryViewId: null, selectedViewId: 'a', views: [
        createWindowView('hidden', undefined, 'dock'), createWindowView('b', undefined, 'dock'),
        createWindowView('a', undefined, 'dock'), createWindowView('floating', undefined, 'float'),
      ] });
    const [visibility, setVisibility] = useState<Record<string, boolean>>({ hidden: false });
    const [enabled, setEnabled] = useState(true);
    operate = operation => setWindow(current => applyWindowOperation(current, operation));
    show = (id, visible) => setVisibility(current => ({ ...current, [id]: visible }));
    enable = setEnabled;
    return <WindowLayoutContext.Provider value={{ window, operate }}>
      <SessionDockProvider enabled={enabled} leadingControls={leadingControls}>
        <SessionDockRail primaryGroups={[]} />
        {['a', 'floating', 'hidden', 'b'].map(id => <Pane key={id} id={id} visible={visibility[id] !== false} />)}
      </SessionDockProvider>
    </WindowLayoutContext.Provider>;
  }
  return { Harness, operate: (operation: WindowOperation) => operate(operation), show: (id: string, visible: boolean) => show(id, visible), enable: (enabled: boolean) => enable(enabled) };
}

it('places global controls in the first visible shared dock heading, independent of registration order', async () => {
  const { Harness } = sharedHarness(globalControls);
  const view = await render(<Harness />);
  expect(view.querySelectorAll(viewButton)).toHaveLength(1);
  expect(view.querySelector(`[data-dock-id="b"] header ${viewButton}`)).not.toBeNull();
  expect(view.querySelector(`[data-test-pane="a"] ${viewButton}`)).toBeNull();
  expect(view.querySelector(`[data-test-pane="hidden"] ${viewButton}`)).toBeNull();
  expect(view.querySelector(`[data-test-pane="floating"] ${viewButton}`)).toBeNull();
  expect(view.querySelector('[data-dock-id="b"] header a')?.textContent).toBe('Session link');
}, 10000);

it('moves the controls with shared dock order while retaining both session view instances', async () => {
  const fixture = sharedHarness(globalControls);
  const view = await render(<fixture.Harness />);
  const firstDraft = view.querySelector('[aria-label="a draft"]');
  const secondDraft = view.querySelector('[aria-label="b draft"]');
  expect(view.querySelector(`[data-dock-id="b"] header ${viewButton}`)).not.toBeNull();
  await act(async () => fixture.operate({ type: 'view.move', viewId: 'b', afterId: 'a' }));
  expect(view.querySelectorAll(viewButton)).toHaveLength(1);
  expect(view.querySelector(`[data-dock-id="a"] header ${viewButton}`)).not.toBeNull();
  expect(view.querySelector(`[data-dock-id="b"] ${viewButton}`)).toBeNull();
  expect(view.querySelector('[aria-label="a draft"]')).toBe(firstDraft);
  expect(view.querySelector('[aria-label="b draft"]')).toBe(secondDraft);
}, 10000);

it('transfers the controls when a dock is hidden or floated and removes them when docking is unavailable', async () => {
  const fixture = sharedHarness(globalControls);
  const view = await render(<fixture.Harness />);
  await act(async () => fixture.show('b', false));
  expect(view.querySelectorAll(viewButton)).toHaveLength(1);
  expect(view.querySelector(`[data-dock-id="a"] header ${viewButton}`)).not.toBeNull();
  await act(async () => fixture.show('b', true));
  expect(view.querySelector(`[data-dock-id="b"] header ${viewButton}`)).not.toBeNull();
  await act(async () => fixture.operate({ type: 'view.place', viewId: 'b', placement: 'float' }));
  expect(view.querySelectorAll(viewButton)).toHaveLength(1);
  expect(view.querySelector(`[data-dock-id="a"] header ${viewButton}`)).not.toBeNull();
  expect(view.querySelector(`[data-test-pane="b"] ${viewButton}`)).toBeNull();
  await act(async () => fixture.enable(false));
  expect(view.querySelector(viewButton)).toBeNull();
  await act(async () => fixture.enable(true));
  expect(view.querySelector(`[data-dock-id="a"] header ${viewButton}`)).not.toBeNull();
  await act(async () => fixture.operate({ type: 'view.place', viewId: 'a', placement: 'float' }));
  expect(view.querySelector(viewButton)).toBeNull();
}, 10000);

it('leaves session heading content unchanged when no global controls are supplied', async () => {
  const { Harness } = sharedHarness();
  const view = await render(<Harness />);
  expect(view.querySelector(viewButton)).toBeNull();
  expect(view.querySelector('[data-dock-id="b"] header a')?.textContent).toBe('Session link');
  expect(view.querySelector('[data-dock-id="a"] header a')?.textContent).toBe('Session link');
  expect(view.querySelector('[aria-label="b draft"]')).not.toBeNull();
  expect(view.querySelector('[aria-label="a draft"]')).not.toBeNull();
}, 10000);

it('follows local dock order and returns the controls to the remaining dock after floating the first', async () => {
  const view = await render(<SessionDockProvider enabled leadingControls={globalControls}>
    <SessionDockRail primaryGroups={[]} /><Pane id="a" /><Pane id="b" />
  </SessionDockProvider>);
  expect(view.querySelector(viewButton)).toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock b"]')!.click());
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Dock a"]')!.click());
  expect(view.querySelectorAll(viewButton)).toHaveLength(1);
  expect(view.querySelector(`[data-dock-id="b"] header ${viewButton}`)).not.toBeNull();
  await act(async () => view.querySelector('[aria-label="Move b"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })));
  expect(view.querySelectorAll(viewButton)).toHaveLength(1);
  expect(view.querySelector(`[data-dock-id="a"] header ${viewButton}`)).not.toBeNull();
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Float a"]')!.click());
  expect(view.querySelectorAll(viewButton)).toHaveLength(1);
  expect(view.querySelector(`[data-dock-id="b"] header ${viewButton}`)).not.toBeNull();
}, 10000);
