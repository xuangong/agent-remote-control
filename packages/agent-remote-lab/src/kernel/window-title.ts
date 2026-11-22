/**
 * The window's title and the name the installed app's title bar carries: the assistant on screen, then the product. Bot mode names the
 * assistant whose conversation shows; Window mode keeps its own title (its first session's, or the Window's). Pure.
 */
import type { AccountNames } from './assistant-names.js';
import type { BotPlace } from './workbench-mode.js';

export const PRODUCT_NAME = 'Orchard';

/** The document's title for a name on screen: "Chief · Orchard", or the product alone. */
export function windowTitle(name: string | undefined): string {
  const shown = name?.trim();
  return shown ? `${shown} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}

/** The assistant Bot mode shows: a bot or a session's assistant by its name, never its session's title; none for the list or a group. */
export function shownAssistantName(place: BotPlace | undefined, conversationShown: boolean, names: AccountNames): string | undefined {
  if (!conversationShown || !place) return undefined;
  if (place.kind === 'bot') return names.view(place.groupId, place.viewId);
  if (place.kind === 'session') return names.session(place.session);
  return undefined;
}
