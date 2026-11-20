import { act, createRef, useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { AskButton } from '../components/AskButton.js';
import { TpmMenu } from '../components/TpmMenu.js';
import { SessionTrackingMenu } from '../components/SessionTrackingMenu.js';
import { WindowMenu } from '../components/WindowMenu.js';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
import { sessionKey } from '../session-tree.js';
import { useTpmWork, type TpmService } from '../hooks/useTpmWork.js';
import { ShortcutPlacement } from './shortcut-placement.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });
afterEach(() => { vi.unstubAllGlobals(); });

it('renders a capsule as a sidebar row with the same name, without floating placement', async () => {
  const floating = await render(<AskButton triggerRef={createRef()} disabled={false} onOpen={() => {}} />);
  expect(floating.querySelector('.lab-tracking-floating.lab-ask-floating')).not.toBeNull();
  expect(floating.querySelector('button')?.getAttribute('aria-description')).toContain('Drag to move');
  const docked = await render(<ShortcutPlacement.Provider value="sidebar"><AskButton triggerRef={createRef()} disabled={false} onOpen={() => {}} /></ShortcutPlacement.Provider>);
  const row = docked.querySelector('.lab-sidebar-shortcut.lab-sidebar-shortcut-ask')!;
  expect(row).not.toBeNull();
  expect(row.matches('.lab-tracking-floating')).toBe(false);
  expect(row.getAttribute('style')).toBeNull();
  expect(row.hasAttribute('data-edge')).toBe(false);
  const trigger = row.querySelector('button')!;
  expect(trigger.getAttribute('aria-label')).toBe('Ask about this session');
  expect(trigger.hasAttribute('aria-description')).toBe(false);
  expect(trigger.hasAttribute('aria-keyshortcuts')).toBe(false);
});

it('renders TPM as a sidebar row whose panel stays open for clicks inside it', async () => {
  const service: TpmService = { tpmWork: async () => { throw new Error('unused'); }, tpmList: async () => ({ supported: true, works: [] }),
    tpmCreate: async () => { throw new Error('unused'); }, tpmAction: async () => { throw new Error('unused'); } };
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const tpm = useTpmWork(service, [{ id: 'host', name: 'Host', online: true }], true, async value => ({ ...value, agentId: 'tpm-agent' }));
    return <ShortcutPlacement.Provider value="sidebar"><TpmMenu tpm={tpm} visible open={open} onOpenChange={setOpen} triggerRef={trigger} inert={false} /></ShortcutPlacement.Provider>;
  }
  const container = await render(<Harness />);
  const row = container.querySelector('.lab-sidebar-shortcut.lab-sidebar-shortcut-tpm')!;
  expect(row).not.toBeNull();
  expect(row.matches('.lab-tracking-floating, .lab-tpm-floating')).toBe(false);
  expect(row.getAttribute('style')).toBeNull();
  const trigger = row.querySelector<HTMLButtonElement>(':scope > button')!;
  expect(trigger.getAttribute('aria-label')).toBe('TPM works');
  expect(trigger.title).not.toContain('Drag');
  await act(async () => trigger.click());
  const panel = row.querySelector('section.lab-session-popover-panel')!;
  expect(panel).not.toBeNull();
  await act(async () => { panel.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
  expect(row.querySelector('section.lab-session-popover-panel')).not.toBeNull();
  await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
  expect(row.querySelector('section.lab-session-popover-panel')).toBeNull();
});

it('keeps the Ask and Track status, alert and attention on the sidebar rows', async () => {
  const sidebar = (node: JSX.Element) => <ShortcutPlacement.Provider value="sidebar">{node}</ShortcutPlacement.Provider>;
  const ask = await render(sidebar(<AskButton triggerRef={createRef()} disabled={false} onOpen={() => {}} sourceTitle="Research"
    observation={{ connection: 'ready', activity: 'running', attention: 'pending' } as never} />));
  const askRow = ask.querySelector('.lab-sidebar-shortcut-ask')!;
  expect(askRow.getAttribute('data-status')).toBe('working');
  expect(askRow.getAttribute('data-alert')).toBe('pending');

  const session = { hostId: 'h', providerId: 'codex', nativeSessionId: 'n', title: 'Research', starredAt: 1 };
  const tracking = { sessions: [session], backgroundSessions: [session], observations: {
    [sessionKey(session)]: { connection: 'ready', activity: 'waiting', changed: false, attention: 'pending' },
  } } as unknown as SessionTracking;
  const track = await render(sidebar(<SessionTrackingMenu tracking={tracking} busy={false} inert={false} onOpen={() => {}} />));
  const trackRow = track.querySelector('.lab-sidebar-shortcut-track')!;
  expect(trackRow.matches('.lab-tracking-floating')).toBe(false);
  expect(trackRow.getAttribute('data-alert')).toBe('pending');
  expect(trackRow.getAttribute('data-attention')).toBe('true');
  const trigger = trackRow.querySelector<HTMLButtonElement>('.lab-session-popover-trigger')!;
  expect(trigger.getAttribute('aria-label')).toBe('Tracked sessions');
  expect(trigger.textContent).toContain('Track');
  expect(trigger.title).not.toContain('Drag');
});

it('renders every entry as a launcher capsule in the compact bar, without floating placement or dragging', async () => {
  const bar = (node: JSX.Element) => <ShortcutPlacement.Provider value="bar">{node}</ShortcutPlacement.Provider>;
  const tracking = { sessions: [], backgroundSessions: [], observations: {} } as unknown as SessionTracking;
  const workspace = { windows: [], hasActiveWindow: false, unavailable: false } as unknown as ReturnType<typeof useWindowWorkspace>;
  const container = await render(bar(<>
    <SessionTrackingMenu tracking={tracking} busy={false} inert={false} onOpen={() => {}} />
    <WindowMenu workspace={workspace} visible />
    <AskButton triggerRef={createRef()} disabled={false} onOpen={() => {}} />
  </>));
  const launchers = [...container.querySelectorAll('.lab-launcher')];
  expect(launchers.map(element => element.className)).toEqual(['lab-launcher lab-launcher-track', 'lab-launcher lab-launcher-window', 'lab-launcher lab-launcher-ask']);
  expect(container.querySelector('.lab-tracking-floating')).toBeNull();
  for (const launcher of launchers) {
    expect(launcher.getAttribute('style')).toBeNull();
    expect(launcher.querySelector('button')?.title ?? '').not.toContain('Drag');
  }
  expect(container.querySelector('.lab-launcher-ask button')?.hasAttribute('aria-description')).toBe(false);
  // The capsule keeps the Track icon and counts without the sidebar row's label.
  expect(container.querySelector('.lab-launcher-track button')?.textContent).not.toContain('Track');
});
