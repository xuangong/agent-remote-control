import { applyWindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { botDisplayName } from './components/BotRoster.js';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
/** What closes with a bot's view: its Asks, and the views attached to it or closing with it, such as a Team leader's members. */
export function closingWith(window: WorkspaceWindow | undefined, viewId: string): { asks: number; bots: string[] } {
  // The bot may already be gone (removed here or on another device) while its confirmation is still closing.
  if (!window?.views.some(view => view.id === viewId)) return { asks: 0, bots: [] };
  const staying = new Set(applyWindowOperation(window, { type: 'view.close', viewId }).views.map(view => view.id));
  const leaving = window.views.filter(view => !staying.has(view.id) && view.id !== viewId);
  return { asks: leaving.filter(view => view.feature?.kind === 'ask').length,
    bots: leaving.filter(view => view.feature?.kind !== 'ask' && view.binding).map(view => botDisplayName(view.binding!)) };
}
/** “Its session keeps running.”, then what closes with the bot: “Edge cases” and 1 Ask close with it. */
export function removalMessage(closing: { asks: number; bots: string[] } | undefined): string {
  const items = [...closing?.bots.map(name => `“${name}”`) ?? [], ...closing?.asks ? [plural(closing.asks, 'Ask', 'Asks')] : []];
  if (!items.length) return 'Its session keeps running.';
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
  const single = items.length === 1 && !(closing!.asks > 1 && !closing!.bots.length);
  return `Its session keeps running. ${list} ${single ? 'closes' : 'close'} with it.`;
}
