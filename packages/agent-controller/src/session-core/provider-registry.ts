import type { RemoteHostCatalog } from '@orchardworks/agent-session-runtime';

import { HostRequestError } from './requests.js';
import type { AgentHostProviderRegistration } from './types.js';

/**
 * Provider registry: the one owner of which providers this Controller serves and of the catalog it keeps for each.
 *
 * Contract.
 * - A provider is added once, with its catalog; the registration and the catalog of a provider are never out of step. Adding an id that is
 *   already held, or a registration whose directory names another provider, is refused.
 * - `get` and `catalog` answer nothing for an unknown provider; `require` throws the 400 `invalid_provider` request error instead.
 * - `all` lists registrations in the order they were added; `ids` lists their provider ids in the same order.
 * - `dispose` disposes every catalog. It does not close directories; the caller owns that.
 *
 * Mutable state: the registrations and catalogs, assigned only here. Callers hold no reference to either collection.
 */
export interface ProviderRegistry {
  add(registration: AgentHostProviderRegistration): void;
  has(providerId: string): boolean;
  get(providerId: string): AgentHostProviderRegistration | undefined;
  require(providerId: string): AgentHostProviderRegistration;
  catalog(providerId: string): RemoteHostCatalog | undefined;
  all(): AgentHostProviderRegistration[];
  ids(): string[];
  dispose(): void;
}

export function createProviderRegistry(createCatalog: (registration: AgentHostProviderRegistration) => RemoteHostCatalog): ProviderRegistry {
  const registrations = new Map<string, AgentHostProviderRegistration>();
  const catalogs = new Map<string, RemoteHostCatalog>();
  return {
    add(registration) {
      const id = registration.adapter.descriptor.providerId;
      if (registration.directory.providerId !== id) throw new Error(`Directory provider identity does not match ${id}.`);
      if (registrations.has(id)) throw new Error(`Duplicate Agent Host provider: ${id}.`);
      registrations.set(id, registration);
      catalogs.set(id, createCatalog(registration));
    },
    has: providerId => registrations.has(providerId),
    get: providerId => registrations.get(providerId),
    require(providerId) {
      const value = registrations.get(providerId);
      if (!value) throw new HostRequestError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
      return value;
    },
    catalog: providerId => catalogs.get(providerId),
    all: () => [...registrations.values()],
    ids: () => [...registrations.keys()],
    dispose() { for (const catalog of catalogs.values()) catalog.dispose(); },
  };
}
