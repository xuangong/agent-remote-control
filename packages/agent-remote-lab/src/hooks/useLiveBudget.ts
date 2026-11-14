import { createContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { LiveBudget, type LiveRegistration, type LiveRegistrationState } from '../live-budget.js';

/** Which mounted conversations of this device keep a live stream; see `LiveBudget`. Slots are composition slot IDs. */
export interface LiveConnections {
  live(slotId: string): boolean;
  register(slotId: string, state: LiveRegistrationState): LiveRegistration;
}
export const LiveConnectionsContext = createContext<LiveConnections | undefined>(undefined);

const apis = new WeakMap<LiveBudget, LiveConnections>();
/**
 * Exposes a budget to React; `version` changes whenever a conversation becomes live or is released. `live` and `register`
 * keep their identity per budget, so a view's registration lasts as long as the view.
 */
export function liveConnections(budget: LiveBudget): LiveConnections & { version: number } {
  let api = apis.get(budget);
  if (!api) { api = { live: slotId => budget.live(slotId), register: (slotId, state) => budget.register(slotId, state) }; apis.set(budget, api); }
  return { ...api, version: budget.version };
}

/** This page's live budget for a workspace scope. The per-view Disconnect it replaces kept its choices in this browser; they are dropped. */
export function useLiveBudget(scope: string, options?: ConstructorParameters<typeof LiveBudget>[0]): LiveConnections & { version: number } {
  const budget = useMemo(() => new LiveBudget(options), [scope]);
  const version = useSyncExternalStore(listener => budget.subscribe(listener), () => budget.version);
  useEffect(() => { try { localStorage.removeItem(`agent-remote:window-connections:${scope}`); } catch { /* Nothing to drop without storage. */ } }, [scope]);
  return useMemo(() => liveConnections(budget), [budget, version]);
}
