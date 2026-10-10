import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { successionFreezeKey } from '@orchardworks/agent-remote-protocol';
import { advanceFavorites, organizeFavorites } from './favorites.js';
import { committedSuccessionRows, validSuccessionAuthorities } from './session-successions.js';
import { StarError, starKey, type StarIdentity } from './session-star-schema.js';
import type { HostedRelayState } from './state.js';

type Tenant = HostedRelayState['tenants'][number];
type Row = ReturnType<typeof committedSuccessionRows>[number];
export interface FavoritesSuccessionProgress {
  version: 1;
  receipts: Array<{ token: string; operationId: string; roleId: string; roleRevision: number; receiptHash: string; status: 'pending' | 'applied' }>;
}
function identity(row: Row) {
  const projection = row.projection!;
  return { token: row.receipt.token, operationId: projection.receipt.operationId, roleId: projection.role.id, roleRevision: projection.role.revision,
    receiptHash: createHash('sha256').update(JSON.stringify([successionFreezeKey(row.receipt), projection])).digest('hex') };
}
function address(row: Row, target = false): StarIdentity {
  const ref = target ? row.projection!.role.current : row.projection!.receipt.from;
  return { hostId: row.hostId, providerId: ref.providerId, nativeSessionId: ref.nativeSessionId };
}
function mapped(tenant: Tenant, row: Row): boolean {
  const host = tenant.broker.hosts.find(host => host.id === row.hostId);
  return host?.installationId === row.receipt.controllerId && [address(row), address(row, true)]
    .every(ref => host.providers.some(provider => provider.providerId === ref.providerId));
}
export function validFavoritesSuccession(state: HostedRelayState): boolean {
  return state.tenants.every(tenant => {
    const progress = tenant.favoritesSuccession;
    if (progress === undefined) return true;
    if (state.version !== 7 || !progress || progress.version !== 1 || Object.keys(progress).some(key => !['version', 'receipts'].includes(key))
      || !Array.isArray(progress.receipts) || progress.receipts.length > 1024) return false;
    const rows = committedSuccessionRows(tenant.broker);
    const seen = new Set<string>();
    for (const entry of progress.receipts) {
      if (!entry || !['pending', 'applied'].includes(entry.status)) return false;
      const row = rows.find(row => row.receipt.token === entry.token);
      if (!row || seen.has(entry.token)) return false;
      const { status: _, ...saved } = entry;
      if (!isDeepStrictEqual(saved, identity(row))) return false;
      seen.add(entry.token);
    }
    const pending = new Set<string>();
    return rows.every(row => {
      const entry = progress.receipts.find(entry => entry.token === row.receipt.token);
      if (entry?.status !== 'applied') pending.add(row.projection!.role.id);
      return entry?.status !== 'applied' || !pending.has(row.projection!.role.id);
    });
  });
}
/** Existing immutable receipts fence ordinary owner commands even when mapping is absent. */
export function assertOrdinaryFavoriteAddress(state: HostedRelayState, subject: string, session: StarIdentity): void {
  const tenant = state.tenants.find(tenant => tenant.subject === subject);
  if (tenant && committedSuccessionRows(tenant.broker).some(row => starKey(address(row)) === starKey(session))) {
    throw new StarError(409, 'favorites_conflict', 'Favorites changed on another device. Refresh and try again.');
  }
}
/** Stage only product progress; native commit evidence must survive favorite capacity failures. */
export function projectSuccessionFavorites(draft: HostedRelayState, subject: string, authorized = true): boolean {
  const tenant = draft.tenants.find(tenant => tenant.subject === subject);
  if (!tenant) return false;
  const rows = committedSuccessionRows(tenant.broker);
  if (!rows.length) return false;
  if (!validSuccessionAuthorities(draft)) throw new Error('Invalid succession authority.');
  const progress = structuredClone(tenant.favoritesSuccession ?? { version: 1 as const, receipts: [] });
  const scratch = { ...draft, sessionStars: structuredClone(draft.sessionStars), favoritesTrees: structuredClone(draft.favoritesTrees) };
  const blocked = new Set<string>(); let changed = false;
  for (const row of rows) {
    let entry = progress.receipts.find(entry => entry.token === row.receipt.token);
    if (!entry) { entry = { ...identity(row), status: 'pending' }; progress.receipts.push(entry); }
    if (entry.status === 'applied') continue;
    const roleId = row.projection!.role.id;
    if (blocked.has(roleId) || !authorized || !mapped(tenant, row)) { blocked.add(roleId); continue; }
    const from = address(row), to = address(row, true);
    const old = scratch.sessionStars?.find(star => star.subject === subject && starKey(star) === starKey(from));
    if (old) {
      const tree = scratch.favoritesTrees?.find(tree => tree.subject === subject);
      if (tree?.revision === Number.MAX_SAFE_INTEGER) { blocked.add(roleId); continue; }
      try { organizeFavorites(scratch, subject); }
      catch (error) { if (!(error instanceof StarError) || error.status !== 409) throw error; blocked.add(roleId); continue; }
      const duplicate = scratch.sessionStars!.find(star => star.subject === subject && starKey(star) === starKey(to));
      const title = draft.sessionTitles?.find(title => starKey(title) === starKey(to))?.title ?? duplicate?.title ?? old.title;
      const workspace = duplicate?.workspace ?? old.workspace, parentNativeSessionId = duplicate?.parentNativeSessionId;
      Object.assign(old, to, { title });
      delete old.parentNativeSessionId;
      if (workspace !== undefined) old.workspace = workspace;
      if (parentNativeSessionId !== undefined) old.parentNativeSessionId = parentNativeSessionId;
      if (duplicate) scratch.sessionStars = scratch.sessionStars!.filter(star => star !== duplicate);
      changed = true;
    }
    entry.status = 'applied';
  }
  if (changed) advanceFavorites(scratch, scratch.favoritesTrees!.find(tree => tree.subject === subject)!);
  const updated = changed || !isDeepStrictEqual(tenant.favoritesSuccession, progress);
  if (updated) {
    if (changed) { draft.sessionStars = scratch.sessionStars; draft.favoritesTrees = scratch.favoritesTrees; }
    tenant.favoritesSuccession = progress; draft.version = 7;
  }
  return updated;
}
