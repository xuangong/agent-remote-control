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
