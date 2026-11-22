/**
 * This device's "Notify me on this device" for Settings > Assistants and for the page's own reminders: `push-device.ts` over the
 * browser's service worker, push manager and permission, and the Relay's `/v1/push-subscriptions`. It reconciles at each start and when
 * the page comes back, and tells the Relay when the device's language or its Notifications switch changes.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { HttpPushClient } from '@orchardworks/agent-client';
import type { PushLocale } from '@orchardworks/agent-remote-protocol';
import { installPlatform } from './app-install.js';
import { runsInstalled } from './installed-app.js';
import { createPushDevice, type PushDeviceView, type PushRegistration } from './push-device.js';
import { workspaceFetch } from './workspace-access.js';

export interface PushDeviceControls extends PushDeviceView { enable(): void; disable(): void }

/** How long a page waits for its service worker to be ready before it says push is unavailable here. */
const WORKER_WAIT_MS = 3_000;

/** The page's service worker registration: the one it has, or the one that becomes ready shortly after the page starts. */
async function serviceWorkerRegistration(): Promise<PushRegistration | undefined> {
  const workers = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (!workers || typeof window === 'undefined' || !('PushManager' in window)) return undefined;
  const found = await workers.getRegistration().catch(() => undefined);
  if (found) return found as unknown as PushRegistration;
  return Promise.race([workers.ready as Promise<unknown> as Promise<PushRegistration>, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), WORKER_WAIT_MS))]);
}

export function usePushDevice(baseUrl: string, active: boolean, settings: { locale: PushLocale; paused: boolean }): PushDeviceControls {
  const latest = useRef(settings);
  latest.current = settings;
  const device = useMemo(() => createPushDevice({
    facts: () => ({
      pushManager: typeof window !== 'undefined' && 'PushManager' in window,
      notifications: typeof Notification !== 'undefined',
      ios: typeof navigator !== 'undefined' && installPlatform(navigator.userAgent, navigator.maxTouchPoints ?? 0) === 'ios',
      installed: typeof window !== 'undefined' && runsInstalled(),
      permission: typeof Notification === 'undefined' ? 'denied' : Notification.permission,
    }),
    relay: new HttpPushClient(baseUrl, workspaceFetch),
    registration: serviceWorkerRegistration,
    requestPermission: () => typeof Notification === 'undefined' ? Promise.resolve('denied' as NotificationPermission) : Notification.requestPermission(),
  }, { locale: () => latest.current.locale, paused: () => latest.current.paused }), [baseUrl]);
  const view = useSyncExternalStore(device.subscribe, device.view, device.view);
  useEffect(() => {
    if (!active) return;
    void device.refresh();
    const again = () => { if (document.visibilityState === 'visible') void device.refresh(); };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [device, active]);
  useEffect(() => { if (active) void device.sync(); }, [device, active, settings.locale, settings.paused]);
  return useMemo(() => ({ ...view, enable: () => { void device.enable(); }, disable: () => { void device.disable(); } }), [view, device]);
}
