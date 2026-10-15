import { isDeepStrictEqual } from 'node:util';
import { isSessionSuccessionCurrent, isSessionSuccessionReplay, isSessionSuccessionReplayPage, nativeSessionRefKey, type NativeSessionRef, type SessionSuccessionReplay, type SessionSuccessionReplayPage } from '@orchardworks/agent-remote-protocol';
import type { SessionSuccessionStore } from './session-succession-store.js';
const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const validId = (id: string | undefined): boolean => id !== undefined && id.length > 0 && id.length <= 512 && !/[\u0000-\u001f]/.test(id);
export const localSuccessionLocator = (ref: NativeSessionRef) => ({ hostId: 'local', providerId: ref.providerId, nativeSessionId: ref.nativeSessionId });

/** Stateless projections over the validated local store; transport locators do not replace native identity. */
export class LocalSuccessionReplay {
  constructor(private readonly store: SessionSuccessionStore, private readonly controllerId: string) {}
  private roles(origin?: NativeSessionRef) {
    return this.store.all().filter(state => state.role.origin.controllerId === this.controllerId && state.role.current.controllerId === this.controllerId
      && (!origin || nativeSessionRefKey(state.role.origin) === nativeSessionRefKey(origin)));
  }
  private role(roleId: string, origin?: NativeSessionRef) {
    return this.roles(origin).find(state => state.role.id === roleId) ?? fail(403, 'Succession access is unavailable.');
  }
  historical(roleId: string, ref: NativeSessionRef, origin?: NativeSessionRef): NativeSessionRef {
    const state = this.role(roleId, origin);
    const ancestor = state.operations.find(record => record.phase === 'committed' && nativeSessionRefKey(record.from) === nativeSessionRefKey(ref));
    if (!ancestor) return fail(403, 'History is outside the committed ancestors.');
    return ancestor.from;
  }
  read(path: string, query: URLSearchParams, origin?: NativeSessionRef) {
    const action = path === '/v1/session-successions' ? 'list' : path === '/v1/session-successions/current' ? 'current' : path === '/v1/session-successions/operation' ? 'operation' : fail(404, 'Unknown succession replay route.');
    const keys = action === 'current' ? ['roleId'] : action === 'operation' ? ['roleId', 'operationId'] : ['roleId', 'afterRevision', 'limit', 'cursor'];
    if ([...query.keys()].some(key => !keys.includes(key) || query.getAll(key).length !== 1)) return fail(400, 'Invalid succession replay selection.');
    const roleId = query.get('roleId') ?? undefined;
    if (roleId !== undefined && !validId(roleId) || (action !== 'list' || query.has('afterRevision')) && !roleId) return fail(400, 'Invalid succession role selection.');
    if (roleId) this.role(roleId, origin);
    if (action === 'current') {
      const role = this.role(roleId!, origin).role;
      const result = { version: 1 as const, role, locator: localSuccessionLocator(role.current) };
      if (!isSessionSuccessionCurrent(result)) return fail(503, 'Current succession is unavailable.');
      return result;
    }
    const entries = this.roles(origin).filter(state => !roleId || state.role.id === roleId).flatMap(state => state.operations.filter(record => record.phase === 'committed').map(receipt => {
      this.store.assertCommittedProjection(receipt.operationId);
      const item = { version: 1 as const, projection: { version: 1 as const,
        role: { ...state.role, revision: receipt.committedRevision!, current: receipt.to!, workspace: receipt.prepared!.workspace }, receipt },
        from: localSuccessionLocator(receipt.from), to: localSuccessionLocator(receipt.to!) };
      if (!isSessionSuccessionReplay(item)) return fail(503, 'Committed succession is unavailable.');
      return item;
    })).sort((a, b) => compare(a.projection.role.id, b.projection.role.id) || a.projection.role.revision - b.projection.role.revision);
    if (action === 'operation') {
      const operationId = query.get('operationId') ?? undefined;
      if (!validId(operationId)) return fail(400, 'Invalid succession operation selection.');
      return entries.find(item => item.projection.receipt.operationId === operationId) ?? fail(403, 'Succession access is unavailable.');
    }
    const counter = (name: string, fallback: number) => { const value = query.get(name); return value === null ? fallback : /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN; };
    const afterRevision = counter('afterRevision', 0), limit = counter('limit', 32);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) return fail(400, 'Invalid succession replay selection.');
    const scope = [this.controllerId, origin ? nativeSessionRefKey(origin) : null, roleId ?? null, afterRevision];
    let after: { roleId: string; revision: number } | undefined;
    const cursor = query.get('cursor');
    if (cursor !== null) {
      try {
        if (!cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!decoded || Object.keys(decoded).length !== 3 || !isDeepStrictEqual(decoded.scope, scope) || !validId(decoded.roleId)
          || !Number.isSafeInteger(decoded.revision) || decoded.revision < 2) throw new Error();
        after = decoded;
      } catch { return fail(400, 'Invalid succession replay cursor.'); }
    }
    const available = entries.filter(item => item.projection.role.revision > afterRevision && (!after || compare(item.projection.role.id, after.roleId) > 0
      || item.projection.role.id === after.roleId && item.projection.role.revision > after.revision));
    const successions: SessionSuccessionReplay[] = []; let bytes = 0;
    for (const item of available) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > 8 * 1024 * 1024) return fail(503, 'Succession replay exceeds its response limit.');
      if (successions.length >= limit || bytes + size > 8 * 1024 * 1024) break;
      successions.push(item); bytes += size;
    }
    const last = successions.at(-1)?.projection.role;
    const page: SessionSuccessionReplayPage = { version: 1, successions, nextCursor: last && successions.length < available.length
      ? Buffer.from(JSON.stringify({ scope, roleId: last.id, revision: last.revision })).toString('base64url') : null };
    if (!isSessionSuccessionReplayPage(page)) return fail(503, 'Succession replay is unavailable.');
    return page;
  }
}
