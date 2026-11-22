/**
 * The app badge (I5c, owner decision of 2026-11-22): a dot on the app's icon, never a count. It shows while any assistant needs the
 * person, or has a reply they have not seen; a muted chat's unread reply does not count, its need does, as its dot in Chats. The page
 * sets or clears it from the shared state whenever it runs; the service worker sets it with each push, when no page may run.
 */
import type { BotRow } from './bot-roster.js';

export function appBadgeShown(rows: ReadonlyArray<Pick<BotRow, 'unread' | 'muted' | 'assistant'>>): boolean {
  return rows.some(row => row.assistant.state === 'needs_you' || (!!row.unread && !row.muted));
}

/** The browser's app badge, where it has one (the Badging API): a dot, or none. */
export interface AppBadge { set(): Promise<void>; clear(): Promise<void> }
export function browserBadge(view: { navigator?: { setAppBadge?(): Promise<void>; clearAppBadge?(): Promise<void> } } = globalThis as never): AppBadge | undefined {
  const navigator = view.navigator;
  if (typeof navigator?.setAppBadge !== 'function' || typeof navigator.clearAppBadge !== 'function') return undefined;
  return { set: () => navigator.setAppBadge!(), clear: () => navigator.clearAppBadge!() };
}
