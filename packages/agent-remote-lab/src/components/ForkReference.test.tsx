import { act } from 'react';
import { expect, it } from 'vitest';
import type { SessionFork } from '../session-forks.js';
import { render } from '../test/setup.js';
import { ForkEntries, ForkReference } from './ForkReference.js';

const fork: SessionFork = {
  id: 'side-link', mode: 'reference', capturedAt: '2026-10-02T00:00:00Z', delivery: 'sent', options: {}, settings: [],
  source: { agentId: 'parent', providerId: 'codex', nativeSessionId: 'parent-session', title: 'Parent' },
  target: { agentId: 'child', providerId: 'codex', nativeSessionId: 'child-session', title: 'Child' }, firstInput: 'Investigate the issue',
};

it('opens side actions without navigating and retains a failed unlink for retry', async () => {
  let opened = false, attempts = 0;
  let finish!: () => void;
  const container = await render(<ForkEntries forks={[fork]} onOpen={() => { opened = true; }} onUnlink={async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('The server is offline.');
    await new Promise<void>(resolve => { finish = resolve; });
  }} />);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  const unlink = document.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
  expect(unlink.textContent).toBe('Unlink side session');
  expect(document.activeElement).toBe(unlink);
  await act(async () => unlink.click());
  expect(document.querySelector('[role="menu"] [role="alert"]')?.textContent).toContain('The server is offline.');
  expect(opened).toBe(false);
  await act(async () => unlink.click());
  expect(unlink.disabled).toBe(true);
  await act(async () => unlink.click());
  expect(attempts).toBe(2);
  await act(async () => finish());
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(opened).toBe(false);
});

it('dismisses side actions with Escape and restores keyboard focus', async () => {
  const container = await render(<ForkEntries forks={[fork]} onOpen={() => {}} onUnlink={async () => {}} />);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  expect(trigger).not.toBeNull();
  await act(async () => trigger.click());
  await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('offers unlink in the source details without opening the source session', async () => {
  let opened = false, unlinked = '';
  const container = await render(<ForkReference fork={fork} onOpen={() => { opened = true; }} onUnlink={async value => { unlinked = value.id; }} />);
  await act(async () => container.querySelector('summary')!.click());
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === 'Unlink side session');
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(unlinked).toBe(fork.id);
  expect(opened).toBe(false);
});

it('omits unlinked navigation and counts only remaining side sessions', async () => {
  const detached = { ...fork, linked: false };
  const container = await render(<><ForkReference fork={detached} onOpen={() => {}} /><ForkEntries forks={[detached]} onOpen={() => {}} /></>);
  expect(container.querySelector('.lab-fork-reference')).toBeNull();
  expect(container.querySelector('.lab-fork-entries')).toBeNull();
});
