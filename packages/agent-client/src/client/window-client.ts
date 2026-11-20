import {
  decodeWindowGroup, decodeWorkspaceWindow, isWindowGroup, isWindowOperationResult, isWindowSessionBinding,
  type WindowBots, type WindowCreateRequest, type WindowDeleteRequest, type WindowGroup, type WindowGroupCreateRequest, type WindowGroupMutation,
  type WindowMergeRequest, type WindowMutation, type WindowOperationResult, type WindowPresentation, type WindowSessionBinding,
  type WindowSplitRequest, type WindowTransferRequest, type WorkspaceWindow,
} from '@orchardworks/agent-remote-protocol';
import { withMessageKey } from '../presentation/locale-choice.js';
import type { MessageKey } from '../presentation/messages.js';

export class WindowRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly result?: WindowOperationResult, messageKey?: MessageKey) {
    super(message); this.name = 'WindowRequestError';
    if (messageKey) withMessageKey(this, messageKey);
  }
}
export type WindowOperationIdentity = Pick<WindowCreateRequest, 'operationId' | 'issuedAt'>;
/** Preserve the exact request when transport failure cannot establish its outcome. */
export class WindowMutationUnknownError extends Error {
  readonly code = 'operation_unknown';
  constructor(readonly windowId: string, readonly request: WindowCreateRequest | WindowDeleteRequest, cause: unknown, readonly result?: WindowOperationResult) {
    super(result?.status === 'committed' ? 'The Window operation committed, but its current snapshot is unavailable. Recover the original request before continuing.'
      : 'The Window operation outcome is unknown. Recover the original request before continuing.', { cause });
    this.name = 'WindowMutationUnknownError';
    withMessageKey(this, result?.status === 'committed' ? 'client.error.windowCommitted' : 'client.error.windowUnknown');
  }
}
const identity = (): WindowOperationIdentity => ({ operationId: crypto.randomUUID(), issuedAt: Date.now() });
/**
 * True when a WindowRequestError is a refusal: a request the Relay settled as rejected (HTTP 200 with a rejected `result`) or answered with a 4xx status.
 * It says nothing about whether the request was applied. `false` does not mean the error is not a WindowRequestError: a 5xx answer and
 * `invalid_window_receipt` are WindowRequestErrors too, and neither is a refusal.
 */
export const isWindowRejection = (error: unknown): boolean => error instanceof WindowRequestError && (error.result?.status === 'rejected' || error.status >= 400 && error.status < 500);
export interface WindowSnapshot { window: WorkspaceWindow; manager?: { session: WindowSessionBinding; generation: number }; bots?: WindowBots; presentation?: WindowPresentation }
export interface WindowCommit { window: WorkspaceWindow; result: WindowOperationResult; bots?: WindowBots; presentation?: WindowPresentation }
/** The groups a cross-group operation changed; null for a group it deleted. */
export interface WindowGroupsCommit { result: WindowOperationResult; groups: Record<string, WindowGroup | null> }
interface WindowResponse { value: any; status: number }
/** Layout transport never resumes sessions and never automatically retries mutations. */
export class WindowWorkspaceClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<WindowResponse> {
    const response = await this.fetcher(new URL(`v1/windows${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), {
      method, credentials: 'same-origin', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const value = await response.json();
    if (!response.ok) throw new WindowRequestError(value.error?.message ?? value.error ?? 'Window request failed.', response.status, value.code ?? value.error?.code, undefined,
      value.error?.message ?? value.error ? undefined : 'client.error.windowRequestFailed');
    return { value, status: response.status };
  }
  async list(): Promise<WorkspaceWindow[]> { const { value } = await this.request(''); if (!Array.isArray(value.windows)) throw withMessageKey(new Error('Invalid Window list.'), 'client.error.invalidWindowList'); const windows = value.windows.map(decodeWorkspaceWindow); if (windows.some((window: WorkspaceWindow | undefined) => !window)) throw withMessageKey(new Error('Invalid Window list.'), 'client.error.invalidWindowList'); return windows as WorkspaceWindow[]; }
  /** Every group with its appearances; a Relay without groups answers with Windows only. */
  async listGroups(): Promise<WindowGroup[]> {
    const { value } = await this.request('');
    const raw = value.groups ?? (Array.isArray(value.windows) ? value.windows.map((window: unknown) => ({ window })) : undefined);
    if (!Array.isArray(raw)) throw withMessageKey(new Error('Invalid Window list.'), 'client.error.invalidWindowList');
    const groups = raw.map(decodeWindowGroup);
    if (groups.includes(undefined)) throw withMessageKey(new Error('Invalid Window list.'), 'client.error.invalidWindowList');
    return groups as WindowGroup[];
  }
  async inspect(id: string, signal?: AbortSignal): Promise<WindowSnapshot> { const { value } = await this.request(`/${encodeURIComponent(id)}`, 'GET', undefined, signal); this.validate(value, id); return value; }
  private validate(value: any, id: string): void {
    const decoded = decodeWorkspaceWindow(value.window);
    const appearances = value.bots !== undefined || value.presentation !== undefined;
    if (!decoded || decoded.id !== id || value.manager !== undefined && (!isWindowSessionBinding(value.manager?.session) || !Number.isSafeInteger(value.manager?.generation) || value.manager.generation < 0)
      || appearances && !isWindowGroup({ window: decoded, ...(value.bots === undefined ? {} : { bots: value.bots }), ...(value.presentation === undefined ? {} : { presentation: value.presentation }) })) throw withMessageKey(new Error('Invalid Window snapshot.'), 'client.error.invalidWindowSnapshot');
    value.window = decoded;
  }
  private receipt({ value, status }: WindowResponse, operationId: string): WindowOperationResult {
    if (!isWindowOperationResult(value?.result) || value.result.operationId !== operationId) throw new WindowRequestError('Invalid Window receipt.', status, 'invalid_window_receipt', undefined, 'client.error.invalidWindowReceipt');
    return value.result;
  }
  private committed(result: WindowOperationResult, status: number): void {
    if (result.status === 'rejected') throw new WindowRequestError(result.message ?? 'Window operation was rejected.', status, result.code ?? 'operation_rejected', result,
      result.message === undefined ? 'client.error.windowRejected' : undefined);
  }
  private commit(response: WindowResponse, id: string, result: WindowOperationResult): WindowCommit {
    this.validate(response.value, id);
    // A retained receipt describes its original settlement; the snapshot may have advanced.
    if (result.revision > response.value.window.revision) throw new WindowRequestError('Invalid Window receipt.', response.status, 'invalid_window_receipt', undefined, 'client.error.invalidWindowReceipt');
    return response.value as WindowCommit;
  }
  private async recover(id: string, input: WindowCreateRequest | WindowDeleteRequest): Promise<WindowOperationResult> {
    let result: WindowOperationResult;
    try { result = await this.operation(id, input.operationId); }
    catch (error) { throw new WindowMutationUnknownError(id, input, error); }
    this.committed(result, 200);
    return result;
  }
  /** Read a retained creation receipt without replaying its mutation. */
  async recoverCreate(workspaceWindow: WorkspaceWindow, operation: WindowOperationIdentity): Promise<WindowSnapshot> {
    const input: WindowCreateRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, window: structuredClone(workspaceWindow) };
    const result = await this.recover(workspaceWindow.id, input);
    try { return this.commit({ value: { ...await this.inspect(workspaceWindow.id), result }, status: 200 }, workspaceWindow.id, result); }
    catch (error) { throw new WindowMutationUnknownError(workspaceWindow.id, input, error, result); }
  }
  async create(workspaceWindow: WorkspaceWindow, operation: WindowOperationIdentity = identity()): Promise<WindowSnapshot> {
    const input: WindowCreateRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, window: structuredClone(workspaceWindow) };
    try {
      const response = await this.request('', 'POST', input);
      const result = this.receipt(response, input.operationId);
      this.committed(result, response.status);
      return this.commit(response, workspaceWindow.id, result);
    } catch (error) {
      if (isWindowRejection(error)) throw error;
      return this.recoverCreate(input.window, input);
    }
  }
  /** Creates a group with its appearances. Unlike create, an unknown outcome is left to the caller, who can read it with recoverCreate. */
  async createGroup(group: WindowGroup, operation: WindowOperationIdentity = identity()): Promise<WindowSnapshot> {
    const input: WindowGroupCreateRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, window: structuredClone(group.window),
      ...(group.bots ? { bots: structuredClone(group.bots) } : {}), ...(group.presentation ? { presentation: structuredClone(group.presentation) } : {}) };
    const response = await this.request('', 'POST', input);
    const result = this.receipt(response, input.operationId);
    this.committed(result, response.status);
    return this.commit(response, group.window.id, result);
  }
  /** Rejected settlements remain structured so callers can adopt the current snapshot. */
  async mutate(id: string, mutation: WindowMutation | WindowGroupMutation): Promise<WindowCommit> {
    const response = await this.request(`/${encodeURIComponent(id)}/operations`, 'POST', mutation);
    return this.commit(response, id, this.receipt(response, mutation.operationId));
  }
  async operation(id: string, operationId: string): Promise<WindowOperationResult> { return this.receipt(await this.request(`/${encodeURIComponent(id)}/operations/${encodeURIComponent(operationId)}`), operationId); }
  async changes(id: string, revision: number, signal: AbortSignal): Promise<WindowSnapshot | undefined> { const { value } = await this.request(`/${encodeURIComponent(id)}/changes?afterRevision=${revision}`, 'GET', undefined, signal); if (!value.window) return; this.validate(value, id); return value; }
  /** Read a retained deletion receipt, including after the Window becomes a tombstone. */
  async recoverDelete(workspaceWindow: WorkspaceWindow, operation: WindowOperationIdentity): Promise<void> {
    await this.recover(workspaceWindow.id, { operationId: operation.operationId, issuedAt: operation.issuedAt, baseRevision: workspaceWindow.revision, operation: { type: 'delete' } });
  }
  async delete(workspaceWindow: WorkspaceWindow, operation: WindowOperationIdentity = identity()): Promise<void> {
    const input: WindowDeleteRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, baseRevision: workspaceWindow.revision, operation: { type: 'delete' } };
    try {
      const response = await this.request(`/${encodeURIComponent(workspaceWindow.id)}`, 'DELETE', input);
      this.committed(this.receipt(response, input.operationId), response.status);
    } catch (error) {
      if (isWindowRejection(error)) throw error;
      await this.recoverDelete(workspaceWindow, input);
    }
  }
  async assign(id: string, session: WindowSessionBinding | null): Promise<unknown> { return (await this.request(`/${encodeURIComponent(id)}/manager`, 'POST', { session })).value; }
  /**
   * merge, split and transfer are cross-group operations. Each one is sent to a single group and answers with the groups it changed.
   * - An unknown outcome, such as a lost reply, is left to the caller. Resend the identical request (same operationId) to the same group,
   *   because the Relay answers from a receipt only for the same operation sent to the same group, or read the receipt with `operation(id, operationId)`.
   * - A refusal throws a WindowRequestError whose `code` names the reason. Its `result` is present only when the operation was settled as rejected
   *   (HTTP 200). Service refusals such as `window_not_found`, `operation_conflict` or `receipt_capacity` are 4xx errors without `result`.
   *   `isWindowRejection` is true for both. Before a retry, remember that `operation_conflict` (409) and `operation_expired` (410) do not prove
   *   the first request was not applied: read the receipt with `operation(id, operationId)`, or both groups, before deciding.
   * - After a refusal, read both groups again before retrying with new revisions.
   * - `invalid_window_receipt` (status 200) means the operation was settled but the answer cannot be trusted. Resending only replays it, so read both groups.
   * - `result.revision` is the revision of the group the request was sent to.
   */
  merge(targetId: string, request: WindowMergeRequest): Promise<WindowGroupsCommit> { return this.across(targetId, 'merge', request.source, request); }
  /** Same contract as merge. */
  split(id: string, request: WindowSplitRequest): Promise<WindowGroupsCommit> { return this.across(id, 'split', request.newId, request); }
  /** Same contract as merge. */
  transfer(sourceId: string, request: WindowTransferRequest): Promise<WindowGroupsCommit> { return this.across(sourceId, 'transfer', request.target, request); }
  /**
   * Sends a cross-group request to `id` and checks that the reply holds exactly `id` and `other`, each decoded and keyed by its own Window id.
   * A stray entry could make a store drop an unrelated group. A merge deletes its source, so the Relay answers that group as null.
   */
  private async across(id: string, action: 'merge' | 'split' | 'transfer', other: string, request: WindowMergeRequest | WindowSplitRequest | WindowTransferRequest): Promise<WindowGroupsCommit> {
    const response = await this.request(`/${encodeURIComponent(id)}/${action}`, 'POST', request);
    const result = this.receipt(response, request.operationId);
    this.committed(result, response.status);
    const invalid = () => new WindowRequestError('Invalid Window groups.', response.status, 'invalid_window_receipt', undefined, 'client.error.invalidWindowGroups');
    const raw = response.value.groups;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.hasOwn(raw, id) || !Object.hasOwn(raw, other)
      || Object.keys(raw).some(key => key !== id && key !== other) || action === 'merge' && raw[other] !== null) throw invalid();
    const groups: Record<string, WindowGroup | null> = Object.fromEntries(Object.entries(raw).map(([key, value]) => {
      if (value === null) return [key, null];
      const group = decodeWindowGroup(value);
      if (!group || group.window.id !== key) throw invalid();
      return [key, group];
    }));
    // As for a single group, a retained receipt may describe an earlier revision, but never a later one than the group holds.
    if (groups[id] && result.revision > groups[id].window.revision) throw invalid();
    return { result, groups };
  }
}
