/**
 * The browser lifecycle simulator: what a phone does to a web page, driven through Playwright's own controls, deterministically and the
 * same way in WebKit and Chromium. The component tier and the e2e flows use it alike.
 *
 * What it models (`MODELLED`, compared with a real iPhone by the release check of `docs/current/agent-remote/web.md`):
 * - **hidden**: the page is hidden and runs on, as after a switch to another tab (`hide`, `show`);
 * - **suspended**: hidden, then no timer runs, as iOS freezes a page when the person switches apps; its WebSockets may die meanwhile, closed
 *   or half-open (open to the page, carrying nothing either way). On `resume` the timers jump by the time away, so every timer that fell due
 *   fires once, before the page is shown again (`suspend`, `resume`);
 * - **the back-forward cache**: `pagehide` with `persisted`, timers frozen and sockets closed, as WebKit closes a cached page's sockets; then
 *   `pageshow` with `persisted` (`enterBackForwardCache`, `restoreFromBackForwardCache`). Playwright turns the browsers' own cache off, so this
 *   is the cache as the page observes it;
 * - **ended by the operating system**: no `visibilitychange`, `pagehide`, `beforeunload` or `unload` reaches the page and no timer runs again
 *   (`kill`);
 * - **storage eviction**: every script-writable storage of the origin is deleted (IndexedDB, localStorage, sessionStorage, Cache Storage),
 *   as Safari does after seven days without a visit, while the server's cookies stay (`evictStorage`);
 * - **the installed web app**: `navigator.standalone` and the `display-mode: standalone` media query, and a count of the page's
 *   `navigator.storage.persist()` requests (`standalone`, `persistRequests`);
 * - **the installed desktop app with its title bar given to the page** (Window Controls Overlay): `navigator.windowControlsOverlay`
 *   with the title bar area clear of the window's controls, its `geometrychange` event, and the `display-mode: window-controls-overlay`
 *   media query; showing the title bar again turns the window back to `standalone` (`titleBar`, `setTitleBar`). Playwright has no
 *   emulation of the overlay, and Chromium's DevTools one (`Overlay.setShowWindowControlsOverlay`) has no effect in headless Chromium,
 *   so the page's CSS `env(titlebar-area-*)` values stay unset: the page takes the area from the overlay's API.
 *
 * Time is Playwright's clock, installed before the page loads; it runs in real time until a suspension pauses it. A resume moves the page's
 * timers and `performance.now()` by the time away, but not its wall clock, which stays the real time: the Relay's clock cannot jump with it,
 * and a page whose `Date` ran ahead of the Relay's would read every lease the Relay grants as expired. So what the Relay does with time
 * (a lease ending, an idle socket closed) does not happen during a simulated absence. Visibility is the page's own
 * `document.visibilityState`, announced with the events a browser sends. Sockets are the caller's route (`LifecycleSockets`), so a flow's
 * WebSocket route serves both; a page without one cannot have its sockets killed.
 */
import type { BrowserContext, Page } from '@playwright/test';

export const MODELLED = ['hidden', 'suspended', 'socket-closed', 'socket-half-open', 'back-forward-cache', 'ended-by-os', 'storage-evicted', 'installed-app', 'window-controls-overlay'] as const;

/** The WebSockets of a page as a route sees them. */
export interface LifecycleSockets {
  /** Closes every open WebSocket of the page as a lost network does (1006); returns how many. */
  drop(): Promise<number>;
  /** Cuts the Relay's side of every open WebSocket while the page's side stays open and carries nothing until `drop`; returns how many. */
  cut(): number;
  /** Makes every open WebSocket half-open: nothing passes either way and no close reaches the page. Sockets opened later work; returns how many. */
  halfOpen(): number;
}

/** The title bar area of an installed desktop app window, in CSS pixels: the part of its top edge clear of the window's controls. */
export interface TitleBarArea { x: number; y: number; width: number; height: number }

export interface LifecycleOptions {
  /** The page runs as a web app added to the home screen. */
  standalone?: boolean;
  /** The page runs as an installed desktop app whose window gives its title bar to the page, with this area clear of its controls. */
  titleBar?: TitleBarArea;
  /** The page's WebSocket route, needed to kill sockets in a suspension or the back-forward cache. */
  sockets?: LifecycleSockets;
}

/** What happens to the page's WebSockets while it is away. */
export type SocketFate = 'kept' | 'closed' | 'half-open';

export interface PageLifecycle {
  /** The page is hidden and keeps running. */
  hide(): Promise<void>;
  /** The page is visible again. */
  show(): Promise<void>;
  /** Hidden, then frozen: no timer runs until `resume`. `closed` sockets learn of their end on waking; `half-open` ones never do. */
  suspend(options?: { sockets?: SocketFate }): Promise<void>;
  /** Wakes the page after `afterMs` away: the clock jumps, every timer that fell due fires once, the page is shown and time runs again. */
  resume(options?: { afterMs?: number }): Promise<void>;
  /** The page leaves into the back-forward cache: `pagehide` (persisted), hidden, frozen, its sockets closed (when it has a route). */
  enterBackForwardCache(): Promise<void>;
  /** The page comes back from the cache after `afterMs`: the clock jumps, the page is shown, `pageshow` (persisted), time runs again. */
  restoreFromBackForwardCache(options?: { afterMs?: number }): Promise<void>;
  /** Stops the page's clock where it is while the page stays shown, so a flow places the next step at an exact page time. */
  pauseTime(): Promise<void>;
  /** Runs the page's timers for `ms` at once, in order, as if that time had passed while it ran. */
  advance(ms: number): Promise<void>;
  /** The operating system ends the page: it hears nothing, and nothing it queued runs again. */
  kill(): Promise<void>;
  /** How many times the page asked the browser to keep its storage (`navigator.storage.persist()`). */
  persistRequests(): Promise<number>;
  /** The person hides the window's title bar again (`area`), or shows it (`undefined`); the page hears `geometrychange`. */
  setTitleBar(area: TitleBarArea | undefined): Promise<void>;
}

interface PageState { hidden: boolean; ended: boolean; persistRequests: number; setTitleBar?(area: TitleBarArea | null): void }
const FREEZE_LEAD_MS = 25;

/** Runs in the page before any of its scripts: visibility the simulator sets, the silence of an ended page, the installed app. */
function preparePage({ standalone, titleBar }: { standalone: boolean; titleBar: TitleBarArea | null }): void {
  const state: PageState = { hidden: false, ended: false, persistRequests: 0 };
  Object.defineProperty(window, '__arcLifecycle', { value: state });
  const visibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')!;
  const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')!;
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, enumerable: true, get(this: Document) { return state.hidden ? 'hidden' : visibility.get!.call(this); } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, enumerable: true, get(this: Document) { return state.hidden || hidden.get!.call(this) as boolean; } });
  // These listeners are the page's first, so an ended page's own listeners never hear its end.
  for (const type of ['visibilitychange', 'pagehide', 'beforeunload', 'unload', 'freeze']) {
    window.addEventListener(type, event => { if (state.ended) event.stopImmediatePropagation(); }, true);
  }
  const storage = navigator.storage as StorageManager | undefined;
  if (storage?.persist) {
    const persist = storage.persist.bind(storage);
    storage.persist = () => { state.persistRequests += 1; return persist(); };
  }
  if (!standalone && !titleBar) return;
  if (standalone) Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, enumerable: true, get: () => true });
  // The desktop app's window: the overlay while its title bar is given to the page, the standalone display mode while it shows one.
  let area = titleBar;
  if (titleBar) {
    const overlay = new EventTarget();
    Object.defineProperty(overlay, 'visible', { get: () => !!area });
    Object.defineProperty(overlay, 'getTitlebarAreaRect', { value: () => area ? new DOMRect(area.x, area.y, area.width, area.height) : new DOMRect(0, 0, 0, 0) });
    Object.defineProperty(Navigator.prototype, 'windowControlsOverlay', { configurable: true, enumerable: true, get: () => overlay });
    state.setTitleBar = next => { area = next ?? null; overlay.dispatchEvent(new Event('geometrychange')); };
  }
  const displayMode = () => titleBar && area ? 'window-controls-overlay' : 'standalone';
  const matchMedia = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    const list = matchMedia(query);
    const mode = /display-mode\s*:\s*([\w-]+)/.exec(query)?.[1];
    if (!mode) return list;
    return new Proxy(list, { get: (target, key) => key === 'matches' ? mode === displayMode() : (value => typeof value === 'function' ? value.bind(target) : value)(Reflect.get(target, key, target)) });
  };
}

/** Installs the simulator on a page that has not loaded yet: call it before the page's first `goto`. */
export async function installLifecycle(page: Page, options: LifecycleOptions = {}): Promise<PageLifecycle> {
  await page.addInitScript(preparePage, { standalone: options.standalone === true, titleBar: options.titleBar ?? null });
  await page.clock.install();
  let frozen = false;
  let deadSockets = false;
  const sockets = () => {
    if (!options.sockets) throw new Error('This page has no WebSocket route: pass `sockets` to kill its sockets.');
    return options.sockets;
  };
  const setHidden = (next: boolean) => page.evaluate(value => {
    const state = (window as unknown as { __arcLifecycle: PageState }).__arcLifecycle;
    if (state.hidden === value) return;
    state.hidden = value;
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }, next);
  const pageTransition = (type: 'pagehide' | 'pageshow') => page.evaluate(name => { window.dispatchEvent(new PageTransitionEvent(name, { persisted: true })); }, type);
  // The clock pauses only at a time to come, so it stops a moment ahead of the page's now: at most FREEZE_LEAD_MS of the page's time
  // passes on the way, the time it takes the command to reach the page.
  const freeze = async () => {
    if (frozen) return;
    for (let attempt = 0; ; attempt++) {
      try { await page.clock.pauseAt(await page.evaluate(() => Date.now()) + FREEZE_LEAD_MS); break; }
      catch (error) { if (attempt >= 3 || !/past/.test(String(error))) throw error; }
    }
    frozen = true;
  };
  const wake = async (afterMs: number) => {
    if (!frozen) throw new Error('The page is not suspended.');
    if (afterMs > 0) {
      await page.clock.fastForward(afterMs);
      // The Relay's clock did not move: the wall clock goes back to the real time both sides share, while the timers stay where the jump left them.
      await page.clock.setSystemTime(Date.now());
    }
    // The page learns on waking that its sockets died while it was frozen.
    if (deadSockets) { deadSockets = false; await sockets().drop(); }
  };
  const run = async () => { frozen = false; await page.clock.resume(); };
  const killSockets = (fate: SocketFate) => {
    if (fate === 'closed') { sockets().cut(); deadSockets = true; }
    else if (fate === 'half-open') sockets().halfOpen();
  };
  return {
    hide: () => setHidden(true),
    show: () => setHidden(false),
    async suspend({ sockets: fate = 'kept' } = {}) {
      await setHidden(true);
      await freeze();
      killSockets(fate);
    },
    async resume({ afterMs = 0 } = {}) {
      await wake(afterMs);
      await setHidden(false);
      await run();
    },
    async enterBackForwardCache() {
      await pageTransition('pagehide');
      await setHidden(true);
      await freeze();
      // A page with no WebSocket route (a fixture on a stubbed transport) has no socket to close.
      if (options.sockets) killSockets('closed');
    },
    async restoreFromBackForwardCache({ afterMs = 0 } = {}) {
      await wake(afterMs);
      await setHidden(false);
      await pageTransition('pageshow');
      await run();
    },
    pauseTime: freeze,
    advance: ms => page.clock.runFor(ms),
    async kill() {
      await freeze();
      await page.evaluate(() => { (window as unknown as { __arcLifecycle: PageState }).__arcLifecycle.ended = true; });
      await page.close();
    },
    persistRequests: () => page.evaluate(() => (window as unknown as { __arcLifecycle: PageState }).__arcLifecycle.persistRequests),
    async setTitleBar(area) {
      if (!options.titleBar) throw new Error('This page is no desktop app with its title bar given to the page: pass `titleBar`.');
      await page.evaluate(next => { (window as unknown as { __arcLifecycle: PageState }).__arcLifecycle.setTitleBar?.(next); }, area ?? null);
    },
  };
}

/**
 * Deletes every script-writable storage of `origin` in `context`, as Safari does to a site not visited for seven days, and keeps its cookies.
 * Run it between visits; a page of the origin that is still open keeps its connections, and the deletion waits for them to close.
 */
export async function evictStorage(context: BrowserContext, origin: string, deadlineMs = 5_000): Promise<void> {
  const page = await context.newPage();
  try {
    const blank = new URL('/__arc-lifecycle-evict', origin).href;
    await page.route(blank, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Evict</title>' }));
    await page.goto(blank);
    const left = await page.evaluate(async deadline => {
      const databases = await indexedDB.databases();
      const blocked = await Promise.all(databases.map(({ name }) => new Promise<string | undefined>(resolve => {
        if (!name) { resolve(undefined); return; }
        const timer = setTimeout(() => resolve(name), deadline);
        const deletion = indexedDB.deleteDatabase(name);
        deletion.onsuccess = () => { clearTimeout(timer); resolve(undefined); };
        deletion.onerror = () => { clearTimeout(timer); resolve(name); };
      })));
      localStorage.clear();
      sessionStorage.clear();
      if (typeof caches !== 'undefined') for (const key of await caches.keys()) await caches.delete(key);
      return blocked.filter(Boolean);
    }, deadlineMs);
    if (left.length) throw new Error(`Storage eviction could not delete ${left.join(', ')}: a page still holds it open.`);
  } finally { await page.close(); }
}
