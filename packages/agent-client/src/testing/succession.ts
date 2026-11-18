import type { NativeSessionRef, SessionSuccessionCurrent, SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import type { RoleEvidence } from '../succession/settlement.js';

const native = (nativeSessionId: string, providerId: string, controllerId: string): NativeSessionRef => ({ controllerId, providerId, nativeSessionId });

/**
 * One committed Handoff of a role from `from` to `to`, as the Relay replays it. Revision 2 is the first Handoff of a role whose origin
 * is `A`; the role's current session is `to`. Every field has a default; each call returns a new value.
 */
export function buildSuccessionReplay({ from = 'A', to = 'B', revision = 2, roleId = 'primary', providerId = 'recorded', hostId = 'host', controllerId = 'installation', origin, promptEdit = false }: {
  from?: string; to?: string; revision?: number; roleId?: string; providerId?: string; hostId?: string; controllerId?: string; origin?: string;
  /** The Handoff is a prompt edit, which keeps the native history up to the edited message. */
  promptEdit?: boolean;
} = {}): SessionSuccessionReplay {
  const preparation = promptEdit ? { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' } : undefined;
  const request = { operationId: `${roleId}-op-${revision}`, roleId, expectedRevision: revision - 1, from: native(from, providerId, controllerId), ...(preparation ? { preparation } : {}) };
  const workspace = { controllerId, canonicalCwd: '/fixture' };
  const target = native(to, providerId, controllerId);
  return { version: 1, from: { hostId, providerId, nativeSessionId: from }, to: { hostId, providerId, nativeSessionId: to },
    projection: { version: 1, role: { id: roleId, revision, origin: native(origin ?? (roleId === 'primary' ? 'A' : 'X'), providerId, controllerId), current: target, workspace },
      receipt: { ...request, to: target, phase: 'committed', committedRevision: revision, startedAt: 'now', updatedAt: 'now',
        prepared: { ...request, to: target, workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
}

/** The sessions of a role in order, as the chain of replays that moved it: `['A', 'B', 'C']` is A to B (revision 2), B to C (revision 3). */
export function buildSuccessionChain(sessions: readonly string[], options: Parameters<typeof buildSuccessionReplay>[0] = {}): SessionSuccessionReplay[] {
  return sessions.slice(1).map((to, index) => buildSuccessionReplay({ ...options, from: sessions[index]!, to, revision: index + 2, origin: sessions[0] }));
}

/** The Relay's current role after the last replay of a chain. */
export function buildSuccessionCurrent(chain: readonly SessionSuccessionReplay[]): SessionSuccessionCurrent {
  const last = chain.at(-1)!;
  return { version: 1, role: structuredClone(last.projection.role), locator: { ...last.to } };
}

/** What one role's discovery confirms: its chain and its current locator. */
export function buildRoleEvidence(sessions: readonly string[], options: Parameters<typeof buildSuccessionReplay>[0] = {}): RoleEvidence {
  const replays = buildSuccessionChain(sessions, options);
  return { replays, current: buildSuccessionCurrent(replays) };
}
