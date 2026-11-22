import { createContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { LiveBudget, type LiveRegistration, type LiveRegistrationState } from './live-budget.js';

/** Which mounted conversations of this device keep a live stream; see `LiveBudget`. Slots are composition slot IDs. */
export interface LiveConnections {
  live(slotId: string): boolean;
  register(slotId: string, state: LiveRegistrationState): LiveRegistration;
  /** Calls back whenever a conversation becomes live or is released; each conversation reads its own state. */
  subscribe(listener: () => void): () => void;
}
export const LiveConnectionsContext = createContext<LiveConnections | undefined>(undefined);

const apis = new WeakMap<LiveBudget, LiveConnections>();
/**
 * Exposes a budget to React; `version` changes whenever a conversation becomes live or is released. `live`, `register`
 * and `subscribe` keep their identity per budget, so a view's registration lasts as long as the view, and `stable` is
 * the budget's operations alone: provided through context, a change of one conversation's liveness renders that
 * conversation, not every mounted one.
 */
export function liveConnections(budget: LiveBudget): LiveConnections & { version: number; stable: LiveConnections } {
  let api = apis.get(budget);
  if (!api) {
    api = { live: slotId => budget.live(slotId), register: (slotId, state) => budget.register(slotId, state), subscribe: listener => budget.subscribe(listener) };
    apis.set(budget, api);
  }
  return { ...api, version: budget.version, stable: api };
}

/** This page's live budget for a workspace scope. The per-view Disconnect it replaces kept its choices in this browser; they are dropped. */
export function useLiveBudget(scope: string, options?: ConstructorParameters<typeof LiveBudget>[0]): LiveConnections & { version: number; stable: LiveConnections } {
  const budget = useMemo(() => new LiveBudget(options), [scope]);
  const version = useSyncExternalStore(listener => budget.subscribe(listener), () => budget.version);
  useEffect(() => { try { localStorage.removeItem(`agent-remote:window-connections:${scope}`); } catch { /* Nothing to drop without storage. */ } }, [scope]);
  return useMemo(() => liveConnections(budget), [budget, version]);
}
