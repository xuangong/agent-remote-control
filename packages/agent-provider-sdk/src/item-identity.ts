import type { ProviderObservation } from './observation.js';

/**
 * Declared by an adapter whose timeline observations all carry `itemIdentity`, and whose live and reread observations of
 * one native item agree on it. The adapter proves that with continuity fixtures. Only such adapters have their sessions
 * published to Relay journals; the others keep today's forwarding.
 */
export interface AgentJournalCapability {
  readonly itemIdentity: 1;
}

export function supportsJournal(adapter: { readonly journal?: AgentJournalCapability }): boolean {
  return adapter.journal?.itemIdentity === 1;
}

/**
 * The item types of a session that were given more than one live-only key. A conformance test of an adapter fails when this is not
 * empty: an occurrence key such as `todo:<uuid>` would add one item at every Controller start.
 */
export function liveOnlyKeyViolations(observations: readonly ProviderObservation[]): string[] {
  const keys = new Map<string, Set<string>>();
  for (const observation of observations) {
    if (observation.itemIdentity?.liveOnly !== true || observation.event.type !== 'timeline') continue;
    const type = observation.event.item.type;
    keys.set(type, (keys.get(type) ?? new Set<string>()).add(observation.itemIdentity.key));
  }
  return [...keys].filter(([, names]) => names.size > 1).map(([type, names]) => `${type}: ${[...names].join(', ')}`);
}
