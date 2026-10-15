import { createHash, randomBytes } from 'node:crypto';
import { applyWindowOperation, isWorkspaceWindow, isWindowOperationResult, isWindowCreateRequest, isWindowMutation, isWindowDeleteRequest, isWindowSessionBinding, WINDOW_OPERATION_RETENTION_MS, type WorkspaceWindow, type WindowMutation, type WindowDeleteRequest, type WindowCreateRequest, type WindowSessionBinding, type WindowOperationResult } from '@orchardworks/agent-remote-protocol';
import type { RelayState, HostedRelayState } from './state.js';

export interface SavedWindowReceipt { fingerprint: string; result: WindowOperationResult }
export interface SavedWorkspaceWindow {
  subject: string; id: string; window?: WorkspaceWindow; deleted?: true; generation: number;
  manager?: { session: WindowSessionBinding; hash: string; generation: number };
  receipts: SavedWindowReceipt[];
}
export type WindowPrincipal = { subject: string; token?: string; authorize?: () => boolean };
export class WindowServiceError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (status: number, code: string, message: string): never => { throw new WindowServiceError(status, code, message); };
/** Bound service inputs before RelayState clones its durable snapshot. */
function assertInputSize(value: unknown): void {
  let remaining = 300000; const seen = new Set<object>();
  const charge = (input: unknown): void => {
    remaining -= 2;
    if (typeof input === 'string') remaining -= Buffer.byteLength(input, 'utf8');
    else if (input && typeof input === 'object') {
      if (seen.has(input)) fail(400, 'invalid_json', 'Window input must be acyclic JSON.');
      seen.add(input);
      for (const key of Object.keys(input)) { remaining -= Buffer.byteLength(key, 'utf8') + 3; if (remaining < 0) break; charge((input as Record<string, unknown>)[key]); }
      seen.delete(input);
    } else remaining -= 24;
    if (remaining < 0) fail(413, 'body_too_large', 'Window request is too large.');
  };
  charge(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function validWindowState(value: unknown): value is SavedWorkspaceWindow[] {
  if (!Array.isArray(value) || value.length > 10000) return false;
  const ids = new Set<string>();
  return value.every(row => {
    if (!row || typeof row.subject !== 'string' || !row.subject || typeof row.id !== 'string' || !row.id || !Number.isSafeInteger(row.generation) || row.generation < 0
      || (row.deleted !== true && !isWorkspaceWindow(row.window)) || (row.window && row.window.id !== row.id) || (row.deleted && row.window)
      || !Array.isArray(row.receipts) || row.receipts.length > 4096) return false;
    const key = JSON.stringify([row.subject, row.id]); if (ids.has(key)) return false; ids.add(key);
    if (row.manager && (!/^[a-f0-9]{64}$/.test(row.manager.hash) || row.manager.generation !== row.generation || !isWorkspaceWindow({ schemaVersion: 1, id: 'validation', title: 'Validation', revision: 0, primaryViewId: 'primary', selectedViewId: 'primary', mainMinimized: false, views: [{ id: 'primary', binding: row.manager.session, placement: 'primary', width: 400, collapsed: false, display: { mode: 'content', lettersVisible: true } }] }))) return false;
    const operations = new Set<string>();
    return row.receipts.every((receipt: SavedWindowReceipt) => {
      if (!/^[a-f0-9]{64}$/.test(receipt.fingerprint) || !isWindowOperationResult(receipt.result) || Object.keys(receipt).some(key => !['fingerprint', 'result'].includes(key)) || operations.has(receipt.result.operationId)) return false;
      operations.add(receipt.result.operationId); return true;
    });
  });
}
export function createWindowWorkspaces(state: RelayState, canReadSession: (subject: string, binding: WindowSessionBinding) => boolean, now = Date.now) {
  const waiters = new Map<string, Set<() => void>>(); let closed = false;
  function rowFor(snapshot: HostedRelayState, principal: WindowPrincipal, id: string, allowDeleted = false) {
    if (closed || principal.authorize?.() === false) fail(401, 'unauthorized', 'Authorization is unavailable.');
    const row = snapshot.workspaceWindows?.find(row => row.id === id && row.subject === principal.subject);
    if (!row || (!allowDeleted && row.deleted)) fail(404, 'window_not_found', 'Window is unavailable.');
    if (principal.token && (!row!.manager || row!.manager.hash !== hash(principal.token))) fail(403, 'manager_revoked', 'Window management grant is unavailable.');
    return row!;
  }
  function bindings(subject: string, window: WorkspaceWindow) {
    if (window.views.some(view => view.binding && !canReadSession(subject, view.binding))) fail(403, 'session_forbidden', 'A referenced session is unavailable.');
  }
  function notify(subject: string, id: string) { for (const wake of waiters.get(JSON.stringify([subject, id])) ?? []) wake(); }
  function time(issuedAt: number) { if (issuedAt <= now() - WINDOW_OPERATION_RETENTION_MS || issuedAt > now() + 60_000) fail(410, 'operation_expired', 'Operation issuance time is outside retention.'); }
  function settle(row: SavedWorkspaceWindow, input: WindowCreateRequest | WindowMutation | WindowDeleteRequest, apply: () => void) {
    const fingerprint = hash(canonical(input)); const previous = row.receipts.find(item => item.result.operationId === input.operationId);
    if (previous && previous.result.expiresAt > now()) {
      if (previous.fingerprint !== fingerprint) fail(409, 'operation_conflict', 'Operation ID was used with different input.');
      return { result: previous.result, ...(row.window ? { window: row.window } : {}) };
    }
    time(input.issuedAt);
    if (previous) fail(410, 'operation_expired', 'Operation result expired.');
    row.receipts = row.receipts.filter(item => item.result.expiresAt > now());
    if (row.receipts.length >= 4096) fail(429, 'receipt_capacity', 'Window operation retention capacity reached.');
    let code: string | undefined; let message: string | undefined;
    try { apply(); } catch (error) {
      if (!(error instanceof WindowServiceError) && !(error instanceof Error)) throw error;
      code = error instanceof WindowServiceError ? error.code : 'invalid_operation'; message = error.message;
    }
    const result: WindowOperationResult = { operationId: input.operationId, status: code ? 'rejected' : 'committed', revision: row.window?.revision ?? ('baseRevision' in input ? input.baseRevision + (code ? 0 : 1) : 0), committedAt: now(), expiresAt: now() + WINDOW_OPERATION_RETENTION_MS, ...(code ? { code, message } : {}) };
    row.receipts.push({ fingerprint, result });
    return { result, ...(row.window ? { window: row.window } : {}) };
  }
  return {
    resolveToken(token: string): WindowPrincipal | undefined {
      const row = state.read().workspaceWindows?.find(row => row.manager?.hash === hash(token));
      return row ? { subject: row.subject, token } : undefined;
    },
    list(principal: WindowPrincipal) { if (principal.token) { const row = state.read().workspaceWindows?.find(row => row.subject === principal.subject && row.manager?.hash === hash(principal.token!)); if (!row) fail(403, 'manager_revoked', 'Window management grant is unavailable.'); rowFor(state.read(), principal, row!.id, true); return { windows: row!.window ? [structuredClone(row!.window)] : [] }; } if (principal.authorize?.() === false) fail(401, 'unauthorized', 'Authorization is unavailable.'); return { windows: state.read().workspaceWindows?.filter(row => row.subject === principal.subject && !row.deleted).map(row => structuredClone(row.window!)) ?? [] }; },
    inspect(principal: WindowPrincipal, id: string) { const row = rowFor(state.read(), principal, id); return { window: structuredClone(row.window!), ...(row.manager ? { manager: { session: structuredClone(row.manager.session), generation: row.manager.generation } } : {}) }; },
    async create(principal: WindowPrincipal, input: WindowCreateRequest) {
      assertInputSize(input);
      if (!isWindowCreateRequest(input)) fail(400, 'invalid_window', 'A valid Window request is required.');
      if (principal.token) fail(403, 'scope_forbidden', 'Management grants cannot create Windows.');
      const outcome = await state.mutate(draft => {
        if (principal.authorize?.() === false) fail(401, 'unauthorized', 'Authorization is unavailable.');
        const rows = draft.workspaceWindows ??= []; let row = rows.find(row => row.subject === principal.subject && row.id === input.window.id);
        if (!row) { time(input.issuedAt); bindings(principal.subject, input.window); if (input.window.revision !== 0) fail(400, 'invalid_revision', 'New Windows start at revision zero.'); if (rows.length >= 10000) fail(429, 'window_capacity', 'Window capacity reached.'); row = { subject: principal.subject, id: input.window.id, generation: 0, receipts: [] }; rows.push(row); }
        return settle(row, input, () => { if (row!.window || row!.deleted) fail(409, 'window_exists', 'Window identity is already used.'); row!.window = structuredClone(input.window); });
      }); notify(principal.subject, input.window.id); return outcome;
    },
    async mutate(principal: WindowPrincipal, id: string, input: WindowMutation | WindowDeleteRequest) {
      assertInputSize(input);
      if (!isWindowMutation(input) && !isWindowDeleteRequest(input)) fail(400, 'invalid_operation', 'A valid Window operation is required.');
      const outcome = await state.mutate(draft => {
        const row = rowFor(draft, principal, id, true);
        return settle(row, input, () => {
          if (row.deleted) fail(404, 'window_not_found', 'Window was deleted.');
          if (row.window!.revision !== input.baseRevision) fail(409, 'revision_conflict', 'Read the current Window revision.');
          if (input.operation.type === 'delete') { delete row.window; row.deleted = true; }
          else { const next = applyWindowOperation(row.window!, input.operation); bindings(principal.subject, next); row.window = next; }
        });
      }); notify(principal.subject, id); return outcome;
    },
    operation(principal: WindowPrincipal, id: string, operationId: string) {
      const row = rowFor(state.read(), principal, id, true); const receipt = row.receipts.find(item => item.result.operationId === operationId);
      if (!receipt) fail(404, 'operation_unknown', 'Operation result is unknown; inspect before taking further action.');
      if (receipt!.result.expiresAt <= now()) fail(410, 'operation_expired', 'Operation result expired.'); return { result: structuredClone(receipt!.result) };
    },
    async assign(principal: WindowPrincipal, id: string, session: WindowSessionBinding | null) {
      assertInputSize(session);
      if (session !== null && !isWindowSessionBinding(session)) fail(400, 'invalid_manager', 'A valid manager session is required.');
      if (principal.token) fail(403, 'scope_forbidden', 'Only users assign managers.');
      const token = randomBytes(32).toString('base64url');
      const outcome = await state.mutate(draft => {
        const row = rowFor(draft, principal, id);
        if (session && !canReadSession(principal.subject, session)) fail(403, 'session_forbidden', 'Manager session access is unavailable.');
        row.generation++; if (session) row.manager = { session: structuredClone(session), hash: hash(token), generation: row.generation }; else delete row.manager;
        return { generation: row.generation, ...(session ? { manager: { session, generation: row.generation }, token } : {}) };
      }); notify(principal.subject, id); return outcome;
    },
    async changes(principal: WindowPrincipal, id: string, afterRevision: number, signal?: AbortSignal, waitMs = 25000) {
      const current = this.inspect(principal, id);
      if (current.window.revision > afterRevision) return current;
      if (closed || signal?.aborted) fail(499, 'request_cancelled', 'Request cancelled.');
      const key = JSON.stringify([principal.subject, id]);
      if ((waiters.get(key)?.size ?? 0) >= 32) fail(429, 'waiter_capacity', 'Window subscription capacity reached.');
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); signal?.removeEventListener('abort', wake); const group = waiters.get(key); group?.delete(wake); if (!group?.size) waiters.delete(key); resolve(); };
        const timer = setTimeout(wake, Math.min(25000, Math.max(0, waitMs))); const group = waiters.get(key) ?? new Set(); group.add(wake); waiters.set(key, group); signal?.addEventListener('abort', wake, { once: true });
      });
      if (signal?.aborted) fail(499, 'request_cancelled', 'Request cancelled.');
      return this.inspect(principal, id);
    },
    close() { closed = true; for (const group of waiters.values()) for (const wake of group) wake(); waiters.clear(); },
  };
}
