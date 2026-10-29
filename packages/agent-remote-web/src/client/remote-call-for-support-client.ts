import { isCallForSupportProfile, type CallForSupportProfile, type CallForSupportProfileInput } from '@orchardworks/agent-remote-protocol';

/** The profiles a session may call for, on the session that holds its role now. */
export interface CallForSupportEnablement { hostId: string; providerId: string; nativeSessionId: string; profileIds: string[]; updatedAt: number }
export interface CallForSupportSettings { profiles: CallForSupportProfile[]; enablement: CallForSupportEnablement[] }
export type CallForSupportProfileCommand =
  | { type: 'create'; profile: CallForSupportProfileInput }
  | { type: 'update'; id: string; revision: number; profile: CallForSupportProfileInput }
  | { type: 'delete'; id: string; revision: number };
/** A write lost to a newer revision; reload before saving again. */
export class CallForSupportConflictError extends Error {}

const settings = (value: unknown): CallForSupportSettings => {
  const result = value as Partial<CallForSupportSettings> | undefined;
  if (!result || !Array.isArray(result.profiles) || !result.profiles.every(isCallForSupportProfile) || !Array.isArray(result.enablement)) throw new Error('Invalid Call For Support settings.');
  return { profiles: result.profiles, enablement: result.enablement };
};

/** Account Call For Support settings. Mutations are never retried automatically. */
export class RemoteCallForSupportClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(new URL(`v1/remote/call-for-support${path}`, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`), {
      signal: AbortSignal.timeout(45000), headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const value = await response.json() as { error?: string; code?: string };
    if (!response.ok) throw value.code === 'conflict' ? new CallForSupportConflictError(value.error ?? 'The profile changed.') : new Error(value.error ?? 'Call For Support is unavailable.');
    return value;
  }
  async read(): Promise<CallForSupportSettings> { return settings(await this.request('')); }
  async profile(command: CallForSupportProfileCommand): Promise<CallForSupportSettings & { profile?: CallForSupportProfile }> {
    const value = await this.request('/profiles', command) as { profile?: unknown };
    return { ...settings(value), ...(value.profile && isCallForSupportProfile(value.profile) ? { profile: value.profile } : {}) };
  }
  async enable(input: { hostId: string; providerId: string; nativeSessionId: string; profileIds: string[] }): Promise<CallForSupportSettings> {
    return settings(await this.request('/enablement', input));
  }
}
