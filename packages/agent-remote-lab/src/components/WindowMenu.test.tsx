import { act } from 'react';
import { expect, it } from 'vitest';
import { createWindowView, type WindowSessionBinding, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from '../hooks/useWindowWorkspace.js';
import type { SessionActivityStatus } from '../session-activity-status.js';
import { render } from '../test/setup.js';
import { WindowMenu } from './WindowMenu.js';

const bind = (id: string): WindowSessionBinding => ({ hostId: 'host', providerId: 'claude', nativeSessionId: id, title: `Session ${id}` });
const windowOf = (id: string, sessions: string[]): WorkspaceWindow => ({ schemaVersion: 3, id, title: `Window ${id}`, revision: 0,
  selectedPrimaryViewId: `${id}-0`, selectedViewId: `${id}-0`,
  views: sessions.map((session, index) => createWindowView(`${id}-${index}`, bind(session), index ? 'dock' : 'primary')) });

async function menu(statuses: Record<string, SessionActivityStatus>) {
  const current = windowOf('current', ['a', 'b']);
  const others = [windowOf('busy', ['c', 'd']), windowOf('quiet', ['e'])];
  const workspace = { window: current, windows: [current, ...others], hasActiveWindow: true, unavailable: false,
    open: async () => {}, create: async () => {}, remove: async () => {}, operate: async () => {} } as unknown as ReturnType<typeof useWindowWorkspace>;
  const container = await render(<WindowMenu workspace={workspace} visible sessionStatus={session => statuses[session.nativeSessionId] ?? 'unknown'} />);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Windows"]')!.click());
  const windowRow = (id: string) => container.querySelector(`[data-window-row="${id}"]`)!;
  const viewRow = (id: string) => container.querySelector(`[data-window-view-row="${id}"]`)!;
  return { container, windowRow, viewRow };
}

it('marks each session view and summarizes each Window as pending, failed, working, then idle', async () => {
  const { windowRow, viewRow } = await menu({ a: 'running', b: 'starting', c: 'failed', d: 'running', e: 'idle' });
  expect(viewRow('current-0').querySelector('strong')!.dataset.sessionStatus).toBe('running');
  expect(viewRow('current-0').querySelector('small')!.textContent).toBe('Working · Top-level');
  expect(viewRow('current-1').querySelector('small')!.textContent).toBe('Pending · Dock');
  expect(windowRow('current').querySelector('small')!.textContent).toBe('Pending · 2 session views');
  expect(windowRow('busy').querySelector('strong')!.dataset.sessionStatus).toBe('failed');
  expect(windowRow('busy').querySelector('small')!.textContent).toBe('Failed · 2 session views');
  expect(windowRow('quiet').querySelector('small')!.textContent).toBe('Idle · 1 session view');
});

it('keeps a session view quiet while its status is unknown', async () => {
  const { windowRow, viewRow } = await menu({ a: 'idle' });
  expect(viewRow('current-1').querySelector('strong')!.dataset.sessionStatus).toBeUndefined();
  expect(viewRow('current-1').querySelector('small')!.textContent).toBe('Dock');
  expect(windowRow('current').querySelector('small')!.textContent).toBe('Idle · 2 session views');
  expect(windowRow('busy').querySelector('small')!.textContent).toBe('2 session views');
});

it('reminds of sessions waiting in another Window, not in the current one', async () => {
  const elsewhere = await menu({ a: 'running', d: 'waiting' });
  const root = elsewhere.container.querySelector<HTMLElement>('.lab-window-floating')!;
  expect(root.dataset.attention).toBe('true');
  expect(root.querySelector('.lab-tracking-attention')).not.toBeNull();
  expect(root.querySelector('[role="status"]')!.textContent).toBe('Another Window has pending sessions.');
  const here = await menu({ a: 'waiting', d: 'running', e: 'starting' });
  const quiet = here.container.querySelector<HTMLElement>('.lab-window-floating')!;
  expect(quiet.dataset.attention).toBeUndefined();
  expect(quiet.querySelector('.lab-tracking-attention')).toBeNull();
});
