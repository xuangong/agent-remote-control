/**
 * Creation choice: which Host and provider the New session form targets, and why creating a session is unavailable.
 *
 * Contract
 * - Every function is pure; the shell passes the Host list, the provider catalog and the restored identity as data.
 * - The `local` Host is the Lab server's own provider catalog; any other Host advertises its providers in its record,
 *   and a Host without a list advertises its single `providerId` (default `dsh`).
 * - A provider choice is always one the selected Host advertises: an unknown preference falls back to its first provider.
 * - The reason creation is unavailable follows one order: an unreachable requested Host, Hosts still loading, an
 *   offline Host, an exhausted quota, then no providers. A reserved creation in flight is not blocked by its own quota.
 * - Restoring the Host runs once: first the Host a link requested, else the Host of the remembered session.
 */
import type { AgentProviderDescriptor } from '@orchardworks/agent-remote-protocol';
import type { RemoteHost } from '../kernel/remote-host.js';
import { translator, type Translate } from '@orchardworks/agent-client';

export const LOCAL_HOST_ID = 'local';

export interface ProviderChoice extends AgentProviderDescriptor { readonly hostId: string; readonly selectionId: string }

/** The providers a Host advertises. */
export function hostProviders(host: RemoteHost | undefined): readonly AgentProviderDescriptor[] {
  if (!host) return [];
  return host.providers ?? [{ providerId: host.providerId ?? 'dsh', displayName: host.providerId && host.providerId !== 'dsh' ? host.providerId : 'DeepSeek Harness' }];
}

/** The providers of the selected Host: the Lab server's own catalog for `local`, else what the Host record advertises. */
export function availableProvidersOf(selectedHostId: string, local: readonly AgentProviderDescriptor[], currentHost: RemoteHost | undefined): readonly AgentProviderDescriptor[] {
  return selectedHostId === LOCAL_HOST_ID ? local : hostProviders(currentHost);
}

/** The provider the form uses: the preferred one when the Host advertises it, else the Host's first, else none. */
export function chosenProviderId(available: readonly AgentProviderDescriptor[], preferred: string | undefined): string {
  return available.find(provider => provider.providerId === preferred)?.providerId ?? available[0]?.providerId ?? '';
}

export function providerChoices(hostId: string, available: readonly AgentProviderDescriptor[]): ProviderChoice[] {
  return available.map(provider => ({
    ...provider, hostId,
    selectionId: hostId === LOCAL_HOST_ID ? provider.providerId : JSON.stringify([hostId, provider.providerId]),
  }));
}

export interface CreationFacts {
  readonly selectedHostId: string;
  readonly requestedHostId: string | undefined;
  readonly hosts: readonly Pick<RemoteHost, 'id' | 'online' | 'sessionQuota'>[];
  readonly hostsLoaded: boolean;
  readonly hostError: boolean;
  readonly hostSelectionRestored: boolean;
  readonly providerId: string;
  /** A creation already holds its slot of the quota. */
  readonly reserved: boolean;
}

/** A Host the link asked for that the Relay does not list for this person. */
export function requestedHostUnavailableReason(facts: CreationFacts, t: Translate = translator('en')): string | undefined {
  const { requestedHostId, hosts } = facts;
  const missing = facts.hostsLoaded && !!requestedHostId && requestedHostId !== LOCAL_HOST_ID && !facts.hostSelectionRestored && !hosts.some(candidate => candidate.id === requestedHostId);
  return missing ? t('client.creation.requestedHostMissing') : undefined;
}

export function creationUnavailableReason(facts: CreationFacts, t: Translate = translator('en')): string | undefined {
  const { selectedHostId, hosts } = facts;
  const host = hosts.find(candidate => candidate.id === selectedHostId);
  const requestedMissing = requestedHostUnavailableReason(facts, t);
  if (requestedMissing) return requestedMissing;
  const remote = selectedHostId !== LOCAL_HOST_ID;
  if (remote && !facts.hostsLoaded && !facts.hostError) return t('client.creation.loadingHosts');
  if (remote && host?.online !== true) return t('client.creation.hostOffline');
  const quota = host?.sessionQuota;
  if (quota !== undefined && quota.used >= quota.limit && !facts.reserved) return t('client.creation.quotaReached');
  if (remote && !facts.providerId) return t('client.creation.noProviders');
  return undefined;
}

/** What a provider is called on its Host: its name, and for a remote Host the Host after a dot. */
export function providerConnectionName(hostId: string, providerId: string, local: readonly AgentProviderDescriptor[], hosts: readonly RemoteHost[]): string {
  if (hostId === LOCAL_HOST_ID) return local.find(provider => provider.providerId === providerId)?.displayName ?? providerId;
  const host = hosts.find(candidate => candidate.id === hostId);
  const descriptor = host?.providers?.find(provider => provider.providerId === providerId);
  return descriptor && host ? `${descriptor.displayName} · ${host.name}` : providerId;
}

/** The provider a Host selection lands on: the preferred one when the Host advertises it, else its first. */
export function providerAfterHostChange(host: RemoteHost, local: readonly AgentProviderDescriptor[], preferred: string): string {
  const advertised = host.id === LOCAL_HOST_ID ? local : hostProviders(host);
  return chosenProviderId(advertised, preferred);
}

export interface RestoreFacts {
  /** The Host and provider a link asked for. */
  readonly requested: { readonly hostId: string | undefined; readonly providerId: string | undefined };
  readonly hosts: readonly RemoteHost[];
  /** The remembered session's Host and provider, when one is remembered and not local. */
  readonly remembered: { readonly hostId: string; readonly providerId: string } | undefined;
}

export type HostRestoration =
  | { readonly type: 'wait' }
  | { readonly type: 'none' }
  | { readonly type: 'select'; readonly host: RemoteHost; readonly providerId: string; readonly providerName: string };

/** Which Host the form selects once the Host list is known; `wait` until the wanted Host is listed. */
export function restoreHostSelection(facts: RestoreFacts): HostRestoration {
  if (facts.hosts.length === 0) return { type: 'wait' };
  if (facts.requested.hostId) {
    const host = facts.hosts.find(item => item.id === facts.requested.hostId);
    if (!host) return { type: 'wait' };
    const descriptor = host.providers?.find(provider => provider.providerId === facts.requested.providerId) ?? host.providers?.[0];
    const providerId = facts.requested.providerId ?? descriptor?.providerId ?? host.providerId ?? 'dsh';
    return { type: 'select', host, providerId, providerName: descriptor ? `${descriptor.displayName} · ${host.name}` : providerId };
  }
  if (!facts.remembered) return { type: 'none' };
  const host = facts.hosts.find(item => item.id === facts.remembered!.hostId);
  if (!host) return { type: 'wait' };
  const descriptor = host.providers?.find(provider => provider.providerId === facts.remembered!.providerId);
  return { type: 'select', host, providerId: facts.remembered.providerId, providerName: descriptor ? `${descriptor.displayName} · ${host.name}` : facts.remembered.providerId };
}
