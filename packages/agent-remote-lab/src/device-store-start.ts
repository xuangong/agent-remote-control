import { deviceStore } from '@orchardworks/agent-remote-web/device-store';
import { conversationLocalStorage, storageKeys } from './conversation-storage.js';
import { readWorkspaceAccess, scopeFor } from './workspace-access.js';

/**
 * The previous release kept the last six conversations as plain display copies in localStorage, with no principal. They are removed once at start. This is the only
 * remaining reference to those keys and is deleted one release later.
 */
const legacyDisplayCache = /^agent-remote:recovery:.+:workspace(?::.*)?$/;
export function removeLegacyDisplayCache(): void {
  try { for (const key of storageKeys(conversationLocalStorage)) if (legacyDisplayCache.test(key)) conversationLocalStorage.removeItem(key); }
  catch { /* Storage may be unavailable; there is nothing to remove then. */ }
}

/** Loads this device's stored conversations of the signed-in workspace into memory, so the first render reads them synchronously. They are shown only once the Relay confirms the lease. */
export function startDeviceStore(gatewayMode: boolean): Promise<void> {
  removeLegacyDisplayCache();
  const access = gatewayMode ? readWorkspaceAccess() : undefined;
  if (gatewayMode && !access) return Promise.resolve();
  const scope = { relayUrl: scopeFor(access?.basePath ?? window.location.origin), principalId: access?.user?.id ?? 'workspace' };
  return deviceStore.preload(scope).catch(() => { /* The conversation opens without stored rows. */ });
}
