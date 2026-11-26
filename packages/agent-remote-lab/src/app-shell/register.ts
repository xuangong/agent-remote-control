/**
 * Registers the app's service worker (`/sw.js`, app-shell.ts) once the page has loaded, in a production build on a secure origin. The
 * browser checks the script for an update at every navigation, bypassing its HTTP cache. A refused registration leaves the page as it was.
 */
import { SERVICE_WORKER_PATH } from '@orchardworks/agent-relay-core/static-site';

export interface AppShellHost {
  readonly navigator: { readonly serviceWorker?: { register(url: string, options: RegistrationOptions): Promise<{ update(): Promise<unknown> } | void> } };
  readonly document: { readonly readyState: DocumentReadyState; readonly visibilityState: DocumentVisibilityState };
  addEventListener(type: 'load', listener: () => void, options: { once: true }): void;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** An installed app that stays in the background for days never navigates, so it asks for a new build when it comes back, at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 15 * 60_000;

export function registerAppShell(host: AppShellHost, built: boolean, now: () => number = Date.now): void {
  const workers = host.navigator.serviceWorker;
  if (!built || !workers) return;
  let registration: { update(): Promise<unknown> } | undefined;
  let checked = now();
  const register = () => {
    workers.register(SERVICE_WORKER_PATH, { scope: '/', updateViaCache: 'none' }).then(found => { registration = found || undefined; }).catch(() => undefined);
  };
  if (host.document.readyState === 'complete') register();
  else host.addEventListener('load', register, { once: true });
  // The new build is only fetched and stored; the person keeps the page they have, and the next launch starts from the new one.
  host.addEventListener('visibilitychange', () => {
    if (host.document.visibilityState !== 'visible' || !registration || now() - checked < UPDATE_CHECK_INTERVAL_MS) return;
    checked = now();
    registration.update().catch(() => undefined);
  });
}
