import { act, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { buildGroup, buildView, buildWindow } from '../../test/window-builders.js';
import { WindowToolbarRow } from './WindowToolbarRow.js';

type Scope = Parameters<typeof WindowToolbarRow>[0]['scope'];

function scopeOf(overrides: Partial<Record<keyof Scope, unknown>> = {}) {
  const sharedWindow = buildWindow([buildView('a'), buildView('b', 'dock')], 'a', { id: 'A', title: 'Alpha' });
  const scope = {
    addSessionView: vi.fn(), createSessionView: vi.fn(), asleepBot: vi.fn(() => false), docksHidden: false, setDocksHidden: vi.fn(),
    setAgentControlOpen: vi.fn(), setDeleteConfirmOpen: vi.fn(), setWindowToolbarViewTarget: vi.fn(), sharedWindow, windowToolbarShown: true,
    windowActions: { busy: false, saveRename: vi.fn(async () => {}), setBotAppearance: vi.fn(async () => {}), copyLink: vi.fn(async () => {}) },
    windowWorkspace: { provisional: false, group: buildGroup(sharedWindow), client: undefined },
    ...overrides,
  };
  return scope as typeof scope & Scope;
}
const menuItems = (menu: string) => [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${menu}"] [role="menuitem"]`)];
async function choose(container: ParentNode, menu: string, label: string) {
  await act(async () => container.querySelector<HTMLButtonElement>(`button[aria-label="${menu}"]`)!.click());
  await act(async () => menuItems(menu).find(item => item.textContent === label)!.click());
}

it('shows nothing where the toolbar is hidden or there is no shared Window', async () => {
  expect((await render(<WindowToolbarRow scope={scopeOf({ windowToolbarShown: false })} />)).querySelector('header')).toBeNull();
  expect((await render(<WindowToolbarRow scope={scopeOf({ sharedWindow: undefined })} />)).querySelector('header')).toBeNull();
});

it('names the Window and counts its bots, leaving a sleeping bot out of the open ones', async () => {
  const scope = scopeOf();
  scope.asleepBot = vi.fn(({ id }: { id: string }) => id === 'b') as never;
  const container = await render(<WindowToolbarRow scope={scope} />);
  expect(container.querySelector('button.lab-window-toolbar-title')!.textContent).toBe('Alpha');
  expect(container.querySelector('.ui-toolbar-subtitle')!.textContent).toBe('2 bots · 1 open');
  expect(scope.asleepBot).toHaveBeenCalledWith({ id: 'b' });
});

it('hands the toolbar slot to the view options placement', async () => {
  const scope = scopeOf();
  await render(<WindowToolbarRow scope={scope} />);
  expect(scope.setWindowToolbarViewTarget).toHaveBeenCalledWith(expect.any(HTMLDivElement));
});

it('saves a rename for this Window', async () => {
  const scope = scopeOf();
  const container = await render(<WindowToolbarRow scope={scope} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button.lab-window-toolbar-title')!.click());
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Window title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Research');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  expect(scope.windowActions.saveRename).toHaveBeenCalledExactlyOnceWith('A', 'Research');
});

it('adds a session view and opens a session through their own actions', async () => {
  const scope = scopeOf();
  const container = await render(<WindowToolbarRow scope={scope} />);
  await choose(container, 'Add', 'New session view');
  expect(scope.addSessionView).toHaveBeenCalledOnce();
  expect(scope.createSessionView).not.toHaveBeenCalled();
  await choose(container, 'Add', 'Open session…');
  expect(scope.createSessionView).toHaveBeenCalledOnce();
});

it('offers the dock toggle for a Window with docks and flips the remembered choice', async () => {
  const scope = scopeOf();
  const container = await render(<WindowToolbarRow scope={scope} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Hide docks"]')!.click());
  const flip = vi.mocked(scope.setDocksHidden).mock.calls[0]![0] as unknown as (value: boolean) => boolean;
  expect([flip(false), flip(true)]).toEqual([true, false]);
  const noDocks = buildWindow([buildView('a')], 'a', { id: 'A' });
  const without = await render(<WindowToolbarRow scope={scopeOf({ sharedWindow: noDocks, windowWorkspace: { provisional: false, group: buildGroup(noDocks) } })} />);
  expect(without.querySelector('button[aria-label="Hide docks"]')).toBeNull();
});

it('says "Show docks" while the docks are hidden', async () => {
  const container = await render(<WindowToolbarRow scope={scopeOf({ docksHidden: true })} />);
  expect(container.querySelector('button[aria-label="Show docks"]')).not.toBeNull();
});

it('changes the Bot mode appearance of the Window\'s group, and leaves the toggle out for a Window without a group', async () => {
  const scope = scopeOf();
  const container = await render(<WindowToolbarRow scope={scope} />);
  await choose(container, 'Window actions', 'Hide in Bot mode');
  expect(scope.windowActions.setBotAppearance).toHaveBeenCalledExactlyOnceWith(false);
  const alone = scopeOf({ windowWorkspace: { provisional: false, group: undefined } });
  const without = await render(<WindowToolbarRow scope={alone} />);
  await act(async () => without.querySelector<HTMLButtonElement>('button[aria-label="Window actions"]')!.click());
  expect(menuItems('Window actions').map(item => item.textContent)).toEqual(['Copy link', 'Delete Window…']);
});

it('copies the link, and opens Agent control only where there is a client', async () => {
  const scope = scopeOf();
  const container = await render(<WindowToolbarRow scope={scope} />);
  await choose(container, 'Window actions', 'Copy link');
  expect(scope.windowActions.copyLink).toHaveBeenCalledOnce();
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Window actions"]')!.click());
  expect(menuItems('Window actions').map(item => item.textContent)).not.toContain('Agent control…');
  const hosted = scopeOf({ windowWorkspace: { provisional: false, group: undefined, client: {} } });
  const withClient = await render(<WindowToolbarRow scope={hosted} />);
  await choose(withClient, 'Window actions', 'Agent control…');
  expect(hosted.setAgentControlOpen).toHaveBeenCalledExactlyOnceWith(true);
});

it('asks to delete rather than deleting, and shows a cached Window read-only', async () => {
  const scope = scopeOf();
  const container = await render(<WindowToolbarRow scope={scope} />);
  await choose(container, 'Window actions', 'Delete Window…');
  expect(scope.setDeleteConfirmOpen).toHaveBeenCalledExactlyOnceWith(true);
  expect(scope.windowActions.saveRename).not.toHaveBeenCalled();
  const cached = await render(<WindowToolbarRow scope={scopeOf({ windowWorkspace: { provisional: true, group: undefined } })} />);
  expect(cached.querySelector<HTMLButtonElement>('button.lab-window-toolbar-title')!.disabled).toBe(true);
});

it('keeps Delete from acting while another Window action runs', async () => {
  const busy = scopeOf({ windowActions: { busy: true, saveRename: vi.fn(), setBotAppearance: vi.fn(), copyLink: vi.fn() } });
  const container = await render(<WindowToolbarRow scope={busy} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Window actions"]')!.click());
  expect(menuItems('Window actions').filter(item => item.getAttribute('aria-disabled') === 'true').map(item => item.textContent)).toEqual(['Delete Window…']);
  expect(container.querySelector<HTMLButtonElement>('button.lab-window-toolbar-title')!.disabled).toBe(false);
});

it('ends an open rename without saving when the toolbar shows another Window, and names the new one', async () => {
  const other = buildWindow([buildView('c')], 'c', { id: 'B', title: 'Beta' });
  const base = scopeOf();
  const show: { current?: (id: string) => void } = {};
  function Switching() {
    const [id, setId] = useState('A');
    show.current = setId;
    return <WindowToolbarRow scope={{ ...base, sharedWindow: id === 'A' ? base.sharedWindow : other } as typeof base} />;
  }
  const container = await render(<Switching />);
  await act(async () => container.querySelector<HTMLButtonElement>('button.lab-window-toolbar-title')!.click());
  const field = container.querySelector<HTMLInputElement>('input[aria-label="Window title"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Meant for A');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => show.current!('B'));
  expect(container.querySelector('input')).toBeNull();
  expect(container.querySelector('button.lab-window-toolbar-title')!.textContent).toBe('Beta');
  expect(base.windowActions.saveRename).not.toHaveBeenCalled();
});
