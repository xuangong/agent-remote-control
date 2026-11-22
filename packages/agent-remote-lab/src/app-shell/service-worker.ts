/**
 * The service worker's script, built on its own into `/sw.js` by app-shell-plugin.ts with the build's shell (`__APP_SHELL__`). It only
 * wires the worker's events: the app shell's to app-shell.ts, and push reminders and their clicks to push-events.ts (I5c). The page's
 * types know no worker scope, so the few events it handles are typed here.
 */
import { appShellWorker, DIRECT_ROUTES, type AppShell } from './app-shell.js';
import { installPushEvents, type PushWorkerScope } from './push-events.js';

declare const __APP_SHELL__: AppShell;

interface ExtendableEvent extends Event { waitUntil(work: Promise<unknown>): void }
/** Chromium's static routing: requests a route sends to the network never wake the worker. */
interface InstallEvent extends ExtendableEvent { addRoutes?(routes: readonly unknown[]): Promise<void> }
declare const URLPattern: (new (input: { pathname: string; baseURL?: string }) => unknown) | undefined;
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  readonly preloadResponse: Promise<Response | undefined>;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly registration: { readonly navigationPreload?: { enable(): Promise<void> } };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install', listener: (event: InstallEvent) => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const scope = self as unknown as WorkerScope & PushWorkerScope;
const worker = appShellWorker<Request>(__APP_SHELL__, { caches, fetch: request => fetch(request) });

/** The direct routes in the browser's terms, where it has them; a refusal leaves every request to the fetch event. */
function directRoutes(event: InstallEvent): Promise<void> {
  if (!event.addRoutes || typeof URLPattern !== 'function') return Promise.resolve();
  return event.addRoutes(DIRECT_ROUTES.map(route => 'navigations' in route
    ? { condition: { requestMode: 'navigate' }, source: route.source }
    : { condition: { urlPattern: new URLPattern({ pathname: route.pathname, ...(route.ownOrigin ? { baseURL: scope.location.origin } : {}) }) }, source: route.source }))
    .catch(() => undefined);
}

// A new build takes over as soon as its shell is stored: the page asks the network first, so no open page depends on the older worker.
scope.addEventListener('install', event => event.waitUntil(Promise.all([directRoutes(event), worker.install()]).then(() => scope.skipWaiting())));
// The navigation preload starts the page's request while the worker wakes, so a network-first open costs no worker start-up.
scope.addEventListener('activate', event => event.waitUntil(Promise.all([worker.activate(), scope.registration.navigationPreload?.enable()])));
scope.addEventListener('fetch', event => {
  const answer = worker.respond(event.request, { origin: scope.location.origin, preload: event.preloadResponse, waitUntil: work => event.waitUntil(work) });
  if (answer) event.respondWith(answer);
});
// A push shows its reminder and sets the badge's dot; a click focuses the page that shows the conversation, or opens it.
installPushEvents(scope);
