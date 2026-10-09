import { expect, test, type Page } from '@playwright/test';
import type { SessionAttentionNotifications } from '../src/session-notifications';

type NotificationFixture = { notifier: SessionAttentionNotifications; notices: { title: string; onclick?: () => void; options: NotificationOptions }[]; focused: number; opened: string[] };
const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Research' };
async function setup(page: Page, displayed: boolean) {
  await page.goto('/');
  return page.evaluateHandle(async ({ session, displayed }) => {
    const url = '/src/session-notifications.ts';
    const { SessionAttentionNotifications } = await import(/* @vite-ignore */ url);
    const fixture = { notices: [], focused: 0, opened: [] } as unknown as NotificationFixture;
    class TestNotification {
      static permission = 'granted';
      constructor(readonly title: string, readonly options: NotificationOptions) { fixture.notices.push(this); }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: TestNotification, configurable: true });
    window.focus = () => { fixture.focused++; };
    fixture.notifier = new SessionAttentionNotifications('notification-e2e', () => true, (target: typeof session) => fixture.opened.push(target.nativeSessionId));
    fixture.notifier.setDisplayed(displayed ? [session] : []);
    return fixture;
  }, { session, displayed });
}

test('real cross-tab locks route pending and completion to the session tab and deduplicate observers', async ({ page, context, isMobile }) => {
  test.skip(isMobile, 'Desktop notifications');
  const background = await setup(page, false);
  const ownerPage = await context.newPage();
  const owner = await setup(ownerPage, true);
  await expect.poll(() => ownerPage.evaluate(async () => (await navigator.locks.query()).held?.filter(lock => lock.name?.startsWith('arc:notification-route:')).length)).toBe(1);
  const duplicatePage = await context.newPage();
  const duplicate = await setup(duplicatePage, true);
  await expect.poll(() => ownerPage.evaluate(async () => (await navigator.locks.query()).held?.filter(lock => lock.name?.startsWith('arc:notification-route:')).length)).toBe(2);
  const emit = async (activity: 'running' | 'waiting' | 'idle', seq: number) => {
    for (const fixture of [background, owner, duplicate]) await fixture.evaluate((f, { session, activity, seq }) => f.notifier.observe(session, { connection: 'ready', activity, cursor: { epoch: 'epoch', seq } }), { session, activity, seq });
  };
  await emit('idle', 1);
  expect(await owner.evaluate(f => f.notices.length)).toBe(0);
  await emit('running', 2);
  await emit('waiting', 3);
  await emit('waiting', 4);
  expect(await background.evaluate(f => f.notices.length)).toBe(0);
  expect(await owner.evaluate(f => f.notices.map(n => n.title))).toEqual(['Session needs your input']);
  expect(await duplicate.evaluate(f => f.notices.length)).toBe(0);
  await owner.evaluate(f => f.notices[0]!.onclick!());
  expect(await owner.evaluate(f => ({ focused: f.focused, opened: f.opened }))).toEqual({ focused: 1, opened: ['native'] });
  await emit('running', 5);
  await emit('idle', 6);
  expect(await owner.evaluate(f => f.notices.map(n => n.title))).toEqual(['Session needs your input', 'Session completed']);
  expect(await duplicate.evaluate(f => f.notices.length)).toBe(0);
  // Closing all dedicated tabs releases the route so tracked-only sessions still notify.
  await ownerPage.close(); await duplicatePage.close();
  await background.evaluate(async (f, session) => {
    await f.notifier.observe(session, { connection: 'ready', activity: 'running', cursor: { epoch: 'epoch', seq: 7 } });
    await f.notifier.observe(session, { connection: 'ready', activity: 'waiting', cursor: { epoch: 'epoch', seq: 8 } });
  }, session);
  expect(await background.evaluate(f => f.notices.length)).toBe(1);
  await background.evaluate(f => f.notices[0]!.onclick!());
  expect(await background.evaluate(f => f.opened)).toEqual(['native']);
  await background.evaluate(f => f.notifier.dispose());
});

test('simultaneous activity in two session tabs produces a single notification', async ({ page, context, isMobile }) => {
  test.skip(isMobile, 'Desktop notifications');
  const first = await setup(page, true);
  const otherPage = await context.newPage();
  const second = await setup(otherPage, true);
  const emit = (fixture: typeof first, activity: 'running' | 'waiting', seq: number) => fixture.evaluate((f, { session, activity, seq }) =>
    f.notifier.observe(session, { connection: 'ready', activity, cursor: { epoch: 'race', seq } }), { session, activity, seq });
  await Promise.all([emit(first, 'running', 1), emit(second, 'running', 1)]);
  await Promise.all([emit(first, 'waiting', 2), emit(second, 'waiting', 2)]);
  expect((await first.evaluate(f => f.notices.length)) + (await second.evaluate(f => f.notices.length))).toBe(1);
  await first.evaluate(f => f.notifier.dispose());
  await second.evaluate(f => f.notifier.dispose());
  await otherPage.close();
});
