/**
 * Registers the app's service worker (`/sw.js`, app-shell.ts) once the page has loaded, in a production build on a secure origin. The
 * browser checks the script for an update at every navigation, bypassing its HTTP cache. A refused registration leaves the page as it was.
 */
import { SERVICE_WORKER_PATH } from '@orchardworks/agent-relay-core/static-site';

export interface AppShellHost {
  readonly navigator: { readonly serviceWorker?: { register(url: string, options: RegistrationOptions): Promise<unknown> } };
  readonly document: { readonly readyState: DocumentReadyState };
  addEventListener(type: 'load', listener: () => void, options: { once: true }): void;
}

export function registerAppShell(host: AppShellHost, built: boolean): void {
  const workers = host.navigator.serviceWorker;
  if (!built || !workers) return;
  const register = () => { workers.register(SERVICE_WORKER_PATH, { scope: '/', updateViaCache: 'none' }).catch(() => undefined); };
  if (host.document.readyState === 'complete') register();
  else host.addEventListener('load', register, { once: true });
}
