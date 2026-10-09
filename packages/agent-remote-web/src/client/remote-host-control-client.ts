import { isTpmAction, isTpmCreate, isTpmList, isTpmWork, type TpmAction, type TpmCreate, type TpmList, type TpmWork } from '@orchardworks/agent-remote-protocol';
import { RemoteOperationError, type RemoteRequestOptions } from './transport.js';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type TpmActionInput = WithoutId<TpmAction>;
export class RemoteHostControlError extends RemoteOperationError {
  constructor(code: string, message: string, readonly status: number, requestId?: string) {
    super(code, message, status >= 500 || status === 409, requestId);
  }
}

/** Host management uses existing Relay authorization and never retries mutations. */
export class RemoteHostControlClient {
  private readonly fetcher: typeof fetch;
  constructor(private readonly baseUrl: string, dependencies: { fetch?: typeof fetch } = {}) {
    this.fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  }
  async tpmList(hostId: string, options?: RemoteRequestOptions): Promise<TpmList> {
    const seen = new Set<string>(); const works = new Map<string, TpmWork>();
    let cursor: string | undefined;
    for (;;) {
      const value = await this.request(hostId, `tpm${cursor ? '?' + new URLSearchParams({ cursor }) : ''}`, undefined, options);
      if (!isTpmList(value)) throw invalidResponse();
      for (const work of value.works) if ((works.get(work.id)?.revision ?? 0) <= work.revision) works.set(work.id, work);
      if (!value.nextCursor) { const { nextCursor: _cursor, ...catalog } = value; return { ...catalog, works: [...works.values()] }; }
      if (seen.has(value.nextCursor)) throw invalidResponse();
      seen.add(value.nextCursor); cursor = value.nextCursor;
    }
  }
  async tpmWork(hostId: string, id: string, options?: RemoteRequestOptions): Promise<TpmWork> {
    return this.work(await this.request(hostId, `tpm/work?${new URLSearchParams({ id })}`, undefined, options), id);
  }
  async tpmCreate(hostId: string, input: TpmCreate, options?: RemoteRequestOptions): Promise<TpmWork> {
    if (!isTpmCreate(input)) throw new RemoteHostControlError('invalid_request', 'The TPM creation request is invalid.', 400);
    const value = this.work(await this.request(hostId, 'tpm/create', input, options));
    if (value.providerId !== input.providerId || value.mainNativeSessionId !== input.mainNativeSessionId) throw invalidResponse();
    return value;
  }
  async tpmAction(hostId: string, id: string, input: TpmActionInput, options?: RemoteRequestOptions): Promise<TpmWork> {
    const body = { ...input, id };
    if (!isTpmAction(body)) throw new RemoteHostControlError('invalid_request', 'The TPM action request is invalid.', 400);
    return this.work(await this.request(hostId, 'tpm/action', body, options), id);
  }
  private work(value: unknown, expectedId?: string): TpmWork {
    if (!isTpmWork(value) || (expectedId !== undefined && value.id !== expectedId)) throw invalidResponse();
    return value;
  }
  private async request(hostId: string, path: string, body?: unknown, options?: RemoteRequestOptions): Promise<unknown> {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
    const response = await this.fetcher(new URL(`v1/remote/hosts/${encodeURIComponent(hostId)}/${path}`, base), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: options?.signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let value: unknown;
    try { value = await response.json(); } catch { throw invalidResponse(); }
    if (!response.ok) {
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      throw new RemoteHostControlError(typeof record.code === 'string' ? record.code : 'host_operation_failed',
        typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : 'The Host operation failed.',
        response.status, typeof record.requestId === 'string' ? record.requestId : undefined);
    }
    return value;
  }
}
function invalidResponse(): RemoteHostControlError {
  return new RemoteHostControlError('invalid_host_response', 'The Host TPM response could not be verified. Refresh before trying again.', 502);
}
