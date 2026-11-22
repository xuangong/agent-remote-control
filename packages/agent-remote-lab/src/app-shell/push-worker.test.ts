// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { encodePushReminder, type PushReminder } from '@orchardworks/agent-remote-protocol';
import { clickAction, clickAddress, followClick, receivePush, reminderNotification, showsConversation, type PushWorkerPorts, type ShownNotification, type WorkerPage } from './push-worker.js';

const ORIGIN = 'https://agents.example';
const REMINDER: PushReminder = { v: 1, kind: 'needs_you', name: 'Chief', locale: 'en', url: '/?mode=bot&section=team&bot=chief', tag: 'schief', at: 2_000 };
const push = (change: Partial<PushReminder> = {}) => encodePushReminder({ ...REMINDER, ...change });

describe('the notification of a push', () => {
  it.each([
    ['needs_you', 'en', 'Chief needs you'], ['finished', 'en', 'Chief finished'],
    ['needs_you', 'zh', 'Chief 需要你'], ['finished', 'zh', 'Chief 做完了'],
  ] as const)('%s in %s reads "%s", with no other text', (kind, locale, title) => {
    const shown = reminderNotification(push({ kind, locale }), undefined);
    expect(shown.title).toBe(title);
    expect(shown.options).toEqual({ tag: 'schief', data: { url: REMINDER.url, at: 2_000, kind }, renotify: true, lang: locale === 'zh' ? 'zh-CN' : 'en',
      icon: '/app/icon-192.png', badge: '/app/icon-monochrome-192.png' });
    expect(shown.options.body).toBeUndefined();
  });

  it('replaces the reminder shown for the session with a newer one, and shows the newer again, quietly, for an older one that came late', () => {
    const shown = reminderNotification(push({ at: 2_000 }), undefined);
    expect(reminderNotification(push({ kind: 'finished', at: 3_000 }), shown)).toMatchObject({ title: 'Chief finished', options: { renotify: true, data: { at: 3_000 } } });
    expect(reminderNotification(push({ kind: 'finished', at: 1_000 }), shown)).toEqual({ title: 'Chief needs you', options: { ...shown.options, renotify: false } });
  });

  it('shows "Orchard" for a push that is no reminder, as Web Push requires something shown', () => {
    for (const text of [undefined, '', 'hello', JSON.stringify({ ...REMINDER, v: 2 })]) {
      expect(reminderNotification(text, undefined)).toMatchObject({ title: 'Orchard', options: { tag: 'orchard', data: { url: '/' } } });
    }
  });
});

describe('where a click goes', () => {
  it.each([
    [{ url: '/?mode=bot&section=team&bot=chief' }, '/?mode=bot&section=team&bot=chief'],
    [{ url: 'https://evil.example/' }, '/'], [{ url: '//evil.example/' }, '/'], [{ url: 'javascript:alert(1)' }, '/'], [{}, '/'], [null, '/'],
  ])('%j opens %s', (data, address) => { expect(clickAddress(data)).toBe(address); });

  it.each([
    ['the conversation in Bot mode', '/?mode=bot&section=team&bot=chief', true],
    ['with more of the page\'s own state', '/?mode=bot&section=team&bot=chief&layout=wide', true],
    ['another assistant', '/?mode=bot&section=team&bot=builder', false],
    ['the group, not the assistant', '/?mode=bot&section=team', false],
    ['Settings over it', '/?mode=bot&section=team&bot=chief&page=settings', false],
    ['another site', 'https://other.example/?mode=bot&section=team&bot=chief', false],
  ])('a page showing %s shows it: %s', (_name, page, shows) => {
    expect(showsConversation(new URL(page, ORIGIN).href, REMINDER.url, ORIGIN)).toBe(shows);
  });

  const page = (path: string, extra: Partial<WorkerPage> = {}): WorkerPage => ({ url: new URL(path, ORIGIN).href, focused: false, visibilityState: 'hidden', ...extra });
  it.each([
    ['a page that shows it is focused', [page('/?mode=bot'), page(REMINDER.url)], { kind: 'focus', page: 1 }],
    ['else the focused page goes there', [page('/?mode=window'), page('/?mode=bot', { focused: true })], { kind: 'navigate', page: 1, url: ORIGIN + REMINDER.url }],
    ['else a visible one', [page('/?mode=window'), page('/?mode=bot', { visibilityState: 'visible' })], { kind: 'navigate', page: 1, url: ORIGIN + REMINDER.url }],
    ['else any page of the app', [page('/?mode=window')], { kind: 'navigate', page: 0, url: ORIGIN + REMINDER.url }],
    ['with no page running, the conversation opens', [], { kind: 'open', url: ORIGIN + REMINDER.url }],
  ] as const)('%s', (_name, pages, action) => { expect(clickAction(REMINDER.url, pages, ORIGIN)).toEqual(action); });
});

/** A worker scope in memory: what it shows, what the badge is, its pages, and what a click did. */
function worker(pages: Array<WorkerPage & { navigable?: boolean }> = []) {
  const shown = new Map<string, ShownNotification>(), done: string[] = [];
  let badge = false;
  const ports: PushWorkerPorts = {
    origin: ORIGIN,
    show: async notification => { shown.set(notification.options.tag, notification); done.push(`show ${notification.title}`); },
    shown: async tag => shown.get(tag),
    badge: async () => { badge = true; },
    pages: async () => pages.map((each, index) => ({ ...each, focus: async () => { done.push(`focus ${index}`); },
      navigate: async (url: string) => { done.push(`navigate ${index} ${url}`); return each.navigable === false ? null : {}; } })),
    open: async url => { done.push(`open ${url}`); },
  };
  return { ports, shown, done, badge: () => badge };
}

describe('the worker\'s events', () => {
  it('a push shows its reminder in place of the session\'s older one and sets the badge\'s dot', async () => {
    const w = worker();
    await receivePush(push({ at: 1 }), w.ports);
    await receivePush(push({ kind: 'finished', at: 2 }), w.ports);
    expect(w.done).toEqual(['show Chief needs you', 'show Chief finished']);
    expect([...w.shown.keys()]).toEqual(['schief']);
    expect(w.badge()).toBe(true);
  });

  it('a click focuses the page that shows it, takes another page there, or opens one when that page cannot go', async () => {
    const showing = worker([{ url: ORIGIN + REMINDER.url, focused: false, visibilityState: 'hidden' }]);
    await followClick({ url: REMINDER.url }, showing.ports);
    expect(showing.done).toEqual(['focus 0']);
    const elsewhere = worker([{ url: `${ORIGIN}/?mode=window`, focused: true, visibilityState: 'visible' }]);
    await followClick({ url: REMINDER.url }, elsewhere.ports);
    expect(elsewhere.done).toEqual([`navigate 0 ${ORIGIN}${REMINDER.url}`, 'focus 0']);
    const stuck = worker([{ url: `${ORIGIN}/?mode=window`, focused: true, visibilityState: 'visible', navigable: false }]);
    expect(await followClick({ url: REMINDER.url }, stuck.ports)).toEqual({ kind: 'open', url: ORIGIN + REMINDER.url });
    expect(stuck.done).toEqual([`navigate 0 ${ORIGIN}${REMINDER.url}`, `open ${ORIGIN}${REMINDER.url}`]);
    const none = worker();
    await followClick({ url: REMINDER.url }, none.ports);
    expect(none.done).toEqual([`open ${ORIGIN}${REMINDER.url}`]);
  });
});
