/**
 * The push subscriptions of each account, one per device (a browser), in the Relay state (`HostedRelayState.pushSubscriptions`).
 *
 * Contract. `save` keeps this device's subscription for the account, replacing the one it had; an endpoint belongs to one record only, so
 * a browser that subscribes for another account, or as another device, takes it over. An account keeps `PUSH_DEVICE_LIMIT` devices; a
 * new one beyond that replaces the least recently updated. `remove` forgets this device's; `forgetEndpoint` forgets the subscription a
 * push service ended (404 or 410); `forgetDevices` forgets a device that signed out or was revoked, or every device of the account.
 * The Relay keeps at most `MAX_PUSH_SUBSCRIPTIONS`; past that a new subscription is refused (`PushSubscriptionsError`, 409).
 */
import { isPushSubscriptionRequest, PUSH_DEVICE_LIMIT, type PushDeviceSubscription, type PushSubscriptionRequest } from '@orchardworks/agent-remote-protocol';
import { MAX_PUSH_SUBSCRIPTIONS, type RelayState, type SavedPushSubscription } from '../state.js';

export class PushSubscriptionsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** What a page is told of its device's subscription. */
export const deviceSubscription = (saved: SavedPushSubscription): PushDeviceSubscription =>
  ({ endpoint: saved.endpoint, locale: saved.locale, ...(saved.paused ? { paused: true as const } : {}) });

export type PushSubscriptions = ReturnType<typeof createPushSubscriptions>;

export function createPushSubscriptions(state: RelayState, options: { now?: () => number; accepts(endpoint: string): boolean }) {
  const now = options.now ?? Date.now;
  const all = () => state.read().pushSubscriptions ?? [];
  return {
    device: (subject: string, device: string): SavedPushSubscription | undefined => all().find(item => item.subject === subject && item.device === device),
    list: (subject: string): SavedPushSubscription[] => all().filter(item => item.subject === subject),
    /** The accounts with at least one subscribed device. */
    subjects: (): string[] => [...new Set(all().map(item => item.subject))],
    async save(subject: string, device: string, body: unknown): Promise<SavedPushSubscription> {
      if (!isPushSubscriptionRequest(body)) throw new PushSubscriptionsError(400, 'invalid_push_subscription', 'A push subscription needs an endpoint, its keys and a language.');
      if (!options.accepts(body.endpoint)) throw new PushSubscriptionsError(400, 'push_service_refused', 'The Relay sends pushes only to the browsers\' push services.');
      const request: PushSubscriptionRequest = body;
      return state.mutate(draft => {
        const at = now();
        const saved = draft.pushSubscriptions ??= [];
        const previous = saved.find(item => item.subject === subject && item.device === device);
        const next: SavedPushSubscription = { subject, device, endpoint: request.endpoint, keys: { p256dh: request.keys.p256dh, auth: request.keys.auth }, locale: request.locale,
          ...(request.paused ? { paused: true as const } : {}), createdAt: previous?.createdAt ?? at, updatedAt: at };
        let kept = saved.filter(item => !(item.subject === subject && item.device === device) && item.endpoint !== request.endpoint);
        const own = kept.filter(item => item.subject === subject);
        if (own.length >= PUSH_DEVICE_LIMIT) {
          const oldest = own.reduce((first, item) => item.updatedAt < first.updatedAt ? item : first);
          kept = kept.filter(item => item !== oldest);
        }
        if (kept.length >= MAX_PUSH_SUBSCRIPTIONS) throw new PushSubscriptionsError(409, 'push_subscriptions_limit', 'Push notifications are unavailable for more devices.');
        draft.pushSubscriptions = [...kept, next];
        return next;
      });
    },
    async remove(subject: string, device: string): Promise<boolean> {
      if (!all().some(item => item.subject === subject && item.device === device)) return false;
      await state.mutate(draft => { draft.pushSubscriptions = (draft.pushSubscriptions ?? []).filter(item => !(item.subject === subject && item.device === device)); });
      return true;
    },
    async forgetEndpoint(endpoint: string): Promise<void> {
      if (!all().some(item => item.endpoint === endpoint)) return;
      await state.mutate(draft => { draft.pushSubscriptions = (draft.pushSubscriptions ?? []).filter(item => item.endpoint !== endpoint); });
    },
    /** Forgets the account's subscriptions on these devices, or on every device when none is named. */
    async forgetDevices(subject: string, devices?: readonly string[]): Promise<void> {
      const gone = (item: SavedPushSubscription) => item.subject === subject && (!devices || devices.includes(item.device));
      if (!all().some(gone)) return;
      await state.mutate(draft => { draft.pushSubscriptions = (draft.pushSubscriptions ?? []).filter(item => !gone(item)); });
    },
  };
}
