import { createPageLifecycle, deviceStore, installPageLifecycle } from '@orchardworks/agent-client';
import { createBrowserDeviceDatabase } from '../browser-database.js';

/**
 * Connects the headless client to this browser page: its visibility and resume events, and IndexedDB for the device store. Importing the
 * package's entries does this once; a page without `window` or `document` keeps the client's inert defaults.
 */
export function installBrowserEnvironment(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  installPageLifecycle(createPageLifecycle({ window, document }));
  // The database reports whether IndexedDB exists each time the store asks, so a browser without it only costs the store its disk copies.
  deviceStore.useDatabase(createBrowserDeviceDatabase());
}
installBrowserEnvironment();
