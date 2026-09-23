/** Internal, allowlisted metadata delivered over the authenticated Host RPC channel. */
export const RELAY_DIAGNOSTIC_PATH = '/remote/diagnostics/relay';
export const MAX_RELAY_DIAGNOSTICS = 4096;
export const MAX_HOST_DIAGNOSTICS = 256;
export const RELAY_DIAGNOSTIC_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_DIAGNOSTIC_BATCH = 32;
const events = ['relay_started', 'host_registered', 'host_disconnected', 'rpc_timeout', 'rpc_failed', 'stream_opening', 'stream_ready', 'stream_closed', 'stream_open_timeout', 'authority_refresh_started', 'authority_refresh_completed'] as const;
const reasons = ['socket_closed', 'heartbeat_timeout', 'heartbeat_delivery_failed', 'transport_error', 'connection_replaced', 'authority_unavailable', 'access_revoked', 'relay_closed', 'relay_state_unavailable', 'credential_expired', 'protocol_error', 'stream_timeout', 'host_backpressure', 'write_failed', 'runtime_rejected', 'authority_active', 'authority_timeout', 'authority_http_error', 'authority_transport_error', 'authority_invalid_response'] as const;
const operations = ['catalog', 'attach', 'create', 'session_read', 'session_control', 'controller_update', 'preview', 'other'] as const;
const startReasons = ['runtime_start', 'core_recovery'] as const;
export interface RelayDiagnosticContext {
  runtimeInstanceId?: string;
  workerVersionId?: string;
  startReason?: typeof startReasons[number];
}
export interface RelayDiagnostic extends RelayDiagnosticContext {
  id: string;
  timestamp: string;
  source: 'relay';
  hostId: string;
  relayInstanceId: string;
  event: typeof events[number];
  connectionId?: string;
  requestId?: string;
  streamId?: string;
  agentId?: string;
  operation?: typeof operations[number];
  reason?: typeof reasons[number];
  status?: number;
  closeCode?: number;
  wasClean?: boolean;
  durationMs?: number;
  pendingRequests?: number;
  streams?: number;
  heartbeatAgeMs?: number;
  leaseRemainingMs?: number;
  retryDelayMs?: number;
}
export interface RelayDiagnosticStore {
  initial?: unknown;
  save(entries: RelayDiagnostic[]): Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,128}$/.test(value);
const identifiers = ['connectionId', 'requestId', 'streamId', 'agentId', 'runtimeInstanceId', 'workerVersionId'] as const;
const counts = ['status', 'closeCode', 'durationMs', 'pendingRequests', 'streams', 'heartbeatAgeMs', 'leaseRemainingMs', 'retryDelayMs'] as const;
const fields = new Set(['id', 'timestamp', 'source', 'hostId', 'relayInstanceId', 'event', 'operation', 'reason', 'startReason', 'wasClean', ...identifiers, ...counts]);
export function isRelayDiagnostic(value: unknown): value is RelayDiagnostic {
  if (!record(value) || Object.keys(value).some(key => !fields.has(key)) || value.source !== 'relay' || !identifier(value.id) || !identifier(value.hostId) || !identifier(value.relayInstanceId)) return false;
  if (typeof value.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp))) return false;
  if (!(events as readonly unknown[]).includes(value.event) || (value.reason !== undefined && !(reasons as readonly unknown[]).includes(value.reason)) || (value.operation !== undefined && !(operations as readonly unknown[]).includes(value.operation))) return false;
  if (value.wasClean !== undefined && typeof value.wasClean !== 'boolean') return false;
  if (value.startReason !== undefined && (value.event !== 'relay_started' || !(startReasons as readonly unknown[]).includes(value.startReason))) return false;
  return identifiers.every(key => value[key] === undefined || identifier(value[key])) && counts.every(key => value[key] === undefined || (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0));
}
export function parseRelayDiagnosticBatch(value: unknown): RelayDiagnostic[] | undefined {
  if (!record(value) || Object.keys(value).length !== 1 || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > MAX_DIAGNOSTIC_BATCH || !value.entries.every(isRelayDiagnostic)) return undefined;
  return value.entries;
}
/** Retention follows append order; clocks are not synchronized across Relay instances. */
export function pruneRelayDiagnostics(value: unknown, now = Date.now()): RelayDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const result: RelayDiagnostic[] = [], perHost = new Map<string, number>(), ids = new Set<string>();
  for (let index = value.length - 1; index >= 0 && result.length < MAX_RELAY_DIAGNOSTICS; index--) {
    const item: unknown = value[index];
    if (!isRelayDiagnostic(item) || now - Date.parse(item.timestamp) > RELAY_DIAGNOSTIC_TTL_MS || ids.has(item.id)) continue;
    const count = perHost.get(item.hostId) ?? 0;
    if (count >= MAX_HOST_DIAGNOSTICS) continue;
    ids.add(item.id); perHost.set(item.hostId, count + 1); result.push(item);
  }
  return result.reverse();
}

/** Older Controllers reject unknown diagnostic events and fields. */
export function relayDiagnosticsForVersion(entries: RelayDiagnostic[], version: number): RelayDiagnostic[] {
  if (version >= 3) return entries;
  const compatible = entries.map(entry => {
    const { wasClean: _clean, runtimeInstanceId: _runtime, workerVersionId: _version, startReason: _start, ...legacy } = entry;
    return legacy;
  });
  if (version >= 2) return compatible;
  return compatible.filter(entry => !entry.event.startsWith('authority_refresh_')).map(entry => {
    const { leaseRemainingMs: _lease, retryDelayMs: _retry, ...legacy } = entry;
    return legacy;
  });
}
