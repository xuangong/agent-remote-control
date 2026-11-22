/**
 * The service worker's push reminders (I5c): what it shows for a push, and where a click on it goes. Pure apart from its ports, which
 * `service-worker.ts` gives it from the worker's scope.
 * - A push shows one notification: "Chief needs you" or "Builder finished", in the device's language, with no other text, tagged by
 *   its session so a session has one notification on screen. Push services promise no order: a reminder older than the one shown for
 *   its session shows that one again, quietly, instead of replacing it. A push that is no reminder still shows something ("Orchard"),
 *   as Web Push requires. Each push sets the app badge's dot.
 * - A click focuses a page that already shows the conversation; otherwise it takes a page of the app there; with no page running, it
 *   opens the conversation's address.
 */
import { decodePushReminder, type PushReminder, type PushReminderKind } from '@orchardworks/agent-remote-protocol';

/** The notification's title for each kind, in each language a reminder speaks. */
export const PUSH_TITLES: Readonly<Record<PushReminder['locale'], Readonly<Record<PushReminderKind, string>>>> = {
  en: { needs_you: '{name} needs you', finished: '{name} finished' },
  zh: { needs_you: '{name} 需要你', finished: '{name} 做完了' },
};
const GENERIC_TAG = 'orchard';

/** What a notification of ours carries for its click and for ordering. */
export interface ReminderData { readonly url: string; readonly at: number; readonly kind?: PushReminderKind }
export interface ShownNotification { readonly title: string; readonly options: NotificationOptions & { readonly tag: string; readonly data: ReminderData; readonly renotify?: boolean } }

/** The notification for a push's text, given the one already shown for the same tag, if any. */
export function reminderNotification(text: string | undefined, shown: ShownNotification | undefined): ShownNotification {
  const reminder = decodePushReminder(text);
  if (!reminder) return { title: 'Orchard', options: { tag: GENERIC_TAG, data: { url: '/', at: 0 }, icon: '/app/icon-192.png', badge: '/app/icon-monochrome-192.png' } };
  if (shown && shown.options.tag === reminder.tag && shown.options.data.at > reminder.at) return { title: shown.title, options: { ...shown.options, renotify: false } };
  return { title: PUSH_TITLES[reminder.locale][reminder.kind].replace('{name}', reminder.name), options: {
    tag: reminder.tag, data: { url: reminder.url, at: reminder.at, kind: reminder.kind }, renotify: true, lang: reminder.locale === 'zh' ? 'zh-CN' : 'en',
    icon: '/app/icon-192.png', badge: '/app/icon-monochrome-192.png' } };
}

/** The address a click opens: a path on the app's own origin, never anything else. */
export function clickAddress(data: unknown): string {
  const url = (data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && /^\/(\?[^\s]*)?$/.test(url) ? url : '/';
}

const CONVERSATION_KEYS = ['mode', 'section', 'bot', 'window', 'host', 'provider', 'session'] as const;
/**
 * Whether a page at `pageUrl` shows the conversation at `address`: every place its address names (`mode`, `section`, `bot`, or a
 * Window's `window`, `host`, `provider`, `session`) is the page's, and the page shows no other page over it (Settings, Assistants).
 */
export function showsConversation(pageUrl: string, address: string, origin: string): boolean {
  let page: URL, target: URL;
  try { page = new URL(pageUrl); target = new URL(address, origin); } catch { return false; }
  if (page.origin !== origin || page.searchParams.has('page')) return false;
  const named = CONVERSATION_KEYS.filter(key => target.searchParams.has(key));
  return named.length > 0 && named.every(key => page.searchParams.get(key) === target.searchParams.get(key));
}

/** A page of the app as the worker sees it. */
export interface WorkerPage { readonly url: string; readonly focused: boolean; readonly visibilityState: string }
export type ClickAction = { readonly kind: 'focus'; readonly page: number } | { readonly kind: 'navigate'; readonly page: number; readonly url: string } | { readonly kind: 'open'; readonly url: string };

/** Where a click goes: the page that shows the conversation, else the page last used (focused, then visible, then any) taken there, else a new one. */
export function clickAction(address: string, pages: readonly WorkerPage[], origin: string): ClickAction {
  const url = new URL(address, origin).href;
  const showing = pages.findIndex(page => showsConversation(page.url, address, origin));
  if (showing >= 0) return { kind: 'focus', page: showing };
  const own = pages.map((page, index) => ({ page, index })).filter(({ page }) => { try { return new URL(page.url).origin === origin; } catch { return false; } });
  const chosen = own.find(({ page }) => page.focused) ?? own.find(({ page }) => page.visibilityState === 'visible') ?? own[0];
  return chosen ? { kind: 'navigate', page: chosen.index, url } : { kind: 'open', url };
}

/** The worker's scope as the push events use it. */
export interface PushWorkerPorts {
  readonly origin: string;
  show(notification: ShownNotification): Promise<void>;
  /** The notification shown for a tag, if any. */
  shown(tag: string): Promise<ShownNotification | undefined>;
  /** Sets the app badge's dot, where the browser has one. */
  badge(): Promise<void>;
  pages(): Promise<ReadonlyArray<WorkerPage & { focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }>>;
  open(url: string): Promise<unknown>;
}

/** A push arrived: its notification, and the badge's dot. */
export async function receivePush(text: string | undefined, ports: PushWorkerPorts): Promise<void> {
  const tag = decodePushReminder(text)?.tag ?? GENERIC_TAG;
  const notification = reminderNotification(text, await ports.shown(tag).catch(() => undefined));
  await ports.show(notification);
  await ports.badge().catch(() => undefined);
}

/** A notification was clicked: focus, take a page there, or open one. A page that cannot be taken there gives way to a new one. */
export async function followClick(data: unknown, ports: PushWorkerPorts): Promise<ClickAction> {
  const pages = await ports.pages();
  const action = clickAction(clickAddress(data), pages, ports.origin);
  if (action.kind === 'focus') { await pages[action.page]!.focus(); return action; }
  if (action.kind === 'navigate') {
    const page = pages[action.page]!;
    // `navigate` rejects for a page this worker does not control; it resolves, with null for a page that left the origin, once it went.
    if (await page.navigate(action.url).then(() => true, () => false)) { await page.focus().catch(() => undefined); return action; }
  }
  await ports.open(action.url);
  return { kind: 'open', url: action.url };
}
