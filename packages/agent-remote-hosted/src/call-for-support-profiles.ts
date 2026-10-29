import { randomUUID } from 'node:crypto';
import { CALL_FOR_SUPPORT_PROFILE_LIMIT, isCallForSupportProfile, isCallForSupportProfileInput, nativeSessionRefKey, type CallForSupportProfile,
  type CallForSupportProfileInput, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';

/** The profiles a session may call for, keyed by the session it was set on; it follows the session's handoffs. */
export interface CallForSupportEnablement { hostId: string; providerId: string; nativeSessionId: string; profileIds: string[]; updatedAt: number }
/** Account state of Call For Support, stored with the account's Teams. */
export interface CallForSupportState { profiles: CallForSupportProfile[]; enablement: CallForSupportEnablement[] }
export type CallForSupportProfileCommand =
  | { type: 'create'; profile: CallForSupportProfileInput }
  | { type: 'update'; id: string; revision: number; profile: CallForSupportProfileInput }
  | { type: 'delete'; id: string; revision: number };
/** A session on a Host, resolved to the session that holds its role now. */
export type CallForSupportResolver = (hostId: string, providerId: string, nativeSessionId: string) => NativeSessionRef | undefined;
export interface CallForSupportWorker { hostId: string; providerId: string; nativeSessionId: string }

export const CALL_FOR_SUPPORT_ENABLEMENT_LIMIT = 1024;
export class CallForSupportProfileError extends Error {
  constructor(readonly code: 'conflict' | 'capacity' | 'not_found' | 'invalid', message: string) { super(message); }
}
const fail = (code: CallForSupportProfileError['code'], message: string): never => { throw new CallForSupportProfileError(code, message); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

export function isCallForSupportProfileCommand(value: unknown): value is CallForSupportProfileCommand {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort().join();
  if (value.type === 'create') return keys === 'profile,type' && isCallForSupportProfileInput(value.profile);
  if (value.type === 'update') return keys === 'id,profile,revision,type' && identity(value.id) && revision(value.revision) && isCallForSupportProfileInput(value.profile);
  if (value.type === 'delete') return keys === 'id,revision,type' && identity(value.id) && revision(value.revision);
  return false;
}

export function validCallForSupportState(value: unknown): value is CallForSupportState {
  if (!record(value) || Object.keys(value).sort().join() !== 'enablement,profiles' || !Array.isArray(value.profiles) || !Array.isArray(value.enablement)) return false;
  const profiles = value.profiles as unknown[], enablement = value.enablement as unknown[];
  if (profiles.length > CALL_FOR_SUPPORT_PROFILE_LIMIT || !profiles.every(isCallForSupportProfile)) return false;
  const ids = new Set((profiles as CallForSupportProfile[]).map(profile => profile.id));
  return ids.size === profiles.length && enablement.length <= CALL_FOR_SUPPORT_ENABLEMENT_LIMIT && enablement.every(entry => record(entry)
    && Object.keys(entry).sort().join() === 'hostId,nativeSessionId,profileIds,providerId,updatedAt' && identity(entry.hostId) && identity(entry.providerId)
    && typeof entry.nativeSessionId === 'string' && entry.nativeSessionId.length > 0 && entry.nativeSessionId.length <= 4096 && Number.isFinite(entry.updatedAt)
    && Array.isArray(entry.profileIds) && new Set(entry.profileIds).size === entry.profileIds.length && entry.profileIds.every(id => typeof id === 'string' && ids.has(id)));
}

export function emptyCallForSupportState(): CallForSupportState { return { profiles: [], enablement: [] }; }

/** Applies a profile command; writes must name the revision they replace. */
export function executeProfileCommand(state: CallForSupportState, command: CallForSupportProfileCommand, now: number): CallForSupportProfile | undefined {
  if (command.type === 'create') {
    if (state.profiles.length >= CALL_FOR_SUPPORT_PROFILE_LIMIT) fail('capacity', `At most ${CALL_FOR_SUPPORT_PROFILE_LIMIT} support profiles are allowed.`);
    const profile: CallForSupportProfile = { ...structuredClone(command.profile), id: randomUUID(), revision: 1, updatedAt: now };
    state.profiles.push(profile); return profile;
  }
  const index = state.profiles.findIndex(profile => profile.id === command.id);
  if (index < 0) fail('not_found', 'Support profile not found.');
  const current = state.profiles[index]!;
  if (current.revision !== command.revision) fail('conflict', 'The support profile changed. Reload it before saving.');
  if (command.type === 'delete') {
    state.profiles.splice(index, 1);
    for (const entry of state.enablement) entry.profileIds = entry.profileIds.filter(id => id !== command.id);
    return undefined;
  }
  const profile: CallForSupportProfile = { ...structuredClone(command.profile), id: current.id, revision: current.revision + 1, updatedAt: now };
  state.profiles[index] = profile; return profile;
}

const resolved = (resolve: CallForSupportResolver, entry: CallForSupportWorker) => {
  try { return resolve(entry.hostId, entry.providerId, entry.nativeSessionId); } catch { return undefined; }
};
const sameSession = (resolve: CallForSupportResolver, entry: CallForSupportWorker, worker: CallForSupportWorker) => {
  if (entry.hostId !== worker.hostId) return false;
  const current = resolved(resolve, entry), target = resolved(resolve, worker);
  return !!current && !!target && nativeSessionRefKey(current) === nativeSessionRefKey(target);
};

/** Sets the profiles a session may call for; an empty list turns Call For Support off for it. */
export function setEnablement(state: CallForSupportState, resolve: CallForSupportResolver, worker: CallForSupportWorker, profileIds: string[], now: number): CallForSupportEnablement {
  if (new Set(profileIds).size !== profileIds.length || profileIds.length > CALL_FOR_SUPPORT_PROFILE_LIMIT) fail('invalid', 'Choose each support profile once.');
  for (const id of profileIds) if (!state.profiles.some(profile => profile.id === id)) fail('not_found', 'Support profile not found.');
  if (!resolved(resolve, worker)) fail('not_found', 'The session is unavailable.');
  state.enablement = state.enablement.filter(entry => !sameSession(resolve, entry, worker));
  const entry: CallForSupportEnablement = { ...worker, profileIds: [...profileIds], updatedAt: now };
  state.enablement.push(entry);
  if (state.enablement.length > CALL_FOR_SUPPORT_ENABLEMENT_LIMIT) state.enablement.sort((a, b) => a.updatedAt - b.updatedAt).splice(0, state.enablement.length - CALL_FOR_SUPPORT_ENABLEMENT_LIMIT);
  return entry;
}

/** The profiles a session may call for: its explicit entry, or else the profiles enabled by default. */
export function effectiveProfiles(state: CallForSupportState | undefined, resolve: CallForSupportResolver, worker: CallForSupportWorker): CallForSupportProfile[] {
  if (!state) return [];
  const entry = state.enablement.filter(entry => sameSession(resolve, entry, worker)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return entry ? state.profiles.filter(profile => entry.profileIds.includes(profile.id)) : state.profiles.filter(profile => profile.enableByDefault);
}

/** Enablement as the website sees it: on the sessions that hold each entry's role now. */
export function projectEnablement(state: CallForSupportState | undefined, resolve: CallForSupportResolver): CallForSupportEnablement[] {
  return (state?.enablement ?? []).flatMap(entry => {
    const current = resolved(resolve, entry);
    return current ? [{ ...structuredClone(entry), providerId: current.providerId, nativeSessionId: current.nativeSessionId }] : [];
  });
}
