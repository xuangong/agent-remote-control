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


it('attributes the original snapshot while opening the explicit current source', async () => {
  const current = { ...fork.source, providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent', title: 'Current B' };
  const snapshot: SessionFork = { ...fork, mode: 'snapshot', boundary: { epoch: 'one', seq: 2 }, itemCount: 2, text: '[]', currentSource: current };
  const opened: string[] = [];
  const container = await render(<ForkReference fork={snapshot} onOpen={session => opened.push(session.nativeSessionId)} />);
  expect(container.querySelector('summary')!.title).toBe('Context from parent-session');
  expect(container.querySelector('strong')!.textContent).toBe('Context from Parent');
  expect(container.querySelector('code')!.textContent).toBe('parent-session');
  const currentButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Open current source session');
  expect(currentButton).toBeDefined();
  await act(async () => currentButton!.click());
  expect(opened).toEqual(['B']);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(opened).toEqual(['B', 'parent-session']);
});

it('opens original and current source sessions without their retired pane identities', async () => {
  const original = { ...fork.source, hostId: 'host', parentAgentId: 'ancestor-agent', parentNativeSessionId: 'ancestor', createdAt: '2026-10-01T00:00:00Z' };
  const current = { ...original, nativeSessionId: 'current-session', agentId: 'current-agent', title: 'Current' };
  const legacyOriginal = { ...original, viewId: 'retired-original-pane' }, legacyCurrent = { ...current, viewId: 'retired-current-pane' };
  const legacy: SessionFork = { ...fork, source: legacyOriginal, currentSource: legacyCurrent };
  const opened: SessionFork['source'][] = [];
  const container = await render(<ForkReference fork={legacy} onOpen={session => opened.push(session)} />);
  await act(async () => container.querySelector('summary')!.click());
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label)!;
  await act(async () => button('Open source session').click());
  await act(async () => button('Open current source session').click());
  expect(opened).toEqual([original, current]);
  expect(legacy.source).toBe(legacyOriginal);
  expect(legacy.currentSource).toBe(legacyCurrent);
});


it('shows known original reference identity without inventing an attachment for a shared-only source', async () => {
  const current = { ...fork.source, hostId: 'host', providerId: 'claude', nativeSessionId: 'B', agentId: 'B-agent', title: 'Current B' };
  const remote: SessionFork = { ...fork, remote: true, source: current,
    nativeSourceRef: { controllerId: 'installation', providerId: 'codex', nativeSessionId: 'A' }, hostLocator: { hostId: 'host', controllerId: 'installation' } };
  const opened: string[] = [];
  const container = await render(<ForkReference fork={remote} onOpen={session => opened.push(session.nativeSessionId)} />);
  expect(container.querySelector('summary')!.title).toBe('Context from A');
  expect(container.querySelector('strong')!.textContent).toBe('Context from A');
  expect(container.querySelector('code')!.textContent).toBe('A');
  expect(container.querySelectorAll('button')).toHaveLength(1);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(opened).toEqual(['B']);
});


it.each(['host', 'controller', 'missing-host'])('does not attribute a shared historical reference across incompatible %s evidence', async collision => {
  const source = { ...fork.source, hostId: collision === 'host' ? 'Host-Q' : 'Host-P', title: 'Current observed title' };
  const remote: SessionFork = { ...fork, remote: true, source,
    nativeSourceRef: { controllerId: 'installation-P', providerId: source.providerId, nativeSessionId: source.nativeSessionId },
    hostLocator: collision === 'missing-host' ? undefined : { hostId: 'Host-P', controllerId: collision === 'controller' ? 'installation-Q' : 'installation-P' } };
  const opened: string[] = [];
  const container = await render(<ForkReference fork={remote} onOpen={session => opened.push(session.hostId!)} />);
  expect(container.querySelector('strong')!.textContent).toBe('Context from parent-session');
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(container.querySelector('button')!.textContent).toBe('Open current source session');
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(opened).toEqual([source.hostId]);
});

it('retains a known legacy shared source attachment', async () => {
  const remote: SessionFork = { ...fork, remote: true };
  const container = await render(<ForkReference fork={remote} onOpen={() => {}} />);
  expect(container.querySelector('strong')!.textContent).toBe('Context from Parent');
  expect(container.querySelector('button')!.textContent).toBe('Open source session');
});
