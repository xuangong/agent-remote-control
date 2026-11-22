import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../../test/setup.js';
import { SessionTrackingMenu } from './SessionTrackingMenu.js';
import type { SessionTracking } from './useSessionTracking.js';
import { sessionKey } from '../../kernel/session-tree.js';

it('opens a tracked session from its full row while New remains a passive badge', async () => {
  const session = { hostId: 'h', providerId: 'codex', nativeSessionId: 'n', title: 'Research', starredAt: 1 };
  const open = vi.fn(), acknowledge = vi.fn(), toggle = vi.fn();
  const tracking = { sessions: [session], backgroundSessions: [session], observations: {
    [sessionKey(session)]: { connection: 'ready', activity: 'waiting', changed: true, attention: 'pending' },
  }, acknowledge, toggle } as unknown as SessionTracking;
  const view = await render(<SessionTrackingMenu tracking={tracking} busy={false} inert={false} onOpen={open} />);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
  const row = view.querySelector('.lab-tracked-row')!;
  expect(row.querySelectorAll('button')).toHaveLength(1);
  const badge = row.querySelector<HTMLElement>('.lab-tracked-change')!;
  expect(badge.tagName).toBe('SPAN');
  await act(async () => badge.click());
  expect(open).toHaveBeenCalledWith(session);
  expect(acknowledge).not.toHaveBeenCalled();
  expect(toggle).not.toHaveBeenCalled();
  expect(view.querySelector('.lab-session-popover-panel')).toBeNull();
});

it('disables the tracked row while another session is opening', async () => {
  const session = { hostId: 'h', providerId: 'codex', nativeSessionId: 'n', title: 'Research', starredAt: 1 };
  const open = vi.fn();
  const tracking = { sessions: [session], backgroundSessions: [session], observations: {
    [sessionKey(session)]: { connection: 'ready', activity: 'idle', changed: true },
  } } as unknown as SessionTracking;
  const view = await render(<SessionTrackingMenu tracking={tracking} busy inert={false} onOpen={open} />);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
  const buttons = [...view.querySelectorAll<HTMLButtonElement>('.lab-tracked-row button')];
  expect(buttons).toHaveLength(1);
  expect(buttons.every(button => button.disabled)).toBe(true);
  await act(async () => buttons.forEach(button => button.click()));
  expect(open).not.toHaveBeenCalled();
});

it('preserves keyboard reordering and drag gestures on rows with new content', async () => {
  const session = { hostId: 'h', providerId: 'codex', nativeSessionId: 'n', title: 'Research', starredAt: 1 };
  const other = { ...session, nativeSessionId: 'other', title: 'Other' };
  const open = vi.fn(), reorder = vi.fn();
  const tracking = { sessions: [session, other], backgroundSessions: [session, other], observations: {
    [sessionKey(session)]: { connection: 'ready', activity: 'idle', changed: true },
  }, reorder } as unknown as SessionTracking;
  const view = await render(<SessionTrackingMenu tracking={tracking} busy={false} inert={false} onOpen={open} />);
  await act(async () => view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
  const row = view.querySelector<HTMLButtonElement>('.lab-session-row')!;
  expect(row.querySelector('.lab-tracked-grip')).not.toBeNull();
  await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })); });
  expect(reorder).toHaveBeenCalledWith(sessionKey(session), sessionKey(other), 'after');
  expect(view.textContent).toContain('Moved Research after Other.');
  const capture = vi.fn(); row.setPointerCapture = capture;
  const pointer = Object.assign(new MouseEvent('pointerdown', { button: 0, bubbles: true }), { pointerId: 1, pointerType: 'mouse', isPrimary: true });
  await act(async () => { row.dispatchEvent(pointer); });
  expect(capture).toHaveBeenCalledWith(1);
  expect(open).not.toHaveBeenCalled();
  await act(async () => { document.dispatchEvent(Object.assign(new MouseEvent('pointerup', { bubbles: true }), { pointerId: 1 })); });
  await act(async () => row.click());
  expect(open).toHaveBeenCalledWith(session);
});

it('draws the strongest reminder of its list on the capsule and none when the list has no unread session', async () => {
  const pending = { hostId: 'h', providerId: 'codex', nativeSessionId: 'p', title: 'Needs input', starredAt: 1 };
  const finished = { hostId: 'h', providerId: 'codex', nativeSessionId: 'f', title: 'Finished work', starredAt: 1 };
  const observations = {
    [sessionKey(pending)]: { connection: 'ready', activity: 'waiting', changed: true, attention: 'pending' },
    [sessionKey(finished)]: { connection: 'ready', activity: 'idle', changed: true, attention: 'idle' },
  };
  const menu = (background: unknown[]) => <SessionTrackingMenu tracking={{ sessions: [pending, finished], backgroundSessions: background, observations } as unknown as SessionTracking} busy={false} inert={false} onOpen={vi.fn()} />;
  const capsule = async (background: unknown[]) => (await render(menu(background))).querySelector('.lab-tracking-floating, .lab-sidebar-shortcut-track')!;
  expect((await capsule([pending, finished])).getAttribute('data-alert')).toBe('pending');
  expect((await capsule([finished])).getAttribute('data-alert')).toBe('idle');
  expect((await capsule([])).hasAttribute('data-alert')).toBe(false);
});
