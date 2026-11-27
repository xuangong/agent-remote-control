/**
 * The page as a web app added to the home screen. Safari deletes every script-writable storage of a site after seven days of use without a
 * visit to it, and a home-screen app keeps its own count, so an installed app asks the browser to keep its storage: the device store's
 * conversations and the pending messages of the composer then survive a week away. WebKit grants it to home-screen apps; a browser tab
 * does not ask, because the browser decides for a site by itself there.
 */

/** What this module reads of a page. */
export interface InstalledAppView {
  readonly navigator: { readonly standalone?: boolean; readonly storage?: { persist?(): Promise<boolean> } };
  matchMedia?(query: string): { readonly matches: boolean };
}

/**
 * Whether this page runs as the installed app: iOS's `navigator.standalone`, or the app's display modes elsewhere: standalone, or the
 * window controls overlay a desktop app window shows when its title bar is hidden.
 */
export function runsInstalled(view: InstalledAppView = window as unknown as InstalledAppView): boolean {
  return view.navigator.standalone === true || ['standalone', 'window-controls-overlay'].some(mode => view.matchMedia?.(`(display-mode: ${mode})`).matches === true);
}

/**
 * Asks the browser to keep this origin's storage when the page runs as the installed app; resolves with the browser's answer, or
 * undefined when the page did not ask (a tab, or a browser without the Storage API). It never rejects: the app works without it.
 */
export async function keepInstalledAppStorage(view: InstalledAppView = window as unknown as InstalledAppView): Promise<boolean | undefined> {
  if (!runsInstalled(view) || typeof view.navigator.storage?.persist !== 'function') return undefined;
  try { return await view.navigator.storage.persist(); } catch { return false; }
}

/**
 * Whether the platform draws its own swipe back from the left edge for the page's history: iOS and iPadOS WebKit as a home-screen app.
 * iOS alone defines `navigator.standalone`; an iPad that asks for the desktop site is told by Apple's vendor string, touch and the
 * standalone display mode. Chromium on Android and desktop browsers have no such gesture on a page, so the page draws its own.
 */
export function platformSwipesBack(view: InstalledAppView & { navigator: { vendor?: string; maxTouchPoints?: number } } = window as never): boolean {
  if (view.navigator.standalone === true) return true;
  return view.matchMedia?.('(display-mode: standalone)').matches === true && /Apple/i.test(view.navigator.vendor ?? '') && (view.navigator.maxTouchPoints ?? 0) > 0;
}
