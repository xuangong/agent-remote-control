import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const object = { additionalProperties: false } as const;
const count = Type.Integer({ minimum: 0, maximum: 100_000 });
const bytes = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const usage = Type.Object({ total: bytes, used: bytes }, object);

/** Which directory a reported volume holds: the user's home directory or a workspace. */
export const HostDiskKind = Type.Union([Type.Literal('home'), Type.Literal('workspace')]);
export type HostDiskKind = Static<typeof HostDiskKind>;
/** The most volumes one Host reports: the home directory's and those of its workspaces. */
export const HOST_STATUS_DISK_LIMIT = 8;

/**
 * What a Host reports about itself on request. Sessions are the ones its Controller has open, by state.
 * Machine figures are what the operating system reports as used, not free pages: reclaimable cache is not used memory.
 */
export const HostStatus = Type.Object({
  sampledAt: Type.Integer({ minimum: 0 }),
  sessions: Type.Object({ running: count, waiting: count, idle: count, failed: count }, object),
  cpu: Type.Optional(Type.Object({ cores: Type.Integer({ minimum: 1, maximum: 4096 }), usage: Type.Number({ minimum: 0, maximum: 1 }) }, object)),
  memory: Type.Optional(usage),
  /** The volume of the home directory first, then those of workspaces on other volumes. */
  disks: Type.Optional(Type.Array(Type.Object({ kind: HostDiskKind, path: Type.String({ minLength: 1, maxLength: 1024 }), total: bytes, used: bytes }, object),
    { maxItems: HOST_STATUS_DISK_LIMIT })),
}, object);
export type HostStatus = Static<typeof HostStatus>;

const withinTotal = (value: { total: number; used: number }) => value.used <= value.total;
export function isHostStatus(value: unknown): value is HostStatus {
  return Value.Check(HostStatus, value) && (!value.memory || withinTotal(value.memory)) && (value.disks ?? []).every(withinTotal);
}

/** Machine figures belong to the Host's owner; a Host shared with someone shows them its session counts only. */
export function ownerOnlyHostStatus(status: HostStatus, owner: boolean): HostStatus {
  return owner ? status : { sampledAt: status.sampledAt, sessions: status.sessions };
}
