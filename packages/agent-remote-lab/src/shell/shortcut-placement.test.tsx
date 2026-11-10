import { act, createRef, useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { AskButton } from '../components/AskButton.js';
import { TpmMenu } from '../components/TpmMenu.js';
import { useTpmWork, type TpmService } from '../hooks/useTpmWork.js';
import { ShortcutPlacement } from './shortcut-placement.js';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); });
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
