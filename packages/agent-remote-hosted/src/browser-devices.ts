import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { gatewayCookieName, readGatewayCookie, type GatewayAuthOptions } from './auth.js';
import type { SavedGatewaySession } from './state.js';

export const browserActivityWindow = 7 * 86_400_000;
export const validBrowserId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// This signed identifier groups logins; it never grants access to an account.
export function browserIdentity(auth: GatewayAuthOptions) {
  const signature = (id: string) => createHmac('sha256', auth.secret).update(`browser:${auth.origin}:${id}`).digest('base64url');
  return {
    read(request?: Request) {
      const cookie = request && readGatewayCookie(request, gatewayCookieName(auth.origin, 'browser'));
      if (!cookie || cookie.length > 100) return undefined;
      const [id, proof, extra] = cookie.split('.');
      if (!validBrowserId(id) || !proof || extra !== undefined) return undefined;
      const expected = Buffer.from(signature(id)); const actual = Buffer.from(proof);
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : undefined;
    },
    create: randomUUID,
    cookie: (id: string) => `${id}.${signature(id)}`,
  };
}

// Keep the latest observation per UTC day, bounded to a rolling seven-day window.
export function browserActivity(values: number[], now = Date.now()): number[] {
  const days = new Map<number, number>();
  for (const at of values) if (at > now - browserActivityWindow && at <= now) {
    const day = Math.floor(at / 86_400_000);
    days.set(day, Math.max(days.get(day) ?? 0, at));
  }
  return [...days.values()].sort((a, b) => b - a);
}

export function browserGroups(records: SavedGatewaySession[], currentHash?: string) {
  const now = Date.now();
  const groups = new Map<string, { id: string; label: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean; identified: boolean; sessionCount: number; activity: number[] }>();
  for (const record of records) {
    const id = record.browserId ? `browser:${record.browserId}` : record.id!;
    const lastSeenAt = record.lastSeenAt ?? record.createdAt ?? 0;
    const existing = groups.get(id);
    const activity = browserActivity([...(record.activity ?? []), lastSeenAt], now);
    if (existing) {
      if (lastSeenAt > existing.lastSeenAt) existing.label = record.label ?? existing.label;
      existing.createdAt = Math.min(existing.createdAt, record.createdAt ?? 0);
      existing.lastSeenAt = Math.max(existing.lastSeenAt, lastSeenAt);
      existing.expiresAt = Math.max(existing.expiresAt, record.sessionExpiresAt);
      existing.current ||= currentHash === record.hash;
      existing.sessionCount++;
      existing.activity = browserActivity([...existing.activity, ...activity], now);
    } else groups.set(id, { id, label: record.label ?? 'Previously signed-in browser', createdAt: record.createdAt ?? 0, lastSeenAt, expiresAt: record.sessionExpiresAt, current: currentHash === record.hash, identified: !!record.browserId, sessionCount: 1, activity });
  }
  return [...groups.values()].filter(row => row.current || row.lastSeenAt > now - browserActivityWindow)
    .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);
}
