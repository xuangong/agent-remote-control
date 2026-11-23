/**
 * Session titles: how a confirmed title reaches the lists, the Window and the bot group that show a session.
 *
 * Contract
 * - Pure. The shell holds the state, runs the Relay lookups and applies the edits; these functions decide what changes.
 * - `confirmTitle` records a title for a session under the page's scope. A title for another scope starts a new map. It
 *   returns the same state object when the map already holds that title, so nothing renders for it.
 * - `retitleSessions` gives the listed session its new title and returns the same array when no listed session names
 *   it with another title.
 * - `titledSessions` are the sessions whose native title is asked for: every open entry, then the sessions of the
 *   shown Window and the shown bot group. A view that names its own sessions (a managed view: Ask, Team) is skipped.
 * - `windowProjectionTitles` returns the confirmed titles to project onto the shown Window now, or nothing: only for a
 *   confirmed Window (a cached one is read-only), when there are confirmed titles, and not twice for the same map.
 * - `groupProjectionTitles` returns them for the shown bot group when there is a group and either the map or the
 *   group's revision is not the one projected last.
 */
export interface TitleState { readonly scope: string; readonly titles: ReadonlyMap<string, string> }

export function confirmTitle(current: TitleState | undefined, scope: string, key: string, title: string): TitleState | undefined {
  const titles = current?.scope === scope ? current.titles : undefined;
  if (titles?.get(key) === title) return current;
  return { scope, titles: new Map(titles).set(key, title) };
}

export function retitleSessions<Item extends { readonly title: string }>(items: readonly Item[], keyOf: (item: Item) => string, key: string, title: string): readonly Item[] {
  if (!items.some(item => keyOf(item) === key && item.title !== title)) return items;
  return items.map(item => keyOf(item) === key ? { ...item, title } : item);
}

export interface TitledSession { readonly hostId: string; readonly providerId: string; readonly nativeSessionId: string; readonly title: string }

export function titledSessions<Entry>(entries: readonly Entry[], views: readonly { readonly binding?: TitledSession; readonly bindingPolicy?: string }[]): Array<Entry | TitledSession> {
  return [...entries, ...views.flatMap(({ binding, bindingPolicy }) => binding && bindingPolicy !== 'managed'
    ? [{ hostId: binding.hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId, title: binding.title }] : [])];
}

export function windowProjectionTitles(facts: { readonly hasWindow: boolean; readonly provisional: boolean; readonly confirmed: ReadonlyMap<string, string> | undefined; readonly applied: ReadonlyMap<string, string> | undefined }): ReadonlyMap<string, string> | undefined {
  return facts.hasWindow && !facts.provisional && facts.confirmed?.size && facts.applied !== facts.confirmed ? facts.confirmed : undefined;
}

export function groupProjectionTitles(facts: { readonly hasGroup: boolean; readonly confirmed: ReadonlyMap<string, string> | undefined; readonly revision: string; readonly last: { readonly titles?: ReadonlyMap<string, string>; readonly revision?: string } }): ReadonlyMap<string, string> | undefined {
  return facts.hasGroup && facts.confirmed?.size && !(facts.last.titles === facts.confirmed && facts.last.revision === facts.revision) ? facts.confirmed : undefined;
}
