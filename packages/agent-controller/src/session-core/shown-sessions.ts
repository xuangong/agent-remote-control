import type { SessionBinding } from './types.js';

/**
 * Shown sessions: the sessions of this Host that pages show, as the Relay last said (`journal_shown`). A shown session's idle entry is
 * marked shown, which keeps it resident and live (`residency.ts`, R1).
 *
 * Contract.
 * - `update(sessionKeys)` takes the complete set the Relay sent, which replaces the one before, and marks every bound session shown or
 *   not shown.
 * - A key whose session is not bound yet is kept: `apply(binding)`, called once the session is attached and watched, marks it, so a session
 *   a page showed before the Controller bound it is resident from its first attachment.
 * - A key is the journal's session key, `<providerId>:<nativeSessionId>`.
 *
 * Ports: the bindings and the idle entries' `show`.
 */
export function createShownSessions(ports: { bindings(): Iterable<SessionBinding>; show(agentId: string, shown: boolean): void }) {
  let shown = new Set<string>();
  const keyOf = (binding: Pick<SessionBinding, 'providerId' | 'nativeSessionId'>) => `${binding.providerId}:${binding.nativeSessionId}`;
  return {
    update(sessionKeys: readonly string[]): void {
      shown = new Set(sessionKeys);
      for (const binding of ports.bindings()) ports.show(binding.agentId, shown.has(keyOf(binding)));
    },
    apply(binding: SessionBinding): void { ports.show(binding.agentId, shown.has(keyOf(binding))); },
  };
}
export type ShownSessions = ReturnType<typeof createShownSessions>;
