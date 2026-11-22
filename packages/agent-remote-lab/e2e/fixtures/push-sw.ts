// A service worker for the push component spec: the app worker's push events (push-events.ts) over the worker's own scope, except what
// a browser lets only a person's click do (focus a window, open one) and what a headless browser cannot do (show a notification, set a
// badge): those are recorded. `self.__push.click(data)` follows a click as the worker's notificationclick does, for a test that cannot
// click a notification.
import { installPushEvents, pushWorkerPorts, type PushWorkerScope } from '../../src/app-shell/push-events.js';
import { followClick, type PushWorkerPorts } from '../../src/app-shell/push-worker.js';

type Scope = PushWorkerScope & { skipWaiting(): Promise<void>; clients: PushWorkerScope['clients'] & { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: Event & { waitUntil(work: Promise<unknown>): void }) => void): void; __push?: unknown };
const scope = self as unknown as Scope;
const record: Array<Record<string, unknown>> = [];
const own = pushWorkerPorts(scope);
const ports: PushWorkerPorts = {
  ...own,
  show: async notification => { record.push({ type: 'show', title: notification.title, tag: notification.options.tag, data: notification.options.data, lang: notification.options.lang }); },
  badge: async () => { record.push({ type: 'badge' }); },
  pages: async () => (await own.pages()).map(page => ({ url: page.url, focused: page.focused, visibilityState: page.visibilityState,
    focus: async () => { record.push({ type: 'focus', url: page.url }); }, navigate: (url: string) => page.navigate(url) })),
  open: async url => { record.push({ type: 'open', url }); },
};
installPushEvents(scope, ports);
scope.__push = { record, click: (data: unknown) => followClick(data, ports) };
scope.addEventListener('install', event => event.waitUntil(scope.skipWaiting()));
scope.addEventListener('activate', event => event.waitUntil(scope.clients.claim()));
