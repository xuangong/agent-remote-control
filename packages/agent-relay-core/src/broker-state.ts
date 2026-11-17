import type { RemoteHostBrokerState } from './broker.js';

/**
 * The broker state a commit hands to the Relay. Equal entries are the previously committed objects, so they keep their
 * identity and the Relay neither encodes nor validates them again. Other entries are copies: the broker's runtime keeps
 * changing its own objects, while committed state is frozen and never changes in place.
 * Teams, Call For Support and associations are committed as they are: the broker replaces them and never changes them in place.
 */
export function committedBrokerState(next: RemoteHostBrokerState, previous: RemoteHostBrokerState | undefined): RemoteHostBrokerState {
  const result: RemoteHostBrokerState = { ...next,
    keys: retain(next.keys, previous?.keys, ([hash]) => hash)!,
    hosts: retain(next.hosts, previous?.hosts, host => host.id)!,
    bindings: retain(next.bindings, previous?.bindings, binding => binding.agentId)!,
    creations: retain(next.creations, previous?.creations, ([key]) => key)!,
  };
  if (next.pairings !== undefined) result.pairings = retain(next.pairings, previous?.pairings, pairing => pairing.id);
  if (next.revokedHosts !== undefined) result.revokedHosts = retain(next.revokedHosts, previous?.revokedHosts, host => JSON.stringify([host.hostId, host.installationId]));
  if (next.previews !== undefined) result.previews = retain(next.previews, previous?.previews, preview => preview.hostId);
  if (next.sharing !== undefined) result.sharing = { ...next.sharing,
    grants: retain(next.sharing.grants, previous?.sharing?.grants, grant => JSON.stringify([grant.hostId, grant.subject]))!,
    reservations: retain(next.sharing.reservations, previous?.sharing?.reservations, reservation => reservation.key)! };
  return result;
}

function retain<T>(values: T[] | undefined, previous: T[] | undefined, key: (value: T) => string): T[] | undefined {
  if (values === undefined) return values;
  const saved = new Map<string, T>();
  for (const value of previous ?? []) saved.set(key(value), value);
  let same = previous !== undefined && previous.length === values.length;
  const result = values.map((value, index) => {
    const prior = saved.get(key(value));
    // The same JSON is the same committed record, whatever runtime fields are left undefined.
    const kept = prior !== undefined && (prior === value || JSON.stringify(prior) === JSON.stringify(value)) ? prior : structuredClone(value);
    if (kept !== previous?.[index]) same = false;
    return kept;
  });
  return same ? previous : result;
}
