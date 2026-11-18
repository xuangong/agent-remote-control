/**
 * Letter navigation: where following a letter between two sessions leads.
 *
 * Contract
 * - Pure over session keys and layout facts. The shell attaches sessions, observes them and applies the plan.
 * - `otherEndpoint`: a letter is followed from one of its two endpoints, to the other. A conversation that is neither
 *   the sender nor the recipient is not an endpoint, and following it fails. Sender and recipient being the same
 *   session is ambiguous and also not followable.
 * - `participantTitle`: a saved conversation keeps its favorite title, then the title the page already knows, and
 *   only then the title the letter's address carries; native agent addresses never rename a saved conversation.
 * - `windowLetterPlan` (a shared Window): reuse the view of the destination already in the source's family, or create
 *   an attached one; then select the destination on compact layouts or when the destination is the recipient, else
 *   keep the source selected.
 * - `stackPlan` (the plain layout, desktop): nothing to do while both endpoints are inside the expanded stack. Else if
 *   the stack's root is one of them, select the other as the root's Side. Else if both are on the stack path, move the
 *   anchor to the deeper one. Otherwise open the sending side first (the source when it is an endpoint) and select
 *   the other from it.
 */
export function otherEndpoint(sourceKey: string, senderKey: string | undefined, recipientKey: string | undefined): 'sender' | 'recipient' | undefined {
  if (!senderKey || !recipientKey || senderKey === recipientKey) return undefined;
  return sourceKey === senderKey ? 'recipient' : sourceKey === recipientKey ? 'sender' : undefined;
}

export function participantTitle(titles: { readonly favorite?: string; readonly known?: string; readonly identity: string }): string {
  return titles.favorite ?? titles.known ?? titles.identity;
}

export function windowLetterPlan(facts: { readonly existingDestinationId: string | undefined; readonly endpoint: 'sender' | 'recipient'; readonly compact: boolean }): { readonly create: boolean; readonly select: 'destination' | 'origin' } {
  return { create: facts.existingDestinationId === undefined, select: facts.compact || facts.endpoint === 'recipient' ? 'destination' : 'origin' };
}

export type StackPlan =
  | { readonly kind: 'present' }
  | { readonly kind: 'select-side'; readonly from: string; readonly to: string }
  | { readonly kind: 'anchor'; readonly index: number }
  | { readonly kind: 'open-origin'; readonly from: string; readonly to: string };

export function stackPlan(facts: {
  readonly senderKey: string; readonly recipientKey: string; readonly sourceKey: string; readonly rootKey: string | undefined;
  /** Keys of the whole stack path, in order. */ readonly path: readonly string[];
  /** Index range of the expanded part of the path, inclusive. */ readonly expanded: { readonly start: number; readonly end: number };
}): StackPlan {
  const ends = [facts.senderKey, facts.recipientKey];
  const expanded = facts.path.slice(facts.expanded.start, facts.expanded.end + 1);
  if (ends.every(key => expanded.includes(key))) return { kind: 'present' };
  const other = (key: string) => key === facts.senderKey ? facts.recipientKey : facts.senderKey;
  const root = facts.rootKey !== undefined ? ends.find(key => key === facts.rootKey) : undefined;
  if (root !== undefined) return { kind: 'select-side', from: root, to: other(root) };
  if (ends.every(key => facts.path.includes(key))) return { kind: 'anchor', index: Math.max(...ends.map(key => facts.path.indexOf(key))) };
  const origin = facts.sourceKey === facts.recipientKey ? facts.recipientKey : facts.senderKey;
  return { kind: 'open-origin', from: origin, to: other(origin) };
}
