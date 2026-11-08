import { afterEach, expect, it, vi } from 'vitest';
import { SessionAttentionNotifications } from './session-notifications.js';
import type { SessionObservation } from './tracking-state.js';

const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Research' };
const value = (activity: SessionObservation['activity'], seq: number, epoch = 'epoch'): SessionObservation => ({ connection: 'ready', activity, cursor: { epoch, seq } });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
function setup() {
  const instances: { onclick?: () => void; close: ReturnType<typeof vi.fn>; options: NotificationOptions }[] = [];
  class FakeNotification {
    static permission = 'granted';
    close = vi.fn();
    constructor(readonly title: string, readonly options: NotificationOptions) { instances.push(this); }
  }
  vi.stubGlobal('Notification', FakeNotification);
  const open = vi.fn();
  const notifier = new SessionAttentionNotifications('workspace', () => true, open);
  return { notifier, open, instances, FakeNotification };
}
it('authorizes only eligible native identities while displayed identities remain routing hints', async () => {
  const { notifier, instances } = setup();
  const excluded = ['hidden', 'fallback', 'tracked', 'ask'].map(nativeSessionId => ({ ...session, nativeSessionId }));
  notifier.setEligible([session]); notifier.setDisplayed(excluded);
  for (const target of [session, ...excluded]) {
    await notifier.observe(target, value('running', 1));
    await notifier.observe(target, value('idle', 2));
    await notifier.observe(target, value('waiting', 3));
  }
  expect(instances).toHaveLength(2);
  expect(instances.map(item => item.options.body)).toEqual(['Research', 'Research']);
  notifier.dispose();
});

it('starts fresh after leaving and reentering eligibility and closes stale notifications', async () => {
  const { notifier, instances, open } = setup();
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  notifier.setEligible([session]);
  await notifier.observe(session, value('running', 1));
  await notifier.observe(session, value('waiting', 2));
  notifier.setEligible([]);
  expect(instances[0]!.close).toHaveBeenCalledOnce();
  instances[0]!.onclick!(); expect(open).not.toHaveBeenCalled();
  await notifier.observe(session, value('running', 3));
  notifier.setEligible([session]);
  await notifier.observe(session, value('idle', 4));
  expect(instances).toHaveLength(1);
  await notifier.observe(session, value('running', 5));
  await notifier.observe(session, value('idle', 6));
  expect(instances).toHaveLength(2);
  notifier.dispose();
});

it.each([false, true])('fences async fingerprinting after eligibility changes (reenter: %s)', async reenter => {
  const { notifier, instances } = setup();
  let finish!: (buffer: ArrayBuffer) => void;
  vi.stubGlobal('crypto', { subtle: { digest: vi.fn(() => new Promise<ArrayBuffer>(resolve => { finish = resolve; })) } });
  notifier.setEligible([session]);
  await notifier.observe(session, value('running', 1));
  const pending = notifier.observe(session, value('idle', 2));
  notifier.setEligible([]);
  if (reenter) notifier.setEligible([session]);
  finish(new Uint8Array([1, 2, 3]).buffer);
  await pending;
  expect(instances).toHaveLength(0);
  notifier.dispose();
});

it('notifies once after observed work, not for initial idle or repeated snapshots; clicking focuses the owner', async () => {
  const { notifier, open, instances } = setup();
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  await notifier.observe(session, value('idle', 1));
  expect(instances).toHaveLength(0);
  await notifier.observe(session, value('running', 2));
  await notifier.observe(session, value('idle', 4));
  await notifier.observe(session, value('idle', 4));
  expect(instances).toHaveLength(1);
  instances[0]!.onclick!();
  expect(focus).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(session);
  expect(instances[0]!.close).toHaveBeenCalledOnce();
  notifier.dispose();
});
it('retains observed work across reconnect but never treats replaced history or failures as completion', async () => {
  const { notifier, instances } = setup();
  await notifier.observe(session, value('running', 2));
  await notifier.observe(session, { connection: 'disconnected' });
  await notifier.observe(session, value('idle', 4));
  expect(instances).toHaveLength(1);
  await notifier.observe(session, value('running', 5));
  await notifier.observe(session, value('idle', 6, 'replacement'));
  await notifier.observe(session, value('running', 7, 'replacement'));
  await notifier.observe(session, value('failed', 8, 'replacement'));
  await notifier.observe(session, value('idle', 9, 'replacement'));
  expect(instances).toHaveLength(1);
  notifier.dispose();
});
it('does not replay completion after permission is granted or notifications are reenabled', async () => {
  const { notifier, instances, FakeNotification } = setup();
  FakeNotification.permission = 'default';
  await notifier.observe(session, value('running', 2));
  await notifier.observe(session, value('idle', 4));
  FakeNotification.permission = 'granted';
  await notifier.observe(session, value('idle', 4));
  expect(instances).toHaveLength(0);
  notifier.dispose();
});
it('notifies pending attention once, then completion after work resumes, without re-alerting on reconnect', async () => {
  const { notifier, instances } = setup();
  await notifier.observe(session, value('waiting', 1));
  expect(instances).toHaveLength(0);
  await notifier.observe(session, value('running', 2));
  await notifier.observe(session, value('waiting', 3));
  await notifier.observe(session, value('waiting', 4));
  await notifier.observe(session, { connection: 'disconnected' });
  await notifier.observe(session, value('waiting', 4));
  expect(instances).toHaveLength(1);
  await notifier.observe(session, value('running', 5));
  await notifier.observe(session, value('idle', 6));
  expect(instances).toHaveLength(2);
  notifier.dispose();
});

it('does not notify quiet reviews but delivers a later visible assessment and pending input', async () => {
  const { notifier, instances } = setup();
  const background = { id: 'review', kind: 'review' as const, status: 'silent' as const };
  await notifier.observe(session, { ...value('running', 1), background });
  await notifier.observe(session, { ...value('idle', 1), background });
  expect(instances).toHaveLength(0);
  await notifier.observe(session, { ...value('idle', 3), background: { ...background, status: 'visible' } });
  expect(instances).toHaveLength(1);
  await notifier.observe(session, { ...value('running', 4), background });
  await notifier.observe(session, { ...value('waiting', 4), background });
  expect(instances).toHaveLength(2);
  notifier.dispose();
});
