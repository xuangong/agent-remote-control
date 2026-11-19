import { OperationCacheError, SessionBindings } from '@orchardworks/agent-session-runtime';

import { nativeFamily } from './family.js';
import type { SessionBinding } from './types.js';

/** A bound session whose runtime is open now. */
export interface LiveBinding<Agent> { binding: SessionBinding; agent: Agent }

/**
 * Bound sessions: the one owner of which native sessions this Controller has bound to a public agent id, and of the questions asked of that set.
 *
 * Contract.
 * - A binding is made once per native session (`bind`, with the attach step of the caller) and found by agent id or by native identity.
 *   While a bind is in progress its native session is `isPending` and its agent id `isReserved`; after it, both stay reserved. A bind after `close` is refused.
 * - `all` is a snapshot in the order the bindings were made; changing it changes nothing here.
 * - `family` is the session's binding, the children bound under it and their children, all of one provider (`family.ts`).
 * - `live` pairs each binding with its runtime, leaving out those with none. `bindingOf` finds the binding a runtime belongs to and throws the
 *   `invalid_operation_target` operation error for a runtime that has none.
 *
 * Mutable state: the bindings, held by `SessionBindings` and assigned only through this module. Callers receive bindings, never the collection.
 * The only port is `liveAgent`, which says whether an agent id has a runtime.
 */
export interface BoundSessions<Agent> {
  byAgent(agentId: string): SessionBinding | undefined;
  byNative(providerId: string, nativeSessionId: string): SessionBinding | undefined;
  isPending(providerId: string, nativeSessionId: string): boolean;
  isReserved(agentId: string): boolean;
  bind: SessionBindings['bind'];
  close(): void;
  all(): SessionBinding[];
  family(providerId: string, nativeSessionId: string): SessionBinding[];
  live(): LiveBinding<Agent>[];
  bindingOf(agent: object): SessionBinding;
}

export function createBoundSessions<Agent>(liveAgent: (agentId: string) => Agent | undefined): BoundSessions<Agent> {
  const bindings = new SessionBindings();
  const all = () => [...bindings.values()];
  return {
    byAgent: agentId => bindings.getByAgent(agentId),
    byNative: (providerId, nativeSessionId) => bindings.getByNative(providerId, nativeSessionId),
    isPending: (providerId, nativeSessionId) => bindings.isPending(providerId, nativeSessionId),
    isReserved: agentId => bindings.isReserved(agentId),
    bind: (request, extension) => bindings.bind(request, extension),
    close: () => bindings.close(),
    all,
    family: (providerId, nativeSessionId) => nativeFamily(bindings.values(), providerId, nativeSessionId),
    live: () => all().flatMap(binding => { const agent = liveAgent(binding.agentId); return agent ? [{ binding, agent }] : []; }),
    bindingOf(agent) {
      const found = all().find(binding => liveAgent(binding.agentId) === agent);
      if (!found) throw new OperationCacheError('invalid_operation_target', 'The native session binding is unavailable.');
      return found;
    },
  };
}
