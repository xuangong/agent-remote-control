import { act, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { SessionStateRef } from '@orchardworks/agent-client';
import type { SessionActivityStatus } from '../../kernel/session-activity-status.js';
import type { useWindowWorkspace } from './useWindowWorkspace.js';
import { touchWindow } from './window-recency.js';
import { render } from '../../test/setup.js';
import { WindowOverview } from './WindowOverview.js';

const scope = 'http://localhost/u/overview/';
const windowOf = (id: string, title: string, nativeSessionId = `${id}-session`): WorkspaceWindow => ({ schemaVersion: 3, id, revision: 1, title, selectedPrimaryViewId: 'main', selectedViewId: 'main',
  views: [createWindowView('main', { hostId: 'host', providerId: 'codex', nativeSessionId, title: `${title} session` }, 'primary')] });
const catalog = [windowOf('first', 'First'), windowOf('second', 'Second'), windowOf('third', 'Third')];

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  localStorage.clear();
  // Recently used: Third, then Second, then First.
  touchWindow(scope, 'first', 1); touchWindow(scope, 'second', 2); touchWindow(scope, 'third', 3);
});
afterEach(() => { localStorage.clear(); document.body.innerHTML = ''; });

function Harness({ enabled = true, open, status, onOpen }: { enabled?: boolean; open?: boolean; status?: (session: SessionStateRef) => SessionActivityStatus; onOpen?: (id: string) => Promise<void> }) {
  const [shown, setShown] = useState(open ?? false);
  const workspace = { window: catalog[2], windows: catalog, readGroup: () => undefined, open: onOpen ?? (async () => {}) } as unknown as ReturnType<typeof useWindowWorkspace>;
  return <><button type="button" id="before-overview">Windows</button><WindowOverview workspace={workspace} scope={scope} enabled={enabled} open={shown} sessionStatus={status} onOpenChange={setShown} /></>;
}
const overview = () => document.querySelector<HTMLDialogElement>('dialog.lab-window-overview');
const cards = () => [...document.querySelectorAll<HTMLElement>('[data-window-card]')];
const titles = () => cards().map(card => card.querySelector('.lab-window-card-caption strong')!.textContent);
const press = async (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body) =>
  act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
const ctrlShift = { ctrlKey: true, shiftKey: true };

it('lists every Window by recent use, focuses the current one, and Escape closes it without switching', async () => {
  const opened = vi.fn(async () => {});
  await render(<Harness open onOpen={opened} />);
  expect(titles()).toEqual(['Third', 'Second', 'First']);
  expect(document.activeElement).toBe(cards()[0]);
  expect(cards()[0]!.getAttribute('aria-current')).toBe('true');
  await act(async () => { overview()!.dispatchEvent(new Event('cancel', { bubbles: false, cancelable: true })); });
  expect(overview()).toBeNull();
  expect(opened).not.toHaveBeenCalled();
});

it('opens from Ctrl+Shift+Up, moves with the arrow keys, opens the focused Window and returns on Ctrl+Shift+Down', async () => {
  const opened = vi.fn(async () => {});
  await render(<Harness onOpen={opened} />);
  expect(overview()).toBeNull();
  await press('ArrowUp', ctrlShift, document.body);
  expect(titles()).toEqual(['Third', 'Second', 'First']);
  await press('ArrowRight');
  expect(document.activeElement).toBe(cards()[1]);
  await act(async () => cards()[1]!.click());
  expect(opened).toHaveBeenCalledWith('second');
  expect(overview()).toBeNull();
  await press('ArrowUp', ctrlShift, document.body);
  expect(overview()).not.toBeNull();
  await press('ArrowDown', ctrlShift);
  expect(overview()).toBeNull();
});

it('goes to the first and last Window with Home and End, and does not open when it is not available', async () => {
  const shown = await render(<Harness />);
  await press('ArrowUp', ctrlShift, document.body);
  await press('End');
  expect(document.activeElement).toBe(cards().at(-1));
  await press('Home');
  expect(document.activeElement).toBe(cards()[0]);
  await press('ArrowDown', ctrlShift);
  expect(overview()).toBeNull();
  shown.remove();
  await render(<Harness enabled={false} />);
  await press('ArrowUp', ctrlShift, document.body);
  expect(overview()).toBeNull();
});

it('returns on a click beside the cards, and keeps the current Window shown when it is chosen again', async () => {
  const opened = vi.fn(async () => {});
  await render(<Harness open onOpen={opened} />);
  await act(async () => cards()[0]!.click());
  expect(opened).not.toHaveBeenCalled();
  expect(overview()).toBeNull();
});

it("shows what needs the owner on each Window's panes and in its summary, and leaves an idle session quiet", async () => {
  const states = new Map<string, SessionActivityStatus>([['first-session', 'waiting'], ['second-session', 'running'], ['third-session', 'idle']]);
  await render(<Harness open status={session => states.get(session.nativeSessionId) ?? 'idle'} />);
  const card = (id: string) => document.querySelector<HTMLElement>(`[data-window-card="${id}"]`)!;
  expect(card('first').querySelector('.lab-window-card-state')?.textContent).toBe('Needs you');
  expect(card('first').getAttribute('data-attention')).toBe('true');
  expect(card('first').querySelector('.lab-window-card-summary')?.textContent).toBe(' · 1 needs you');
  expect(card('second').querySelector('.lab-window-card-state')?.textContent).toBe('Working');
  expect(card('second').getAttribute('data-attention')).toBeNull();
  expect(card('third').querySelector('.lab-window-card-pane')?.getAttribute('data-state')).toBe('idle');
  expect(card('third').querySelector('.lab-window-card-state')).toBeNull();
});

it("says a Host's sessions are offline on the pane", async () => {
  await render(<Harness open status={() => 'offline'} />);
  expect(document.querySelector('[data-window-card="first"] .lab-window-card-state')?.textContent).toBe('Host offline');
});

it('closes at once when it stops being available while it is open (a narrow screen)', async () => {
  let setEnabled!: (enabled: boolean) => void;
  function Switch() {
    const [enabled, set] = useState(true); setEnabled = set;
    return <Harness enabled={enabled} open />;
  }
  await render(<Switch />);
  expect(overview()).not.toBeNull();
  await act(async () => setEnabled(false));
  expect(overview()).toBeNull();
});

it('returns focus to where it was when it closes without switching Windows', async () => {
  await render(<Harness />);
  const before = document.getElementById('before-overview')!;
  await act(async () => before.focus());
  await press('ArrowUp', ctrlShift);
  expect(document.activeElement).toBe(cards()[0]);
  await press('ArrowDown', ctrlShift);
  await act(async () => { await Promise.resolve(); });
  expect(overview()).toBeNull();
  expect(document.activeElement).toBe(before);
});
