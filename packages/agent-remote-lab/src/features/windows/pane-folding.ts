/**
 * Pane folding: how a pane of the shown Window folds, sleeps, closes and restores.
 *
 * Contract
 * - Pure functions over the Window, its group's bot details and the layout. The shell applies the returned operations.
 * - A bot of a group in Bot appearance folds where it stands when its pane closes; removing it from the group is a
 *   separate, confirmed step. Any other view closes.
 * - On desktop a folded or sleeping bot is a slim card; compact layouts show one view at a time and do not fold, so a
 *   sleeping bot there keeps its pane and shows an Asleep bar.
 * - A bot whose session is missing never folds.
 * - Restoring a folded bot selects its pane (a collapsed pane expands in the same edit); a sleeping bot also wakes for
 *   every device, keeping its other details.
 */
import { hasBotAppearance, isBotView, type WindowGroup, type WindowOperation, type WindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { foldOperation } from './window-fold.js';
import { viewSelection } from './window-view-selection.js';

export type GroupFacts = WindowGroup;

/** Whether this bot of the group is asleep. */
export function isAsleep(group: GroupFacts | undefined, viewId: string): boolean {
  return !!group?.bots?.members[viewId]?.asleep;
}

/** Whether closing this view's pane folds it instead of closing it. */
export function foldsOnClose(view: WindowView | undefined, group: GroupFacts | undefined, sessionMissing: boolean): boolean {
  return !!view && !!group && hasBotAppearance(group) && isBotView(view) && !sessionMissing;
}

export type PaneFolding = { readonly kind: 'plain' } | { readonly kind: 'folded' } | { readonly kind: 'asleep' };

/** How a dock or float of the shown Window presents: a slim card, an Asleep bar over its conversation, or as is. */
export function paneFolding(view: WindowView | undefined, group: GroupFacts | undefined, layout: { readonly compact: boolean; readonly sessionMissing: boolean }): PaneFolding {
  if (!view || !isBotView(view) || layout.sessionMissing) return { kind: 'plain' };
  const asleep = isAsleep(group, view.id);
  if (!layout.compact && (view.collapsed || asleep)) return { kind: 'folded' };
  // Desktop already returned a card for a sleeping bot; only a compact layout reaches here asleep.
  return asleep ? { kind: 'asleep' } : { kind: 'plain' };
}

/** The × of a pane: a bot folds where it stands, any other view closes. */
export function closeOperation(window: WorkspaceWindow, viewId: string, folds: boolean): WindowOperation {
  return folds ? foldOperation(window, viewId) : { type: 'view.close', viewId };
}

export interface RestorePlan { readonly wake: boolean; readonly select: WindowOperation | undefined }

/** What restoring a folded or sleeping bot's pane does. */
export function restorePlan(window: WorkspaceWindow, view: WindowView, asleep: boolean): RestorePlan {
  return { wake: asleep, select: view.collapsed || window.selectedViewId !== view.id ? viewSelection(view) : undefined };
}

/** A bot's stored details without its sleep mark. */
export function awakeDetails<T extends { readonly asleep?: boolean }>(member: T | undefined): Omit<T, 'asleep'> {
  const { asleep: _asleep, ...details } = member ?? ({} as T);
  return details;
}
