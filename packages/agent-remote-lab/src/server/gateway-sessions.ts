import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { authenticateGatewayRequest, gatewayCookieName, readGatewayCookie, type GatewayAuthOptions, type GatewayGrant } from './gateway-auth.js';
import { queryGatewayAuthority } from './gateway-authority.js';

export interface SavedGatewaySession { hash: string; grant: GatewayGrant; sessionExpiresAt: number }
export function createGatewaySessions(auth: GatewayAuthOptions, initial: SavedGatewaySession[], changed: () => void, durable: boolean) {
  const sessions = new Map(initial.filter(value => value.sessionExpiresAt > Date.now()).map(value => [value.hash, { ...value, grant: { ...value.grant, expiresAt: 0 } }]));
  const pending = new Map<string, Promise<'active' | 'denied' | 'unavailable'>>();
  let closed = false;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  function remove(record: SavedGatewaySession) { sessions.delete(record.hash); record.grant.expiresAt = 0; changed(); }
  async function renew(record: SavedGatewaySession): Promise<'active' | 'denied' | 'unavailable'> {
    if (closed || sessions.get(record.hash) !== record) return 'denied';
    const existing = pending.get(record.hash); if (existing) return existing;
    const operation = (async () => {
      if (record.sessionExpiresAt <= Date.now() || !record.grant.continuation) { remove(record); return 'denied' as const; }
      const result = await queryGatewayAuthority(auth, 'renew', { continuation: record.grant.continuation });
      if (closed || sessions.get(record.hash) !== record) return 'denied' as const;
      if (result.status === 'denied' || (result.status === 'active' && result.subject !== record.grant.subject)) { remove(record); return 'denied' as const; }
      if (result.status !== 'active') return result.status;
      record.sessionExpiresAt = Math.min(record.sessionExpiresAt, result.expiresAt!);
      record.grant.expiresAt = Math.min(record.sessionExpiresAt, result.validUntil);
      changed(); return 'active' as const;
    })();
    pending.set(record.hash, operation);
    try { return await operation; } finally { pending.delete(record.hash); }
  }
  function recordFor(request: IncomingMessage) {
    if (request.headers.authorization) return undefined;
    const token = readGatewayCookie(request, gatewayCookieName(auth.origin, 'session'));
    return token ? sessions.get(hash(token)) : undefined;
  }
  return {
    snapshot: () => [...sessions.values()].map(value => ({ ...value, grant: { ...value.grant } })),
    async exchange(grant: GatewayGrant): Promise<{ status: 'active'; token: string; grant: GatewayGrant; expiresAt: number } | { status: 'denied' | 'unavailable' | 'capacity' }> {
      if (!grant.continuation || !grant.sessionExpiresAt) return { status: 'active', token: grant.ticket, grant, expiresAt: grant.expiresAt };
      for (const value of sessions.values()) if (value.sessionExpiresAt <= Date.now()) remove(value);
      if (sessions.size >= 1024) return { status: 'capacity' };
      const token = randomBytes(32).toString('base64url');
      const record = { hash: hash(token), grant: { ...grant, expiresAt: 0 }, sessionExpiresAt: grant.sessionExpiresAt };
      sessions.set(record.hash, record);
      const status = await renew(record);
      if (status !== 'active') { remove(record); return { status }; }
      return { status, token, grant: record.grant, expiresAt: record.sessionExpiresAt };
    },
    async authenticate(request: IncomingMessage, refresh = false): Promise<{ grant?: GatewayGrant; unavailable?: boolean }> {
      const record = recordFor(request);
      if (record) {
        if (refresh || record.grant.expiresAt <= Date.now()) {
          const status = await renew(record);
          if (status !== 'active') return { unavailable: status === 'unavailable' };
        }
        return record.grant.expiresAt > Date.now() ? { grant: record.grant } : {};
      }
      const legacy = !durable ? authenticateGatewayRequest(request, auth) : undefined;
      return legacy && !legacy.continuation ? { grant: legacy } : {};
    },
    logout(request: IncomingMessage) { const record = recordFor(request); if (record) remove(record); },
    async refreshAll() { await Promise.allSettled([...sessions.values()].map(value => renew(value))); },
    close() { closed = true; },
  };
}
