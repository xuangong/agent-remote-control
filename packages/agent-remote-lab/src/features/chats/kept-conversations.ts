/**
 * The conversations Bot mode keeps mounted after the reader leaves them: the stack of views under the one on screen.
 *
 * A kept conversation holds its rendered state (open sections, search, an expanded tool call) while it waits, parked out of sight
 * and detached from its session. The bound is three, the one on screen and the two before it, because each kept conversation holds
 * its timeline's elements and its replica in memory, which a phone has least of, and the reader's back-and-forth is between a
 * few conversations: A, B and A again, or a detour to a third and back. A conversation beyond the bound is released and opens again
 * from its stored reading position, which puts the reader on the same message at the same offset.
 */
export const KEPT_CONVERSATIONS = 3;

export interface KeptConversation<Place, Description> { readonly key: string; readonly place: Place; readonly description: Description }

/**
 * The kept list after the chosen conversation `key` was rendered with `live` (its place and description) or, when it cannot be
 * described, with none. A described conversation goes first and the others follow by recency, the oldest beyond the bound released.
 * One that cannot be described is gone (its assistant was removed or hidden, its group is not there): it is released. With no
 * conversation chosen, the list stays as it is.
 */
export function keepRecent<Place, Description>(kept: readonly KeptConversation<Place, Description>[], key: string | undefined,
  live: KeptConversation<Place, Description> | undefined, bound: number = KEPT_CONVERSATIONS): readonly KeptConversation<Place, Description>[] {
  if (!key) return kept;
  const rest = kept.filter(item => item.key !== key);
  return live ? [live, ...rest].slice(0, bound) : rest;
}
