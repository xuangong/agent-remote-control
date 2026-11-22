/**
 * Draft ownership: which stored draft a Window pane's composer reads and writes.
 *
 * Contract
 * - Pure. A pane's draft belongs to its composition slot's owners, so the same conversation keeps one draft across modes.
 * - A pane managed by a feature (a Team or Ask conversation) keeps the draft of its origin session under the device's
 *   own scope, with the `session:` prefix, whatever session its slot currently shows.
 * - A pane without a slot has no draft binding.
 * - The text store of an owner is found by its scope; the shell creates a store for a scope it has not seen.
 */
import { sessionKey } from '../kernel/session-tree.js';
import type { CompositionSlot } from '../kernel/session-composition-model.js';

export interface DraftOwner { readonly scope: string; readonly key: string }
export interface PaneDraftOwners { readonly text: DraftOwner; readonly image: DraftOwner }

export function paneDraftOwners(slot: CompositionSlot | undefined, managed: boolean, baseUrl: string): PaneDraftOwners | undefined {
  if (!slot) return undefined;
  if (!managed) return { text: slot.owners.text, image: slot.owners.image };
  const origin = slot.origin.target;
  const key = sessionKey({ hostId: origin.hostId, ...origin.native });
  return { text: { scope: baseUrl, key: `session:${key}` }, image: { scope: baseUrl, key: JSON.stringify([baseUrl, key]) } };
}

/** Finds the store of an owner's scope, creating it the first time the scope is seen. */
export function storeFor<Store>(stores: Map<string, Store>, scope: string, create: (scope: string) => Store): Store {
  let store = stores.get(scope);
  if (!store) { store = create(scope); stores.set(scope, store); }
  return store;
}
