import { browserActivity, browserGroups, browserIdentity } from './browser-devices.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authenticateGatewayRequest, gatewayCookieName, readGatewayCookie, type GatewayAuthOptions, type GatewayGrant } from './auth.js';
import { queryGatewayAuthority } from './authority.js';
import type { RelayState, SavedGatewaySession } from './state.js';
export type { SavedGatewaySession } from './state.js';

export function createGatewaySessions(auth: GatewayAuthOptions, state: RelayState, durable: boolean) {
  const pending = new Map<string, Promise<'active' | 'denied' | 'unavailable'>>();
  let closed = false;
  const identity = browserIdentity(auth);
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
        current.grant.authenticatedAt = result.authenticatedAt;
        current.grant.profile = result.profile;
        current.grant.expiresAt = Math.min(current.sessionExpiresAt, result.validUntil);
        return 'active' as const;
      });
    })();
    pending.set(record.hash, operation);
    try { return await operation; } finally { pending.delete(record.hash); }
  }
  return {
    async exchange(grant: GatewayGrant, request?: Request): Promise<{ status: 'active'; token: string; grant: GatewayGrant; expiresAt: number; browserCookie?: string } | { status: 'denied' | 'unavailable' | 'capacity' }> {
      if (!grant.continuation || !grant.sessionExpiresAt) return { status: 'active', token: grant.ticket, grant, expiresAt: grant.expiresAt };
      const result = await queryGatewayAuthority(auth, 'renew', { continuation: grant.continuation });
      if (closed) return { status: 'denied' };
      if (result.status !== 'active') return result;
      if (result.subject !== grant.subject) return { status: 'denied' };
      const prior = request ? recordFor(request) : undefined;
      const browserId = identity.read(request) ?? (prior?.grant.subject === grant.subject ? prior.browserId : undefined) ?? identity.create();
      const token = randomBytes(32).toString('base64url');
      const sessionExpiresAt = Math.min(grant.sessionExpiresAt, result.expiresAt!);
      const current = { ...grant, profile: result.profile, authenticatedAt: result.authenticatedAt, expiresAt: Math.min(sessionExpiresAt, result.validUntil) };
      return state.mutate(draft => {
        draft.sessions = draft.sessions.filter(record => record.sessionExpiresAt > Date.now());
        if (draft.sessions.length >= 1024) return { status: 'capacity' as const };
        if (prior?.grant.subject === grant.subject && !prior.browserId) {
          const previous = draft.sessions.find(record => record.hash === prior.hash);
          if (previous) previous.browserId = browserId;
        }
        const now = Date.now();
        const activity = browserActivity([...draft.sessions
          .filter(record => record.grant.subject === grant.subject && record.browserId === browserId)
          .flatMap(record => record.activity ?? [record.lastSeenAt ?? 0]), now], now);
        draft.sessions.push({ browserId, activity, hash: hash(token), grant: current, sessionExpiresAt,
          id: randomUUID(), createdAt: now, lastSeenAt: now, label: browserLabel(request?.headers.get('user-agent')) });
        return { status: 'active' as const, token, grant: current, expiresAt: sessionExpiresAt, browserCookie: identity.cookie(browserId) };
      });
    },
    async authenticate(request: Request, refresh = false): Promise<{ grant?: GatewayGrant; unavailable?: boolean }> {
      const record = recordFor(request);
      if (record) {
        if (refresh || record.grant.expiresAt <= Date.now()) {
          const status = await renew(record);
          if (status !== 'active') return { unavailable: status === 'unavailable' };
        }
        if ((record.lastSeenAt ?? 0) < Date.now() - 60_000) await state.mutate(draft => { const current = draft.sessions.find(value => value.hash === record.hash); if (current) { current.lastSeenAt = Date.now(); current.activity = browserActivity([...(current.activity ?? []), current.lastSeenAt]); } });
        const current = recordFor(request);
        return current && current.grant.expiresAt > Date.now() ? { grant: current.grant } : {};
      }
      const legacy = !durable ? authenticateGatewayRequest(request, auth) : undefined;
      return legacy && !legacy.continuation ? { grant: legacy } : {};
    },
    expiresAt(request: Request, grant: GatewayGrant) {
      return grant.continuation ? recordFor(request)?.grant.expiresAt ?? 0 : grant.expiresAt;
    },
    list(subject: string, request: Request) {
      const current = recordFor(request);
      return browserGroups(state.read().sessions.filter(record => record.grant.subject === subject && record.sessionExpiresAt > Date.now())
        .map(record => ({ ...record, id: record.id ?? managementId(record.hash) })), current?.hash);
    },
    async browserCookie(request: Request) {
      const record = recordFor(request);
      if (!record) return undefined;
      const id = record.browserId ?? await state.mutate(draft => {
        const current = draft.sessions.find(value => value.hash === record.hash);
        if (!current) return undefined;
        return current.browserId ??= identity.read(request) ?? identity.create();
      });
      return id ? identity.cookie(id) : undefined;
    },
    async revoke(subject: string, id: string, request: Request) {
      const active = recordFor(request);
      return state.mutate(draft => { const target = draft.sessions.find(record => record.grant.subject === subject && (record.browserId ? `browser:${record.browserId}` : record.id ?? managementId(record.hash)) === id);
        if (!target) return {found:false,current:false};
        const matches = (record: SavedGatewaySession) => record.grant.subject === subject && (target.browserId ? record.browserId === target.browserId : record.hash === target.hash);
        draft.sessions = draft.sessions.filter(record => !matches(record));
        return {found:true,current:!!active && matches(active)};
      });
    },
    async revokeAll(subject: string) { await state.mutate(draft => { draft.sessions = draft.sessions.filter(record => record.grant.subject !== subject); }); },
    async logout(request: Request) {
      const record = recordFor(request);
      if (record) await state.mutate(draft => { draft.sessions = draft.sessions.filter(value => value.hash !== record.hash); });
    },
    async refreshAll(beforeBatch?: () => Promise<void>) {
      const records = [...state.read().sessions];
      for (let index = 0; index < records.length && !closed; index += 4) {
        await beforeBatch?.();
        await Promise.all(records.slice(index, index + 4).map(value => renew(value)));
      }
    },
    close() { closed = true; },
  };
}

function managementId(hash: string) { return createHash('sha256').update('browser-management:' + hash).digest('hex'); }
function browserLabel(agent?: string | null): string {
  const platform = /Android/.test(agent ?? '') ? 'Android' : /iPhone|iPad/.test(agent ?? '') ? 'iOS' : /Macintosh/.test(agent ?? '') ? 'Mac' : /Windows/.test(agent ?? '') ? 'Windows' : /Linux/.test(agent ?? '') ? 'Linux' : 'Device';
  const browser = /Edg(?:e|A|iOS)?\//.test(agent ?? '') ? 'Edge' : /Chrome\/|CriOS\//.test(agent ?? '') ? 'Chrome' : /Firefox\/|FxiOS\//.test(agent ?? '') ? 'Firefox' : /Safari\//.test(agent ?? '') ? 'Safari' : 'Browser';
  return platform + ' · ' + browser;
}
