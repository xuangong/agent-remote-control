/**
 * The push events of a service worker's scope wired to `push-worker.ts`: `push` shows the reminder and sets the badge's dot,
 * `notificationclick` closes the notification and follows it. The app's worker installs them as they are; a test worker gives some ports
 * of its own, since a browser lets only a person's click open or focus a window.
 */
import { followClick, receivePush, type PushWorkerPorts, type ReminderData, type ShownNotification } from './push-worker.js';

interface ExtendableEvent extends Event { waitUntil(work: Promise<unknown>): void }
interface PushEvent extends ExtendableEvent { readonly data: { text(): string } | null }
interface NotificationClickEvent extends ExtendableEvent { readonly notification: { readonly data: unknown; close(): void } }
interface WorkerNotification { readonly title: string; readonly tag: string; readonly data: unknown; readonly icon?: string; readonly badge?: string; readonly lang?: string }
interface WorkerWindow { readonly url: string; readonly focused: boolean; readonly visibilityState: string; focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }

/** The parts of a service worker's scope the push events use; the worker's own types are not in the page's. */
export interface PushWorkerScope {
  readonly location: { readonly origin: string };
  readonly registration: {
    showNotification(title: string, options: NotificationOptions): Promise<void>;
    getNotifications(filter?: { tag?: string }): Promise<WorkerNotification[]>;
  };
  readonly clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WorkerWindow[]>;
    openWindow(url: string): Promise<unknown>;
  };
  readonly navigator: { setAppBadge?(): Promise<void> };
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationClickEvent) => void): void;
}

const reminderData = (data: unknown): ReminderData => {
  const value = data as Partial<ReminderData> | null;
  return { url: typeof value?.url === 'string' ? value.url : '/', at: typeof value?.at === 'number' ? value.at : 0, ...(value?.kind ? { kind: value.kind } : {}) };
};

/** The ports of a worker's own scope. */
export function pushWorkerPorts(scope: PushWorkerScope): PushWorkerPorts {
  return {
    origin: scope.location.origin,
    show: notification => scope.registration.showNotification(notification.title, notification.options),
    async shown(tag) {
      const [found] = await scope.registration.getNotifications({ tag });
      if (!found) return undefined;
      const shown: ShownNotification = { title: found.title, options: { tag: found.tag, data: reminderData(found.data),
        ...(found.icon ? { icon: found.icon } : {}), ...(found.badge ? { badge: found.badge } : {}), ...(found.lang ? { lang: found.lang } : {}) } };
      return shown;
    },
    async badge() { await scope.navigator.setAppBadge?.(); },
    pages: () => scope.clients.matchAll({ type: 'window', includeUncontrolled: true }),
    open: url => scope.clients.openWindow(url),
  };
}

/** Listens for pushes and notification clicks in `scope`, through `ports` (the scope's own by default). */
export function installPushEvents(scope: PushWorkerScope, ports: PushWorkerPorts = pushWorkerPorts(scope)): void {
  scope.addEventListener('push', event => event.waitUntil(receivePush(event.data?.text(), ports)));
  scope.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(followClick(event.notification.data, ports));
  });
}
