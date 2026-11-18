/**
 * Session binding: where opening a session lands when a view or a bot already holds a conversation.
 *
 * Contract
 * - Pure. The shell reads the Window and the group, passes plain facts in and applies the plan that comes back.
 * - `focusesVisibleSession`: an ordinary open (no target view, no primary slot, not a history or subagent view, no
 *   choice about keeping the original, no restore, no take over) of a session that is already on screen focuses that
 *   view instead of opening it again. A pane, a placement of `primary`, a history intent or any of the others opens it.
 * - `returnsToParent`: an open that goes back to a native parent (not a history view, no primary slot, no restore of a
 *   tracked layout) stays inside the tracked family; any other primary navigation leaves the Track.
 * - `bindPlan`: a bot keeps its conversation (rule 6). When a group shown with bot details holds a bot in the target
 *   view, a session that would take its place, or any other session than the bot's own that is not a history view
 *   of it, opens beside it: an existing bot view of that session is selected, otherwise a new view opens where the
 *   target stands (in the dock or floating when that is where it is, else as a primary group). Anywhere else the
 *   session binds in place.
 */
export function focusesVisibleSession(open: {
  readonly targetPrimaryViewId?: string; readonly placement?: string; readonly primarySlot?: string; readonly sessionIntent?: string;
  readonly keepOriginal?: boolean; readonly restoreView: boolean; readonly takeOver?: string; readonly onRestoring: boolean;
}): boolean {
  return !open.targetPrimaryViewId && open.placement !== 'primary' && !open.primarySlot && open.sessionIntent !== 'history'
    && open.keepOriginal === undefined && !open.restoreView && !open.takeOver && !open.onRestoring;
}

export function returnsToParent(open: { readonly sessionIntent?: string; readonly primarySlot?: string; readonly restoreView: boolean; readonly isAncestor: boolean }): boolean {
  return open.sessionIntent !== 'history' && !open.primarySlot && !open.restoreView && open.isAncestor;
}

export type BindPlan =
  | { readonly kind: 'in-place' }
  | { readonly kind: 'select-existing'; readonly viewId: string; readonly primary: boolean }
  | { readonly kind: 'open-beside'; readonly placement: 'primary' | 'dock' | 'float'; readonly afterId?: string };

export function bindPlan(facts: {
  readonly hasGroup: boolean;
  readonly targetIsBot: boolean;
  readonly targetId: string;
  readonly targetPlacement: string;
  readonly rebindsBot: boolean;
  readonly botAppearance: boolean;
  readonly sessionIntent?: string;
  readonly sameSession: boolean;
  readonly existingBot: { readonly id: string; readonly placement: string } | undefined;
}): BindPlan {
  const keepsConversation = facts.hasGroup && facts.targetIsBot
    && (facts.rebindsBot || facts.botAppearance && facts.sessionIntent !== 'history' && !facts.sameSession);
  if (!keepsConversation) return { kind: 'in-place' };
  if (facts.existingBot) return { kind: 'select-existing', viewId: facts.existingBot.id, primary: facts.existingBot.placement === 'primary' };
  const placement = facts.targetPlacement === 'dock' || facts.targetPlacement === 'float' ? facts.targetPlacement : 'primary';
  return placement === 'dock' ? { kind: 'open-beside', placement, afterId: facts.targetId } : { kind: 'open-beside', placement };
}
