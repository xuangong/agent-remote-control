import { createHash, randomBytes } from 'node:crypto';
import { authenticateGatewayRequest, gatewayCookieName, readGatewayCookie, type GatewayAuthOptions, type GatewayGrant } from './auth.js';
import { queryGatewayAuthority } from './authority.js';
import type { RelayState, SavedGatewaySession } from './state.js';
export type { SavedGatewaySession } from './state.js';

export function createGatewaySessions(auth: GatewayAuthOptions, state: RelayState, durable: boolean) {
  const pending = new Map<string, Promise<'active' | 'denied' | 'unavailable'>>();
  let closed = false;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  function recordFor(request: Request) {
    if (request.headers.has('authorization')) return undefined;
    const token = readGatewayCookie(request, gatewayCookieName(auth.origin, 'session'));
    return token ? state.read().sessions.find(record => record.hash === hash(token)) : undefined;
  }
  async function renew(record: SavedGatewaySession): Promise<'active' | 'denied' | 'unavailable'> {
    if (closed) return 'denied';
    const existing = pending.get(record.hash); if (existing) return existing;
    const operation = (async () => {
      const result = record.sessionExpiresAt <= Date.now() || !record.grant.continuation
        ? { status: 'denied' as const } : await queryGatewayAuthority(auth, 'renew', { continuation: record.grant.continuation });
      if (closed) return 'denied' as const;
      if (result.status === 'unavailable') return result.status;
      return state.mutate(draft => {
        const current = draft.sessions.find(value => value.hash === record.hash);
        if (!current) return 'denied' as const;
        if (result.status !== 'active' || result.subject !== current.grant.subject || current.sessionExpiresAt <= Date.now()) {
          draft.sessions = draft.sessions.filter(value => value.hash !== record.hash); return 'denied' as const;
        }
        current.sessionExpiresAt = Math.min(current.sessionExpiresAt, result.expiresAt!);
        current.grant.expiresAt = Math.min(current.sessionExpiresAt, result.validUntil);
        return 'active' as const;
      });
    })();
    pending.set(record.hash, operation);
    try { return await operation; } finally { pending.delete(record.hash); }
  }
  return {
    async exchange(grant: GatewayGrant): Promise<{ status: 'active'; token: string; grant: GatewayGrant; expiresAt: number } | { status: 'denied' | 'unavailable' | 'capacity' }> {
      if (!grant.continuation || !grant.sessionExpiresAt) return { status: 'active', token: grant.ticket, grant, expiresAt: grant.expiresAt };
      const result = await queryGatewayAuthority(auth, 'renew', { continuation: grant.continuation });
      if (closed) return { status: 'denied' };
      if (result.status !== 'active') return result;
      if (result.subject !== grant.subject) return { status: 'denied' };
      const token = randomBytes(32).toString('base64url');
      const sessionExpiresAt = Math.min(grant.sessionExpiresAt, result.expiresAt!);
      const current = { ...grant, expiresAt: Math.min(sessionExpiresAt, result.validUntil) };
      return state.mutate(draft => {
        draft.sessions = draft.sessions.filter(record => record.sessionExpiresAt > Date.now());
        if (draft.sessions.length >= 1024) return { status: 'capacity' as const };
        draft.sessions.push({ hash: hash(token), grant: current, sessionExpiresAt });
        return { status: 'active' as const, token, grant: current, expiresAt: sessionExpiresAt };
      });
    },
    async authenticate(request: Request, refresh = false): Promise<{ grant?: GatewayGrant; unavailable?: boolean }> {
      const record = recordFor(request);
      if (record) {
        if (refresh || record.grant.expiresAt <= Date.now()) {
          const status = await renew(record);
          if (status !== 'active') return { unavailable: status === 'unavailable' };
        }
        const current = recordFor(request);
        return current && current.grant.expiresAt > Date.now() ? { grant: current.grant } : {};
      }
      const legacy = !durable ? authenticateGatewayRequest(request, auth) : undefined;
      return legacy && !legacy.continuation ? { grant: legacy } : {};
    },
    expiresAt(request: Request, grant: GatewayGrant) {
      return grant.continuation ? recordFor(request)?.grant.expiresAt ?? 0 : grant.expiresAt;
    },
    async logout(request: Request) {
      const record = recordFor(request);
      if (record) await state.mutate(draft => { draft.sessions = draft.sessions.filter(value => value.hash !== record.hash); });
    },
    async refreshAll() { await Promise.all([...state.read().sessions].map(value => renew(value))); },
    close() { closed = true; },
  };
}
