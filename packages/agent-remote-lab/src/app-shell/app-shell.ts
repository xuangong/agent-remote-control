/**
 * The installed app's service worker: an app shell that starts from the device. Its push reminders and their clicks are push-events.ts (I5c).
 * - The shell is the page (`/`) and the bundles it starts with; each build lists them and names its version (app-shell-plugin.ts). The
 *   worker stores the whole shell at install, so a build's page and its bundles always belong together.
 * - Opening the page answers from the stored shell at once, cache first: a slow or hung network never delays the first paint. The page is
 *   not refreshed from the network. A new build is found by the browser's own check of `/sw.js` (at every navigation, and when the app
 *   comes back to the front, register.ts); its worker stores its shell in a cache of its own while this one keeps serving, and the next
 *   launch starts from it. An open page is never swapped: it keeps loading its own build's bundles from the build's cache.
 * - Built bundles are immutable (their names carry a content hash): the cache answers first and the network fills it. Only a whole
 *   bundle is kept, never an error or an HTML fallback, so a missing chunk still fails and the chunk recovery reloads (O27, O54).
 * - Other navigations (sign-in, previews, the file frame) come from the network and are never kept.
 * - Every other request, the API and session traffic included, passes by: the worker neither answers nor keeps it. Where the browser
 *   has static routes (Chromium), they send those requests to the network without waking the worker (`DIRECT_ROUTES`).
 * - A new build's worker takes over at once (`skipWaiting`) once its shell is stored, and deletes the caches of every build but the one
 *   before it, which pages that are still open on that build read their lazy bundles from.
 * Pure apart from its ports: the cache storage, the network and the event's lifetime come in as arguments.
 */

/** What a build stores for an offline start: its version and the bundles the page starts with. */
export interface AppShell { readonly version: string; readonly files: readonly string[] }

/** The facts of a request the worker decides on; the worker hands the request itself back to its ports. */
export interface ShellRequest { readonly method: string; readonly url: string; readonly mode: string }
export interface ShellCache<Request extends ShellRequest = ShellRequest> {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}
export interface ShellCaches<Request extends ShellRequest = ShellRequest> {
  open(name: string): Promise<ShellCache<Request>>;
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}
export interface ShellPorts<Request extends ShellRequest> {
  readonly caches: ShellCaches<Request>;
  fetch(request: Request | string): Promise<Response>;
}
export interface FetchContext {
  /** The worker's own origin; requests to any other pass by. */
  readonly origin: string;
  /** Keeps the worker alive for work that follows the answer, such as storing it. */
  waitUntil(work: Promise<unknown>): void;
}

/** The page every shell navigation is stored under, whatever its query: the app reads its place from the address itself. */
export const SHELL_PAGE = '/';
const CACHE_PREFIX = 'orchard-shell-';
export const shellCacheName = (version: string) => `${CACHE_PREFIX}${version}`;

/** How the worker answers a request: the app's page, a built bundle, another navigation from the network, or not at all. */
export type ShellRoute = 'page' | 'bundle' | 'navigation' | 'pass';

export function routeOf(request: ShellRequest, origin: string): ShellRoute {
  if (request.method !== 'GET') return 'pass';
  const url = new URL(request.url);
  if (url.origin !== origin) return 'pass';
  if (request.mode === 'navigate') return (url.pathname === '/' || url.pathname === '/index.html') && !url.searchParams.has('preview') ? 'page' : 'navigation';
  return url.pathname.startsWith('/assets/') ? 'bundle' : 'pass';
}

const contentType = (response: Response) => response.headers.get('content-type') ?? '';
/** The page as the shell keeps it: a whole HTML answer, not a redirect (to sign in) or an error. */
const isShell = (response: Response) => response.status === 200 && !response.redirected && contentType(response).includes('text/html');
/**
 * A built bundle as the cache keeps it: a whole answer of its kind. A script or a stylesheet that comes back as anything else (an error
 * page, an HTML fallback, a portal's page) is never kept, so the next request asks the network again.
 */
function isBundle(path: string, response: Response): boolean {
  if (response.status !== 200 || response.redirected || contentType(response).includes('text/html')) return false;
  const kind = /\.(js|css)$/.exec(path)?.[1];
  return !kind || contentType(response).includes(kind === 'js' ? 'javascript' : 'css');
}

/** A static route: navigations, or a path on the worker's own origin or on any. */
export type DirectRoute =
  | { readonly navigations: true; readonly source: 'fetch-event' }
  | { readonly pathname: string; readonly ownOrigin: boolean; readonly source: 'fetch-event' | 'network' };
/**
 * What the worker never answers, as the browser's static routes (first match wins): navigations and its own origin's built bundles come
 * to the worker, everything else goes straight to the network. It says what `routeOf` says; the worker registers it where the browser can.
 */
export const DIRECT_ROUTES: readonly DirectRoute[] = [
  { navigations: true, source: 'fetch-event' },
  { pathname: '/assets/*', ownOrigin: true, source: 'fetch-event' },
  { pathname: '/*', ownOrigin: false, source: 'network' },
];

/** The worker for one build: install, activate and fetch, each over the ports. */
export function appShellWorker<Request extends ShellRequest>(shell: AppShell, ports: ShellPorts<Request>) {
  const name = shellCacheName(shell.version);
  const cache = () => ports.caches.open(name);

  /** The page from this build's stored shell; from the network, kept, only where the install has not stored it yet. */
  async function page(request: Request, context: FetchContext): Promise<Response> {
    const kept = await (await cache()).match(SHELL_PAGE);
    if (kept) return kept;
    const response = await ports.fetch(request);
    if (isShell(response)) {
      const copy = response.clone();
      context.waitUntil(cache().then(store => store.put(SHELL_PAGE, copy)));
    }
    return response;
  }

  /** A built bundle from this build's cache, else the previous build's (a page still open on it), else the network into this cache. */
  async function bundle(request: Request, context: FetchContext): Promise<Response> {
    const store = await cache();
    const kept = await store.match(request) ?? await olderBuilds().then(async names => {
      for (const older of names) { const found = await (await ports.caches.open(older)).match(request); if (found) return found; }
      return undefined;
    });
    if (kept) return kept;
    const response = await ports.fetch(request);
    if (isBundle(new URL(request.url).pathname, response)) {
      const copy = response.clone();
      context.waitUntil(store.put(request, copy));
    }
    return response;
  }

  /** The other builds' caches, newest first (the storage lists them in the order they were created). */
  async function olderBuilds(): Promise<string[]> {
    return (await ports.caches.keys()).filter(key => key.startsWith(CACHE_PREFIX) && key !== name).reverse();
  }

  return {
    /** Stores the shell. A failed fetch fails the install and leaves the worker before it in charge. */
    async install(): Promise<void> {
      const store = await cache();
      try {
        for (const file of [SHELL_PAGE, ...shell.files]) {
          const response = await ports.fetch(file);
          if (!(file === SHELL_PAGE ? isShell(response) : isBundle(file, response))) throw new Error(`The app shell could not store ${file} (${response.status} ${contentType(response)}).`);
          await store.put(file, response);
        }
      } catch (failure) {
        await ports.caches.delete(name);
        throw failure;
      }
    },
    /** Deletes the caches of every build but this one and the one before it. */
    async activate(): Promise<void> {
      const [, ...stale] = await olderBuilds();
      await Promise.all(stale.map(key => ports.caches.delete(key)));
    },
    /** The answer to a request, or `undefined` to let the browser fetch it as if there were no worker. */
    respond(request: Request, context: FetchContext): Promise<Response> | undefined {
      switch (routeOf(request, context.origin)) {
        case 'page': return page(request, context);
        case 'bundle': return bundle(request, context);
        case 'navigation': return ports.fetch(request);
        case 'pass': return undefined;
      }
    },
  };
}
