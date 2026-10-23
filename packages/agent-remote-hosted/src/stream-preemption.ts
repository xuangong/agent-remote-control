import type { PreemptibleSubscription, SessionChannelPreemption } from '@orchardworks/agent-remote-protocol';

/**
 * An account's session streams go to the subscriptions its browsers used most recently. At the limit, a
 * subscription opens by closing the least recently used ones first; a subscription in use, or used at least
 * as recently as the one opening, is never closed for it. Closed subscriptions wait until they are in use
 * again, so two pages cannot keep taking streams from each other on their own.
 */
export function createStreamPreemption(count: (subject: string) => number, limit: number) {
  const subscriptions = new Map<string, Set<PreemptibleSubscription>>();
  return {
    channel(subject: string): SessionChannelPreemption {
      return { register(subscription) {
        let owned = subscriptions.get(subject);
        if (!owned) subscriptions.set(subject, owned = new Set());
        owned.add(subscription);
        const registered = owned;
        return () => {
          registered.delete(subscription);
          if (!registered.size && subscriptions.get(subject) === registered) subscriptions.delete(subject);
        };
      } };
    },
    /** Brings the account below its limit for a subscription last used at lastUsed, when less recently used ones exist. */
    makeRoom(subject: string, lastUsed: number): void {
      for (;;) {
        const owned = subscriptions.get(subject);
        if (!owned?.size || count(subject) < limit) return;
        let victim: PreemptibleSubscription | undefined, oldest = lastUsed;
        for (const candidate of owned) {
          const used = candidate.lastUsed();
          if (used < oldest) { victim = candidate; oldest = used; }
        }
        if (!victim) return;
        owned.delete(victim);
        victim.preempt();
      }
    },
  };
}
