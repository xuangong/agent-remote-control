import { validCallForSupportState } from './call-for-support-profiles.js';
import { validWindowState, type SavedWorkspaceWindow } from './window-workspaces.js';
import { ACCOUNT_TEAM_LIMIT, validSavedTeam } from './team-delivery.js';
import { validFavoritesSuccession, type FavoritesSuccessionProgress } from './favorites-succession.js';
import { validBrokerAssociations, migrateBrokerAssociations } from './succession-associations.js';
import { validLegacySuccessionMirrors, validSuccessionAuthorities } from './session-successions.js';
import { validSourceRelation } from './session-relations.js';
import { MAX_SESSION_TITLES } from './session-titles.js';
import { validBrowserId } from './browser-devices.js';
import { validFavoritesState, type SavedFavoritesTree } from './favorites.js';
import { decodeSessionChannelServerMessage, decodeWorkspaceWindow, isSessionRead, PROTOCOL_VERSION, SESSION_READ_LIMIT, type SessionRead, type SessionTitleUpdate } from '@orchardworks/agent-remote-protocol';
import type { SavedSessionMigration } from './session-migrations.js';
import { validPairingHistory } from './pairing-keys.js';
import { hasHostRecoveryMetadata, retainedHostIdentities, validHostRecovery, validRevokedHosts } from './host-recovery.js';
import { validSessionStar, starKey, MAX_USER_STARS, type SavedSessionStar } from './session-stars.js';
import type { SecurityEvent } from './security.js';
import { validControllerPath } from './controller-location.js';
import type { HostedGrant } from './auth.js';
import { hostedAuthStateConfig, hostedAuthNamespace, validAllowedEmail, type HostedAuthOptions } from './hosted-auth.js';
import type { RemoteHostBrokerState } from './broker.js';
import type { HostPreviewState } from './host-previews.js';
import { validPreviewNames } from './preview-names.js';
import { assertSuccessionCapacity, isSuccessionCapacityError, requireSuccessionEncodingCosts, type SuccessionEncodingCosts } from './succession-capacity.js';
import { decodeRemoteHostUplinkMessage, isControllerIdentity, isHostEnvironment, isPairingPurpose } from '@orchardworks/agent-remote-protocol';
import { freeze } from 'immer';
import { committed, detached, plain } from './drafts.js';

export interface SavedHostedSession { hash: string; grant: HostedGrant; sessionExpiresAt: number; id?: string; label?: string; createdAt?: number; lastSeenAt?: number; browserId?: string; activity?: number[]; authorityConfirmedAt?: number;
  /** A command line's session, approved in a browser: it acts as the user but never counts as recently signed in. */
  commandLine?: true }
export type SavedGatewaySession = SavedHostedSession;
export interface HostedRelayState {
  version: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  successionAccounting?: true;
  workspaceWindows?: SavedWorkspaceWindow[];
  securityEvents?: SecurityEvent[];
  sessionStars?: SavedSessionStar[];
  favoritesTrees?: SavedFavoritesTree[];
  sessionMigrations?: SavedSessionMigration[];
  sessionTitles?: SessionTitleUpdate[];
  sessionTitleRevision?: number;
  /** Each account's read positions, one record per session, and when the account started keeping them. */
  sessionReads?: SavedSessionRead[];
  sessionReadAccounts?: SavedSessionReadAccount[];
  config: { origin: string; issuer: string; provider?: 'google'; clientId?: string };
  googleIdentities?: Array<{ subject: string; email: string }>;
  sessions: SavedHostedSession[];
  tenants: Array<{ subject: string; namespace: string; broker: RemoteHostBrokerState; favoritesSuccession?: FavoritesSuccessionProgress }>;
  loginChallenges: Array<[string, LoginChallenge]>;
  consumedProofs: Array<[string, number]>;
}
export type SavedSessionRead = SessionRead & { subject: string };
export interface SavedSessionReadAccount { subject: string; since: number }
/** Read positions kept across every account. */
export const MAX_SESSION_READS = 16384;
export interface LoginChallenge { expiresAt: number; hostId?: string; returnPath?: string; google?: { nonce: string; verifier: string; browserHash: string; browserId?: string } }
/** What a store's commit wrote, for diagnostics. */
export interface RelayStateCommitStats {
  /** Records in the snapshot and their encoded bytes. */
  records: number; bytes: number;
  /** Records encoded from their payload, and records written to storage. */
  encoded: number; written: number;
}
export interface RelayStateStore {
  initial?: unknown;
  /** Resolve only after the entire snapshot is durably and atomically committed. The state is frozen; never change it. */
  commit(state: HostedRelayState): Promise<void | RelayStateCommitStats>;
  close?(): void | Promise<void>;
}
/** One commit of the Relay state. Durations are wall-clock milliseconds; a runtime may only advance its clock at I/O. */
export interface RelayStateCommitMetrics {
  durationMs: number;
  /** The change and its staging, and succession capacity accounting, which validates the state. */
  changeMs: number; capacityMs: number;
  /** Encoding and the durable write. */
  storeMs: number;
  store?: RelayStateCommitStats;
}
export function emptyRelayState(auth: HostedAuthOptions): HostedRelayState {
  return { version: 2, config: hostedAuthStateConfig(auth), sessions: [], tenants: [], loginChallenges: [], consumedProofs: [] };
}
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const string = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function unique<T>(values: T[], key: (value: T) => string) { return new Set(values.map(key)).size === values.length; }
function validBroker(value: unknown): value is RemoteHostBrokerState {
  if (!record(value) || !Array.isArray(value.keys) || value.keys.length > 128 || !Array.isArray(value.hosts) || value.hosts.length > 128 ||
    !Array.isArray(value.bindings) || value.bindings.length > 4096 || !Array.isArray(value.creations) || value.creations.length > 4096) return false;
  if (value.teams !== undefined && (!Array.isArray(value.teams) || value.teams.length > ACCOUNT_TEAM_LIMIT || !value.teams.every(validSavedTeam) || !unique(value.teams, (team: {id:string}) => team.id))) return false;
  if (value.callForSupport !== undefined && !validCallForSupportState(value.callForSupport)) return false;
  if (value.associations !== undefined) { try { migrateBrokerAssociations(value.associations); } catch { return false; } }
  if (value.revokedHosts !== undefined && !validRevokedHosts(value.revokedHosts)) return false;
  try { retainedHostIdentities(value as RemoteHostBrokerState); } catch { return false; }
  if (value.keys.some((item: unknown) => Array.isArray(item) && record(item[1]) && item[1].recovery !== undefined && (!validHostRecovery(item[1].recovery)
    || item[1].installationId !== item[1].recovery.installationId || item[1].requiresRotation !== true || item[1].kind !== undefined || item[1].purpose !== 'host-only'
    || !value.revokedHosts?.some((host: any) => host.hostId === item[1].recovery.hostId && host.installationId === item[1].recovery.installationId && host.revocationId === item[1].recovery.revocationId)))) return false;
  if (value.pairings !== undefined && !validPairingHistory(value.pairings)) return false;
  if (value.previews !== undefined && (!Array.isArray(value.previews) || value.previews.length > 128 || !value.previews.every((entry: unknown) => record(entry) && string(entry.hostId)
    && value.hosts.some((host: any) => host.id === entry.hostId) && Array.isArray(entry.pendingRemovals) && entry.pendingRemovals.length <= 1024 && entry.pendingRemovals.every((id: unknown) => string(id))
    && unique(entry.pendingRemovals, (id: string) => id) && validPreviewNames(entry) && decodeRemoteHostUplinkMessage(JSON.stringify({ uplinkVersion: 2, type: 'preview_snapshot', snapshot: entry.snapshot })).status === 'ok')
    || (Array.isArray(value.previews) && !unique(value.previews, (entry: HostPreviewState) => entry.hostId)))) return false;
  if (!value.keys.every((item: unknown) => Array.isArray(item) && item.length === 2 && /^[a-f0-9]{64}$/.test(item[0]) && record(item[1]) && time(item[1].expires) && (item[1].purpose === undefined || isPairingPurpose(item[1].purpose)) && (item[1].pairingId === undefined || string(item[1].pairingId, 128)) && (item[1].claimedAt === undefined || time(item[1].claimedAt)) && (item[1].installationId === undefined || string(item[1].installationId)) && (item[1].kind === undefined || item[1].kind === 'device') && (item[1].requiresRotation === undefined || typeof item[1].requiresRotation === 'boolean')) ||
    !value.hosts.every((host: unknown) => record(host) && string(host.id) && string(host.installationId) && string(host.name) && (host.pairingPurpose === undefined || isPairingPurpose(host.pairingPurpose)) && (host.environment === undefined || isHostEnvironment(host.environment)) && (host.controller === undefined || isControllerIdentity(host.controller)) && (host.gatewayKeyRequested === undefined || typeof host.gatewayKeyRequested === 'boolean') && typeof host.legacyDsh === 'boolean' && Array.isArray(host.providers) && host.providers.every((provider: unknown) => record(provider) && string(provider.providerId) && string(provider.displayName))) ||
    !value.bindings.every((binding: unknown) => record(binding) && ['hostId', 'providerId', 'nativeSessionId', 'agentId'].every(key => string(binding[key], 4096)) && value.hosts.some((host: any) => host.id === binding.hostId) && (binding.sourceRelation === undefined || validSourceRelation(binding.sourceRelation) && binding.sourceRelation.sourceNativeSessionId !== binding.nativeSessionId) && (binding.creatorSubject === undefined || string(binding.creatorSubject)) && (binding.parentNativeSessionId === undefined || string(binding.parentNativeSessionId, 4096))) ||
    !value.creations.every((item: unknown) => Array.isArray(item) && item.length === 2 && string(item[0], 16384) && record(item[1]) && string(item[1].fingerprint, 65536) && value.bindings.some((binding: any) => binding.agentId === item[1].agentId))) return false;
  if (!unique(value.keys, item => item[0]) || !unique(value.hosts, item => item.id) || !unique(value.hosts, item => item.installationId) || !unique(value.bindings, item => item.agentId) || !unique(value.bindings, item => JSON.stringify([item.hostId, item.providerId, item.nativeSessionId])) || !unique(value.creations, item => item[0])) return false;
  if (value.sharing !== undefined) {
    const sharing = value.sharing;
    if (!record(sharing) || !Array.isArray(sharing.grants) || sharing.grants.length > 4096 || !Array.isArray(sharing.reservations) || sharing.reservations.length > 10000 ||
      !sharing.grants.every((grant: unknown) => record(grant) && string(grant.hostId) && string(grant.subject, 256) && string(grant.label, 320) && Number.isSafeInteger(grant.sessionLimit) && grant.sessionLimit >= 0 && grant.sessionLimit <= 10000 && typeof grant.revoked === 'boolean') ||
      !sharing.reservations.every((entry: unknown) => record(entry) && ['key', 'hostId', 'subject', 'fingerprint', 'nativeRequestId'].every(key => string(entry[key], 65536)) && (entry.agentId === undefined || string(entry.agentId, 4096))) ||
      !unique(sharing.grants, item => JSON.stringify([item.hostId, item.subject])) || !unique(sharing.reservations, item => item.key)) return false;
  }
  return true;
}
/** Frozen parts of committed state that passed validation; equal identity is equal content because nobody can change them. */
interface ValidationMemo {
  tenants: WeakSet<object>; sessions: WeakSet<object>; challenges: WeakSet<object>; proofs: WeakSet<object>; events: WeakSet<object>;
  windows: WeakSet<object>; migrations: WeakSet<object>; stars: WeakSet<object>; titles: WeakSet<object>; reads: WeakSet<object>; authorities: WeakSet<object>;
  progress: WeakSet<object>; favorites: WeakMap<object, WeakSet<object>>; normalized: WeakMap<object, boolean>;
  /** Whole collections that passed, with their uniqueness and per-account counts. */
  lists: Record<'sessions' | 'tenants' | 'challenges' | 'proofs' | 'events' | 'migrations' | 'stars' | 'reads', WeakSet<object>>;
}
const memos = new WeakMap<HostedAuthOptions, ValidationMemo>();
function memoFor(auth: HostedAuthOptions): ValidationMemo {
  let memo = memos.get(auth);
  if (!memo) memos.set(auth, memo = { tenants: new WeakSet(), sessions: new WeakSet(), challenges: new WeakSet(), proofs: new WeakSet(), events: new WeakSet(),
    windows: new WeakSet(), migrations: new WeakSet(), stars: new WeakSet(), titles: new WeakSet(), reads: new WeakSet(), authorities: new WeakSet(), progress: new WeakSet(),
    favorites: new WeakMap(), normalized: new WeakMap(),
    lists: { sessions: new WeakSet(), tenants: new WeakSet(), challenges: new WeakSet(), proofs: new WeakSet(), events: new WeakSet(), migrations: new WeakSet(), stars: new WeakSet(), reads: new WeakSet() } });
  return memo;
}
/** check(item), skipped for a frozen item that passed it before. */
function once<T>(seen: WeakSet<object> | undefined, item: T, check: (item: T) => boolean): boolean {
  if (seen && seen.has(item as object)) return true;
  if (!check(item)) return false;
  if (seen && item !== null && typeof item === 'object' && Object.isFrozen(item)) seen.add(item);
  return true;
}
function checkRelayState(value: unknown, auth: HostedAuthOptions, memo?: ValidationMemo): asserts value is HostedRelayState {
  const invalid = () => { throw new Error('Invalid or unsupported Relay state.'); };
  if (!record(value) || ![2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(value.version) || !record(value.config) || value.config.origin !== auth.origin || value.config.issuer !== hostedAuthStateConfig(auth).issuer || value.config.provider !== hostedAuthStateConfig(auth).provider || value.config.clientId !== hostedAuthStateConfig(auth).clientId) return invalid();
  if (Object.hasOwn(value, 'successionAccounting') && (value.version !== 11 || value.successionAccounting !== true)) return invalid();
  if (Array.isArray(value.tenants) && value.tenants.some((tenant: any) => tenant?.broker?.associations?.freezes?.some((row: any) => row?.receipt?.version === 3)) && value.successionAccounting !== true) return invalid();
  if (value.version < 11 && Array.isArray(value.tenants) && value.tenants.some((tenant: any) => tenant?.broker?.associations?.version === 6)) return invalid();
  if (value.version < 9 && Array.isArray(value.tenants) && value.tenants.some((tenant: any) => tenant?.broker?.associations?.version === 5)) return invalid();
  if (value.version < 8 && Array.isArray(value.tenants) && value.tenants.some((tenant: any) => record(tenant?.broker) && hasHostRecoveryMetadata(tenant.broker as RemoteHostBrokerState))) return invalid();
  if (value.version < 6 && Array.isArray(value.tenants) && value.tenants.some((tenant: any) => tenant?.broker?.associations?.version === 4)) return invalid();
  if (value.version < 5 && Array.isArray(value.tenants) && value.tenants.some((tenant: any) => tenant?.broker?.associations?.version === 3)) return invalid();
  if (value.version < 4 && Array.isArray(value.tenants) && value.tenants.some((tenant: any) => tenant?.broker?.associations?.version === 2)) return invalid();
  if (value.version === 2 && Array.isArray(value.tenants) && value.tenants.some((tenant: any) => tenant?.broker?.associations !== undefined)) return invalid();
  if (!Array.isArray(value.sessions) || value.sessions.length > 1024 || !Array.isArray(value.tenants) || !Array.isArray(value.loginChallenges) || value.loginChallenges.length > 4096 || !Array.isArray(value.consumedProofs) || value.consumedProofs.length > 10000) return invalid();
  if (!once(memo?.lists.sessions, value.sessions, (sessions: any[]) => sessions.every(session => once(memo?.sessions, session, (session: unknown) => record(session) && /^[a-f0-9]{64}$/.test(session.hash) && time(session.sessionExpiresAt) && record(session.grant) && string(session.grant.subject) && session.grant.namespace === hostedAuthNamespace(auth, session.grant.subject) && time(session.grant.expiresAt) && (auth.provider === 'google' ? session.grant.provider === 'google' && session.grant.ticket === undefined && session.grant.nonce === undefined && session.grant.continuation === undefined && time(session.grant.authenticatedAt) && session.grant.authenticatedAt <= session.sessionExpiresAt : (session.grant.provider === undefined || session.grant.provider === 'gateway') && typeof session.grant.ticket === 'string' && string(session.grant.nonce) && string(session.grant.continuation, 6000)) && time(session.grant.sessionExpiresAt) && (session.id === undefined || string(session.id, 128)) && (session.browserId === undefined || validBrowserId(session.browserId)) && (session.activity === undefined || (Array.isArray(session.activity) && session.activity.length <= 8 && session.activity.every(time))) && (session.label === undefined || string(session.label, 128)) && (session.createdAt === undefined || time(session.createdAt)) && (session.lastSeenAt === undefined || time(session.lastSeenAt)) && (session.authorityConfirmedAt === undefined || time(session.authorityConfirmedAt)) && (session.commandLine === undefined || session.commandLine === true) && (session.grant.authenticatedAt === undefined || time(session.grant.authenticatedAt)))) && unique(sessions, item => item.hash)) ||
    !once(memo?.lists.tenants, value.tenants, (tenants: any[]) => tenants.every(tenant => once(memo?.tenants, tenant, (tenant: unknown) => record(tenant) && string(tenant.subject) && tenant.namespace === hostedAuthNamespace(auth, tenant.subject) && validBroker(tenant.broker))) && unique(tenants, item => item.namespace)) ||
    !once(memo?.lists.challenges, value.loginChallenges, (challenges: any[]) => challenges.every(item => once(memo?.challenges, item, (item: unknown) => Array.isArray(item) && item.length === 2 && /^[A-Za-z0-9_-]{43}$/.test(item[0]) && record(item[1]) && time(item[1].expiresAt) && (auth.provider === 'google' ? record(item[1].google) && /^[A-Za-z0-9_-]{43}$/.test(item[1].google.nonce) && /^[A-Za-z0-9_-]{43}$/.test(item[1].google.verifier) && /^[a-f0-9]{64}$/.test(item[1].google.browserHash) && (item[1].google.browserId === undefined || validBrowserId(item[1].google.browserId)) : item[1].google === undefined) && (item[1].returnPath === undefined || validControllerPath(item[1].returnPath)) && (item[1].hostId === undefined || /^[A-Za-z0-9_-]{1,256}$/.test(item[1].hostId)))) && unique(challenges, item => item[0])) ||
    !once(memo?.lists.proofs, value.consumedProofs, (proofs: any[]) => proofs.every(item => once(memo?.proofs, item, (item: unknown) => Array.isArray(item) && item.length === 2 && string(item[0], 128) && item[0].length >= 16 && time(item[1]))) && unique(proofs, item => item[0]))) return invalid();
  if (value.googleIdentities !== undefined && (auth.provider !== 'google' || !Array.isArray(value.googleIdentities) || value.googleIdentities.length > 1024 || !value.googleIdentities.every((identity: unknown) => record(identity) && string(identity.subject) && validAllowedEmail(identity.email)) || !unique(value.googleIdentities, identity => identity.subject))) return invalid();
  if (auth.provider === 'google' && value.sessions.some((session: SavedHostedSession) => !value.googleIdentities?.some((identity: { subject: string }) => identity.subject === session.grant.subject))) return invalid();
  if (value.securityEvents !== undefined && (!Array.isArray(value.securityEvents) || value.securityEvents.length > 4096 || !once(memo?.lists.events, value.securityEvents, (events: unknown[]) => events.every((event: unknown) => once(memo?.events, event, (event: unknown) => record(event) && string(event.id) && string(event.subject) && time(event.at) && string(event.action, 128) && ['allowed', 'denied'].includes(event.outcome) && (event.hostId === undefined || string(event.hostId))))))) return invalid();
  if (value.workspaceWindows !== undefined && !once(memo?.windows, value.workspaceWindows, validWindowState)) return invalid();
  if (!value.tenants.every((tenant: HostedRelayState['tenants'][number]) => once(memo?.authorities, tenant, tenant => validSuccessionAuthorities({ config: value.config, tenants: [tenant] } as HostedRelayState)))) return invalid();
  if (Object.hasOwn(value, 'sessionSuccessions') && (value.version >= 6 || !validLegacySuccessionMirrors(value.sessionSuccessions, value as HostedRelayState))) throw new Error('Invalid legacy succession mirror state.');
  if (value.sessionMigrations !== undefined && (!Array.isArray(value.sessionMigrations) || value.sessionMigrations.length > 16384 || !once(memo?.lists.migrations, value.sessionMigrations, (migrations: any[]) => {
    if (!migrations.every((item: unknown) => once(memo?.migrations, item, (item: unknown) => {
      if (!record(item) || !string(item.subject)) return false;
      const { subject: _, ...migration } = item;
      const decoded = decodeSessionChannelServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_migrated', migration }));
      return decoded.status === 'ok' && item.from.hostId === item.to.hostId && item.from.providerId === item.to.providerId && starKey(item.from) !== starKey(item.to);
    })) || !unique(migrations, (item: SavedSessionMigration) => JSON.stringify([item.subject, item.id]))) return false;
    const counts = new Map<string, number>();
    for (const item of migrations) { const count = (counts.get(item.subject) ?? 0) + 1; if (count > 1024) return false; counts.set(item.subject, count); }
    return true;
  }))) return invalid();
  if (value.sessionStars !== undefined && (!Array.isArray(value.sessionStars) || value.sessionStars.length > 16384 || !once(memo?.lists.stars, value.sessionStars, (stars: any[]) => {
    if (!stars.every((item: unknown) => once(memo?.stars, item, (item: unknown) => record(item) && string(item.subject) && validSessionStar(item)))
      || !unique(stars, (item: SavedSessionStar) => JSON.stringify([item.subject, starKey(item)]))) return false;
    const counts = new Map<string, number>();
    for (const item of stars) { const count = (counts.get(item.subject) ?? 0) + 1; if (count > MAX_USER_STARS) return false; counts.set(item.subject, count); }
    return true;
  }))) return invalid();
  if (value.sessionReads !== undefined && (!Array.isArray(value.sessionReads) || value.sessionReads.length > MAX_SESSION_READS || !once(memo?.lists.reads, value.sessionReads, (reads: any[]) => {
    if (!reads.every((item: unknown) => once(memo?.reads, item, (item: unknown) => {
      if (!record(item) || !string(item.subject)) return false;
      const { subject: _, ...read } = item;
      return isSessionRead(read);
    })) || !unique(reads, (item: SavedSessionRead) => JSON.stringify([item.subject, item.hostId, item.providerId, item.nativeSessionId]))) return false;
    const counts = new Map<string, number>();
    for (const item of reads) { const count = (counts.get(item.subject) ?? 0) + 1; if (count > SESSION_READ_LIMIT) return false; counts.set(item.subject, count); }
    return true;
  }))) return invalid();
  if (value.sessionReadAccounts !== undefined && (!Array.isArray(value.sessionReadAccounts) || value.sessionReadAccounts.length > 4096
    || !value.sessionReadAccounts.every((item: unknown) => record(item) && Object.keys(item).length === 2 && string(item.subject) && time(item.since))
    || !unique(value.sessionReadAccounts, (item: SavedSessionReadAccount) => item.subject))) return invalid();
  if (value.sessionTitleRevision !== undefined && !time(value.sessionTitleRevision)) return invalid();
  if (value.sessionTitles !== undefined) {
    let hosts: Set<string> | undefined;
    const hosted = (hostId: string) => (hosts ??= new Set(value.tenants.flatMap((tenant: HostedRelayState['tenants'][number]) => tenant.broker.hosts.map(host => host.id)))).has(hostId);
    if (!Array.isArray(value.sessionTitles) || value.sessionTitles.length > MAX_SESSION_TITLES || !value.sessionTitles.every((session: unknown) => once(memo?.titles, session, (session: unknown) =>
      decodeSessionChannelServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_title_updated', session })).status === 'ok')
      && record(session) && session.revision <= (value.sessionTitleRevision ?? 0) && hosted(session.hostId)) || !unique(value.sessionTitles, starKey)) return invalid();
  }
  // Progress needs version 7; past that, its validity does not depend on the version.
  if (!value.tenants.every((tenant: HostedRelayState['tenants'][number]) => (tenant.favoritesSuccession === undefined || value.version >= 7)
    && once(memo?.progress, tenant, tenant => validFavoritesSuccession({ version: value.version, tenants: [tenant] } as HostedRelayState)))) return invalid();
  // Each Favorites tree is checked against every star, so remember the pair of collections that passed.
  const trees = value.favoritesTrees, stars = value.sessionStars;
  const pairs = memo && Array.isArray(trees) ? memo.favorites.get(trees) : undefined;
  if (!(pairs && Array.isArray(stars) && pairs.has(stars))) {
    if (!validFavoritesState(value as HostedRelayState)) return invalid();
    if (memo && Array.isArray(trees) && Object.isFrozen(trees) && Array.isArray(stars) && Object.isFrozen(stars)) {
      let passed = memo.favorites.get(trees);
      if (!passed) memo.favorites.set(trees, passed = new WeakSet());
      passed.add(stars);
    }
  }
  if (value.sessions.some((session: SavedHostedSession) => session.grant.profile !== undefined && (!record(session.grant.profile) || !string(session.grant.profile.name) || (session.grant.profile.email !== undefined && !string(session.grant.profile.email, 320))))) return invalid();
}
/** The validated state with legacy fields removed and Windows normalized; a copy the caller owns. */
function migrateRelayState(value: HostedRelayState): HostedRelayState {
  const migrated = structuredClone(value) as HostedRelayState & { sessionSuccessions?: unknown };
  if (migrated.workspaceWindows) for (const row of migrated.workspaceWindows) if (row.window) row.window = decodeWorkspaceWindow(row.window)!;
  delete migrated.sessionSuccessions;
  return migrated;
}
export function validateRelayState(value: unknown, auth: HostedAuthOptions): HostedRelayState {
  checkRelayState(value, auth);
  return migrateRelayState(value);
}
/**
 * validateRelayState for committed state: frozen parts that passed before are not checked again, and a state that needs no
 * migration is returned itself, so its unchanged objects keep their identity for the record cache.
 */
export function checkedRelayState(value: unknown, auth: HostedAuthOptions): HostedRelayState {
  const memo = memoFor(auth);
  checkRelayState(value, auth, memo);
  const normalized = (row: SavedWorkspaceWindow) => {
    if (!row.window) return true;
    let result = memo.normalized.get(row);
    if (result === undefined) {
      result = JSON.stringify(decodeWorkspaceWindow(row.window)) === JSON.stringify(row.window);
      if (Object.isFrozen(row)) memo.normalized.set(row, result);
    }
    return result;
  };
  if (Object.hasOwn(value, 'sessionSuccessions') || value.workspaceWindows?.some(row => !normalized(row))) return migrateRelayState(value);
  return value;
}
/** Only the authenticated Node file adapter calls this explicit v1 migration. */
export function migrateLegacyNodeState(value: unknown, auth: HostedAuthOptions): HostedRelayState | undefined {
  if (value === undefined) return undefined;
  if (record(value) && value.version === 1 && auth.provider === 'google') throw new Error('Legacy Gateway state cannot be migrated into Google authentication.');
  if (record(value) && value.version === 1) return validateRelayState({ ...value, version: 2, config: hostedAuthStateConfig(auth), loginChallenges: [], consumedProofs: [] }, auth);
  return validateRelayState(value, auth);
}
/** Shared normalization for real drafts and disposable complete quote views. */
export function stageRelayState(draft: HostedRelayState, minimumVersion: HostedRelayState['version'], accounting: boolean): void {
  // Read the plain state, so checks over every tenant do not draft what they only read.
  const view = plain(draft);
  const retainAccounting = accounting || view.successionAccounting === true || view.version === 10 || minimumVersion === 10;
  let version = Math.max(view.version, minimumVersion) as HostedRelayState['version'];
  if (view.tenants.some(tenant => tenant.broker.associations)) {
    // The current association version needs no migration; validation checks it like every other version.
    view.tenants.forEach((tenant, index) => {
      if (tenant.broker.associations && tenant.broker.associations.version !== 6) draft.tenants[index]!.broker.associations = migrateBrokerAssociations(tenant.broker.associations);
    });
    if (version < 11) version = 11;
  }
  if (version < 8 && view.tenants.some(tenant => hasHostRecoveryMetadata(tenant.broker))) version = 8;
  if (!retainAccounting && view.tenants.some(tenant => tenant.broker.associations?.freezes.some(row => row.receipt.version === 3))) throw new Error('Native prefix state requires succession accounting.');
  if (retainAccounting) { version = 11; draft.successionAccounting = true; }
  if (draft.version !== version) draft.version = version;
}
export function createRelayState(auth: HostedAuthOptions, storage: RelayStateStore | undefined, failed: () => void, published: () => void, successionEncodingCosts?: SuccessionEncodingCosts,
  observe?: (metrics: RelayStateCommitMetrics) => void) {
  const initial = storage?.initial === undefined ? emptyRelayState(auth) : validateRelayState(storage.initial, auth);
  // Authority leases must be confirmed again after every runtime restart.
  initial.sessions = initial.sessions.map(value => ({ ...value, grant: { ...value.grant, expiresAt: 0 } }));
  let current: HostedRelayState = freeze(initial, true);
  if (successionEncodingCosts !== undefined || current.version === 10 || current.successionAccounting === true) {
    requireSuccessionEncodingCosts(successionEncodingCosts);
    const candidate = committed.produce(current, draft => { stageRelayState(draft, current.version, true); });
    try { assertSuccessionCapacity(candidate, successionEncodingCosts); }
    catch (error) { if (isSuccessionCapacityError(error)) throw new Error(`Cannot activate succession accounting: ${error.message}`); throw error; }
  }
  let queue: Promise<unknown> = Promise.resolve(); let unavailable = false; let closed = false;
  function assertAvailable() { if (closed || unavailable) throw new Error('Relay state is unavailable.'); }
  return {
    /** The committed state. It is deeply frozen: change it only through mutate. */
    read: () => current,
    assertAvailable,
    mutate<T>(change: (draft: HostedRelayState) => T): Promise<T> {
      const operation = queue.then(async () => {
        assertAvailable();
        const started = performance.now();
        let result!: T;
        // Only what the change touches is copied; the rest of the next state is the committed objects themselves.
        const next = committed.produce(current, draft => {
          result = detached(change(draft));
          stageRelayState(draft, current.version, successionEncodingCosts !== undefined || current.successionAccounting === true);
        });
        const changed = performance.now();
        if (next.successionAccounting) requireSuccessionEncodingCosts(successionEncodingCosts);
        if (successionEncodingCosts) assertSuccessionCapacity(next, successionEncodingCosts);
        const measured = performance.now();
        let stats: void | RelayStateCommitStats;
        try { stats = await storage?.commit(next); }
        catch (error) { unavailable = true; failed(); throw error; }
        const stored = performance.now();
        current = next; published();
        try { observe?.({ durationMs: stored - started, changeMs: changed - started, capacityMs: measured - changed, storeMs: stored - measured, ...(stats ? { store: stats } : {}) }); }
        catch { /* Diagnostics never affect a commit. */ }
        return result;
      });
      queue = operation.catch(() => undefined); return operation;
    },
    async close() { closed = true; await queue; await storage?.close?.(); },
  };
}
export type RelayState = ReturnType<typeof createRelayState>;
