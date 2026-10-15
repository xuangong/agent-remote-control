import { isWorkspaceWindow, isWindowOperationResult, isWindowSessionBinding, type WorkspaceWindow, type WindowCreateRequest, type WindowDeleteRequest, type WindowMutation, type WindowOperationResult, type WindowSessionBinding } from '@orchardworks/agent-remote-protocol';

export class WindowRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly result?: WindowOperationResult) { super(message); this.name = 'WindowRequestError'; }
}
export type WindowOperationIdentity = Pick<WindowCreateRequest, 'operationId' | 'issuedAt'>;
/** Preserve the exact request when transport failure cannot establish its outcome. */
export class WindowMutationUnknownError extends Error {
  readonly code = 'operation_unknown';
  constructor(readonly windowId: string, readonly request: WindowCreateRequest | WindowDeleteRequest, cause: unknown, readonly result?: WindowOperationResult) {
    super(result?.status === 'committed' ? 'The Window operation committed, but its current snapshot is unavailable. Recover the original request before continuing.'
      : 'The Window operation outcome is unknown. Recover the original request before continuing.', { cause });
    this.name = 'WindowMutationUnknownError';
  }
}
const identity = (): WindowOperationIdentity => ({ operationId: crypto.randomUUID(), issuedAt: Date.now() });
const rejected = (error: unknown) => error instanceof WindowRequestError && (error.result?.status === 'rejected' || error.status >= 400 && error.status < 500);
export interface WindowSnapshot { window: WorkspaceWindow; manager?: { session: WindowSessionBinding; generation: number } }
export interface WindowCommit { window: WorkspaceWindow; result: WindowOperationResult }
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
    if (!response.ok) throw new WindowRequestError(value.error?.message ?? value.error ?? 'Window request failed.', response.status, value.code ?? value.error?.code);
    return { value, status: response.status };
  }
  async list(): Promise<WorkspaceWindow[]> { const { value } = await this.request(''); if (!Array.isArray(value.windows) || !value.windows.every(isWorkspaceWindow)) throw new Error('Invalid Window list.'); return value.windows; }
  async inspect(id: string, signal?: AbortSignal): Promise<WindowSnapshot> { const { value } = await this.request(`/${encodeURIComponent(id)}`, 'GET', undefined, signal); this.validate(value, id); return value; }
  private validate(value: any, id: string): void { if (!isWorkspaceWindow(value.window) || value.window.id !== id || value.manager !== undefined && (!isWindowSessionBinding(value.manager?.session) || !Number.isSafeInteger(value.manager?.generation) || value.manager.generation < 0)) throw new Error('Invalid Window snapshot.'); }
  private receipt({ value, status }: WindowResponse, operationId: string): WindowOperationResult {
    if (!isWindowOperationResult(value?.result) || value.result.operationId !== operationId) throw new WindowRequestError('Invalid Window receipt.', status, 'invalid_window_receipt');
    return value.result;
  }
  private committed(result: WindowOperationResult, status: number): void {
    if (result.status === 'rejected') throw new WindowRequestError(result.message ?? 'Window operation was rejected.', status, result.code ?? 'operation_rejected', result);
  }
  private commit(response: WindowResponse, id: string, result: WindowOperationResult): WindowCommit {
    this.validate(response.value, id);
    // A retained receipt describes its original settlement; the snapshot may have advanced.
    if (result.revision > response.value.window.revision) throw new WindowRequestError('Invalid Window receipt.', response.status, 'invalid_window_receipt');
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
  async recoverCreate(window: WorkspaceWindow, operation: WindowOperationIdentity): Promise<WindowSnapshot> {
    const input: WindowCreateRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, window: structuredClone(window) };
    const result = await this.recover(window.id, input);
    try { return this.commit({ value: { ...await this.inspect(window.id), result }, status: 200 }, window.id, result); }
    catch (error) { throw new WindowMutationUnknownError(window.id, input, error, result); }
  }
  async create(window: WorkspaceWindow, operation: WindowOperationIdentity = identity()): Promise<WindowSnapshot> {
    const input: WindowCreateRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, window: structuredClone(window) };
    try {
      const response = await this.request('', 'POST', input);
      const result = this.receipt(response, input.operationId);
      this.committed(result, response.status);
      return this.commit(response, window.id, result);
    } catch (error) {
      if (rejected(error)) throw error;
      return this.recoverCreate(input.window, input);
    }
  }
  /** Rejected settlements remain structured so callers can adopt the current snapshot. */
  async mutate(id: string, mutation: WindowMutation): Promise<WindowCommit> {
    const response = await this.request(`/${encodeURIComponent(id)}/operations`, 'POST', mutation);
    return this.commit(response, id, this.receipt(response, mutation.operationId));
  }
  async operation(id: string, operationId: string): Promise<WindowOperationResult> { return this.receipt(await this.request(`/${encodeURIComponent(id)}/operations/${encodeURIComponent(operationId)}`), operationId); }
  async changes(id: string, revision: number, signal: AbortSignal): Promise<WindowSnapshot | undefined> { const { value } = await this.request(`/${encodeURIComponent(id)}/changes?afterRevision=${revision}`, 'GET', undefined, signal); if (!value.window) return; this.validate(value, id); return value; }
  /** Read a retained deletion receipt, including after the Window becomes a tombstone. */
  async recoverDelete(window: WorkspaceWindow, operation: WindowOperationIdentity): Promise<void> {
    await this.recover(window.id, { operationId: operation.operationId, issuedAt: operation.issuedAt, baseRevision: window.revision, operation: { type: 'delete' } });
  }
  async delete(window: WorkspaceWindow, operation: WindowOperationIdentity = identity()): Promise<void> {
    const input: WindowDeleteRequest = { operationId: operation.operationId, issuedAt: operation.issuedAt, baseRevision: window.revision, operation: { type: 'delete' } };
    try {
      const response = await this.request(`/${encodeURIComponent(window.id)}`, 'DELETE', input);
      this.committed(this.receipt(response, input.operationId), response.status);
    } catch (error) {
      if (rejected(error)) throw error;
      await this.recoverDelete(window, input);
    }
  }
  async assign(id: string, session: WindowSessionBinding | null): Promise<unknown> { return (await this.request(`/${encodeURIComponent(id)}/manager`, 'POST', { session })).value; }
}
