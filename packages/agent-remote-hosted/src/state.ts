import type { SecurityEvent } from './security.js';
import { validControllerPath } from './controller-location.js';
import { createHash } from 'node:crypto';
import type { GatewayAuthOptions, GatewayGrant } from './auth.js';
import type { RemoteHostBrokerState } from './broker.js';

export interface SavedGatewaySession { hash: string; grant: GatewayGrant; sessionExpiresAt: number; id?: string; label?: string; createdAt?: number; lastSeenAt?: number }
export interface HostedRelayState {
  version: 2;
  securityEvents?: SecurityEvent[];
  config: { origin: string; issuer: string };
  sessions: SavedGatewaySession[];
  tenants: Array<{ subject: string; namespace: string; broker: RemoteHostBrokerState }>;
  loginChallenges: Array<[string, { expiresAt: number; hostId?: string; returnPath?: string }]>;
  consumedProofs: Array<[string, number]>;
}
export interface RelayStateStore {
  initial?: unknown;
  /** Resolve only after the entire snapshot is durably and atomically committed. */
  commit(state: HostedRelayState): Promise<void>;
  close?(): void | Promise<void>;
}
export function emptyRelayState(auth: GatewayAuthOptions): HostedRelayState {
  return { version: 2, config: { origin: auth.origin, issuer: auth.issuer }, sessions: [], tenants: [], loginChallenges: [], consumedProofs: [] };
}
function record(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const string = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const namespace = (issuer: string, subject: string) => createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
function unique<T>(values: T[], key: (value: T) => string) { return new Set(values.map(key)).size === values.length; }
function validBroker(value: unknown): value is RemoteHostBrokerState {
  if (!record(value) || !Array.isArray(value.keys) || value.keys.length > 128 || !Array.isArray(value.hosts) || value.hosts.length > 128 ||
    !Array.isArray(value.bindings) || value.bindings.length > 4096 || !Array.isArray(value.creations) || value.creations.length > 4096) return false;
  if (!value.keys.every((item: unknown) => Array.isArray(item) && item.length === 2 && /^[a-f0-9]{64}$/.test(item[0]) && record(item[1]) && time(item[1].expires) && (item[1].installationId === undefined || string(item[1].installationId)) && (item[1].kind === undefined || item[1].kind === 'device') && (item[1].requiresRotation === undefined || typeof item[1].requiresRotation === 'boolean')) ||
    !value.hosts.every((host: unknown) => record(host) && string(host.id) && string(host.installationId) && string(host.name) && typeof host.legacyDsh === 'boolean' && Array.isArray(host.providers) && host.providers.every((provider: unknown) => record(provider) && string(provider.providerId) && string(provider.displayName))) ||
    !value.bindings.every((binding: unknown) => record(binding) && ['hostId', 'providerId', 'nativeSessionId', 'agentId'].every(key => string(binding[key], 4096)) && value.hosts.some((host: any) => host.id === binding.hostId) && (binding.creatorSubject === undefined || string(binding.creatorSubject)) && (binding.parentNativeSessionId === undefined || string(binding.parentNativeSessionId, 4096))) ||
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
export function validateRelayState(value: unknown, auth: GatewayAuthOptions): HostedRelayState {
  const invalid = () => { throw new Error('Invalid or unsupported Relay state.'); };
  if (!record(value) || value.version !== 2 || !record(value.config) || value.config.origin !== auth.origin || value.config.issuer !== auth.issuer) return invalid();
  if (!Array.isArray(value.sessions) || value.sessions.length > 1024 || !Array.isArray(value.tenants) || !Array.isArray(value.loginChallenges) || value.loginChallenges.length > 4096 || !Array.isArray(value.consumedProofs) || value.consumedProofs.length > 10000) return invalid();
  if (!value.sessions.every((session: unknown) => record(session) && /^[a-f0-9]{64}$/.test(session.hash) && time(session.sessionExpiresAt) && record(session.grant) && string(session.grant.subject) && session.grant.namespace === namespace(auth.issuer, session.grant.subject) && time(session.grant.expiresAt) && typeof session.grant.ticket === 'string' && string(session.grant.nonce) && string(session.grant.continuation, 6000) && time(session.grant.sessionExpiresAt) && (session.id === undefined || string(session.id, 128)) && (session.label === undefined || string(session.label, 128)) && (session.createdAt === undefined || time(session.createdAt)) && (session.lastSeenAt === undefined || time(session.lastSeenAt)) && (session.grant.authenticatedAt === undefined || time(session.grant.authenticatedAt))) ||
    !value.tenants.every((tenant: unknown) => record(tenant) && string(tenant.subject) && tenant.namespace === namespace(auth.issuer, tenant.subject) && validBroker(tenant.broker)) ||
    !value.loginChallenges.every((item: unknown) => Array.isArray(item) && item.length === 2 && /^[A-Za-z0-9_-]{43}$/.test(item[0]) && record(item[1]) && time(item[1].expiresAt) && (item[1].returnPath === undefined || validControllerPath(item[1].returnPath)) && (item[1].hostId === undefined || /^[A-Za-z0-9_-]{1,256}$/.test(item[1].hostId))) ||
    !value.consumedProofs.every((item: unknown) => Array.isArray(item) && item.length === 2 && string(item[0], 128) && item[0].length >= 16 && time(item[1])) ||
    !unique(value.sessions, item => item.hash) || !unique(value.tenants, item => item.namespace) || !unique(value.loginChallenges, item => item[0]) || !unique(value.consumedProofs, item => item[0])) return invalid();
  if (value.securityEvents !== undefined && (!Array.isArray(value.securityEvents) || value.securityEvents.length > 4096 || !value.securityEvents.every((event: unknown) => record(event) && string(event.id) && string(event.subject) && time(event.at) && string(event.action, 128) && ['allowed', 'denied'].includes(event.outcome) && (event.hostId === undefined || string(event.hostId))))) return invalid();
  return structuredClone(value) as HostedRelayState;
}
/** Only the authenticated Node file adapter calls this explicit v1 migration. */
export function migrateLegacyNodeState(value: unknown, auth: GatewayAuthOptions): HostedRelayState | undefined {
  if (value === undefined) return undefined;
  if (record(value) && value.version === 1) return validateRelayState({ ...value, version: 2, config: { origin: auth.origin, issuer: auth.issuer }, loginChallenges: [], consumedProofs: [] }, auth);
  return validateRelayState(value, auth);
}
export function createRelayState(auth: GatewayAuthOptions, storage: RelayStateStore | undefined, failed: () => void, published: () => void) {
  let current = storage?.initial === undefined ? emptyRelayState(auth) : validateRelayState(storage.initial, auth);
  // Authority leases must be confirmed again after every runtime restart.
  current.sessions = current.sessions.map(value => ({ ...value, grant: { ...value.grant, expiresAt: 0 } }));
  let queue: Promise<unknown> = Promise.resolve(); let unavailable = false; let closed = false;
  function assertAvailable() { if (closed || unavailable) throw new Error('Relay state is unavailable.'); }
  return {
    read: () => current,
    assertAvailable,
    mutate<T>(change: (draft: HostedRelayState) => T): Promise<T> {
      const operation = queue.then(async () => {
        assertAvailable();
        const draft = structuredClone(current); const result = change(draft);
        try { await storage?.commit(draft); }
        catch (error) { unavailable = true; failed(); throw error; }
        current = draft; published(); return result;
      });
      queue = operation.catch(() => undefined); return operation;
    },
    async close() { closed = true; await queue; await storage?.close?.(); },
  };
}
export type RelayState = ReturnType<typeof createRelayState>;
