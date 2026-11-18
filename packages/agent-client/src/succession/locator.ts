import type { SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';

/** A native session as a Workbench names it. A missing Host is the local one. */
export interface SessionLocator { hostId?: string; providerId: string; nativeSessionId: string }

/** The identity of a native session on a Host; equal keys are the same session. */
export function sessionKey(item: SessionLocator): string {
  return JSON.stringify([item.hostId ?? 'local', item.providerId, item.nativeSessionId]);
}

/** A role's identity inside one local scope: the Host and Controller that own it, and its id. */
export interface RoleKeyParts { scope: string; hostId: string; controllerId: string; roleId: string }
export function roleKey(value: RoleKeyParts): string { return JSON.stringify([value.scope, value.hostId, value.controllerId, value.roleId]); }

/** The role a committed replay belongs to, on the Host and Controller that committed it. */
export function replayRoleKey(scope: string, replay: SessionSuccessionReplay): string {
  return roleKey({ scope, hostId: replay.to.hostId, controllerId: replay.projection.role.current.controllerId, roleId: replay.projection.role.id });
}

/** Whether a replay moved a conversation from or to this session. */
export function replayTouches(replay: SessionSuccessionReplay, session: SessionLocator): boolean {
  const key = sessionKey(session);
  return sessionKey(replay.from) === key || sessionKey(replay.to) === key;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** JSON with sorted keys: equal values give equal text. Refuses values JSON cannot carry. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Invalid canonical value.');
  return JSON.stringify(value);
}
