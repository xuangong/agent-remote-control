import type { AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { NativeSessionRef } from '@orchardworks/agent-remote-protocol';

/** Whether a role may move to a session that starts from captured context instead of the native history. */
export type RoleSuccessionDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * A role that gives native sessions Controller tools, such as a Team seat. A role is held by one session at a time;
 * the role decides which session holds it now, and its tools check that on every call.
 */
export interface SessionRole {
  /** The extensions of the role `holder` holds, bound to `actual`, the session that runs them; undefined if it holds none. */
  extensions(holder: NativeSessionRef, actual: () => NativeSessionRef | undefined): Promise<AgentSessionExtensions | undefined>;
  /** Whether a generic succession of `holder` to `targetProviderId` keeps this role; undefined if it holds none. */
  genericSuccession(holder: NativeSessionRef, targetProviderId: string): Promise<RoleSuccessionDecision | undefined>;
}

/** The roles of one Controller. A session holds at most one of them. */
export class SessionRoles {
  constructor(private readonly roles: readonly SessionRole[]) {}
  async extensions(holder: NativeSessionRef, actual: () => NativeSessionRef | undefined): Promise<AgentSessionExtensions | undefined> {
    const held = (await Promise.all(this.roles.map(role => role.extensions(holder, actual)))).filter(value => value !== undefined);
    if (held.length > 1) throw new Error('The native session holds conflicting roles.');
    return held[0];
  }
  /**
   * A generic succession keeps the role its source holds, or is refused. A source without a role moves freely; a Side
   * or Ask keeps reading its source through the source relation, which moves with it.
   */
  async genericSuccession(holder: NativeSessionRef, targetProviderId: string): Promise<RoleSuccessionDecision> {
    const decisions = (await Promise.all(this.roles.map(role => role.genericSuccession(holder, targetProviderId)))).filter(value => value !== undefined);
    if (decisions.length > 1) return { allowed: false, reason: 'The session holds conflicting roles.' };
    return decisions[0] ?? { allowed: true };
  }
}
