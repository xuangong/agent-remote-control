import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionTrackingMenu } from './SessionTrackingMenu.js';
import type { SessionTracking } from '../hooks/useSessionTracking.js';
import { sessionKey } from '../session-tree.js';

it('opens a session from its full row including the status badge', async () => {
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
  await act(async () => badge.click());
  expect(open).toHaveBeenCalledWith(session);
  expect(toggle).not.toHaveBeenCalled();
  expect(view.querySelector('.lab-session-popover-panel')).toBeNull();
});
