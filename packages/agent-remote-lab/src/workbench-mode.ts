import { hasBotAppearance, hasWindowAppearance, isBotView, type WindowGroup, type WindowGroupEdit, type WindowGroupOperation } from '@orchardworks/agent-remote-protocol';
import type { SessionEntry } from './session-tree.js';

export type WorkbenchMode = 'window' | 'bot';
export type BotPlace = { kind: 'section'; groupId: string } | { kind: 'bot'; groupId: string; viewId: string } | { kind: 'session'; session: SessionEntry };
const navigationKeys = ['mode', 'window', 'section', 'bot', 'host', 'provider', 'session', 'parent', 'intent', 'agent', 'keepOriginal'] as const;
export type WindowRouteFields = Partial<Record<Exclude<typeof navigationKeys[number], 'mode' | 'section' | 'bot'>, string>>;
export function windowRouteFields(url: URL): WindowRouteFields {
  const fields: WindowRouteFields = {};
  for (const key of navigationKeys) if (key !== 'mode' && key !== 'section' && key !== 'bot') { const value = url.searchParams.get(key); if (value) fields[key] = value; }
  return fields;
}
export function parseWorkbenchRoute(url: URL): { mode: WorkbenchMode; place?: BotPlace } | undefined {
  const query = url.searchParams;
  if (query.get('mode') === 'bot') {
    const groupId = query.get('section'), viewId = query.get('bot');
    if (groupId) return { mode: 'bot', place: viewId ? { kind: 'bot', groupId, viewId } : { kind: 'section', groupId } };
    const hostId = query.get('host'), providerId = query.get('provider'), nativeSessionId = query.get('session');
    if (hostId && providerId && nativeSessionId) return { mode: 'bot', place: { kind: 'session', session: { hostId, providerId, nativeSessionId, title: nativeSessionId } } };
    return { mode: 'bot' };
  }
  if (query.get('mode') === 'window' || query.has('window') || query.has('session') || query.has('agent')) return { mode: 'window' };
}
export function writeWorkbenchRoute(source: URL, mode: WorkbenchMode, place?: BotPlace, windowRoute: WindowRouteFields = {}): URL {
  const url = new URL(source);
  for (const key of navigationKeys) url.searchParams.delete(key);
  if (mode === 'window') { for (const key of navigationKeys) if (key in windowRoute) url.searchParams.set(key, windowRoute[key as keyof WindowRouteFields]!); }
  else {
    url.searchParams.set('mode', 'bot');
    if (place?.kind === 'section' || place?.kind === 'bot') {
      url.searchParams.set('section', place.groupId); if (place.kind === 'bot') url.searchParams.set('bot', place.viewId);
    } else if (place?.kind === 'session') {
      url.searchParams.set('host', place.session.hostId ?? 'local'); url.searchParams.set('provider', place.session.providerId); url.searchParams.set('session', place.session.nativeSessionId);
    }
  }
  return url;
}
/** Persistence keeps a locator and a readable title, never connection admission. */
export function persistedBotPlace(place: BotPlace | undefined): BotPlace | undefined {
  if (place?.kind !== 'session') return place;
  const { hostId, providerId, nativeSessionId, title } = place.session;
  return { kind: 'session', session: { ...(hostId ? { hostId } : {}), providerId, nativeSessionId, title } };
}
export function decodeBotPlace(value: unknown): BotPlace | undefined {
  if (!value || typeof value !== 'object') return;
  const item = value as Record<string, unknown>;
  if ((item.kind === 'section' || item.kind === 'bot') && typeof item.groupId === 'string' && item.groupId) {
    if (item.kind === 'section') return { kind: 'section', groupId: item.groupId };
    if (typeof item.viewId === 'string' && item.viewId) return { kind: 'bot', groupId: item.groupId, viewId: item.viewId };
  }
  if (item.kind === 'session' && item.session && typeof item.session === 'object') {
    const s = item.session as Record<string, unknown>;
    if (typeof s.providerId === 'string' && s.providerId && typeof s.nativeSessionId === 'string' && s.nativeSessionId && typeof s.title === 'string' && (s.hostId === undefined || typeof s.hostId === 'string')) return persistedBotPlace({ kind: 'session', session: s as unknown as SessionEntry });
  }
}

/** What opening a tile's assistant in Bot mode shows, and the edit its group needs first to show it there. */
export interface BotPlaceForTile { readonly place: Extract<BotPlace, { kind: 'bot' }>; readonly edit?: WindowGroupOperation }
/**
 * Opening a Window tile in Bot mode (I3 plan, section 4.4): the tile's assistant, in its own group. A group without a Bot
 * section gains one (`bots.add` at `rank`), a group hidden in Bot mode shows there again, a bot hidden in Bot mode shows
 * again; all in one change. A view that is no bot (an Ask, a history or subagent view, an empty view) has no Bot place.
 */
export function botPlaceForTile(group: WindowGroup, viewId: string, rank: string): BotPlaceForTile | undefined {
  const view = group.window.views.find(item => item.id === viewId);
  if (!view || !isBotView(view)) return undefined;
  const edits: WindowGroupEdit[] = [];
  if (!group.bots) edits.push({ type: 'bots.add', rank });
  if (!hasBotAppearance(group)) edits.push({ type: 'bots.show' });
  const details = group.bots?.members[viewId];
  if (details?.hidden) { const { hidden: _hidden, ...shown } = details; edits.push({ type: 'bot.update', viewId, details: shown }); }
  const place = { kind: 'bot' as const, groupId: group.window.id, viewId };
  return edits.length ? { place, edit: edits.length === 1 ? edits[0]! : { type: 'batch', operations: edits } } : { place };
}

/** Where pinning an assistant to a window goes, and what the page asks of the Relay first. */
export interface WindowRouteForPin {
  readonly route: { readonly window: string };
  /** The view to present in that Window. */
  readonly viewId: string;
  readonly request: { readonly kind: 'show'; readonly edit: WindowGroupEdit } | { readonly kind: 'transfer'; readonly target: string } | { readonly kind: 'none' };
}
/**
 * Pinning a Bot-mode assistant to a window (I3 plan, section 4.4): its own group as a Window, shown in Window mode first
 * when the group is hidden there (`window.add`); or, given another Window as `target`, that Window after the assistant
 * moves into it (the transfer request).
 */
export function windowRouteForPin(group: WindowGroup, viewId: string, target?: string): WindowRouteForPin {
  if (target && target !== group.window.id) return { route: { window: target }, viewId, request: { kind: 'transfer', target } };
  return { route: { window: group.window.id }, viewId,
    request: hasWindowAppearance(group) ? { kind: 'none' } : { kind: 'show', edit: { type: 'window.add' } } };
}
