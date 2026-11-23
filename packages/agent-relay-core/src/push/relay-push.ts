/**
 * The Relay's push notifications in one place for its HTTP edge: the subscriptions, the sender, the pages that show a session, and the
 * reminders. The edge routes `/v1/push-subscriptions` here, tells it when session states change (`observe`), registers the streams that
 * show a conversation (`presence`), and forgets a device's subscription when it signs out or is revoked (`forgetDevices`).
 *
 * Routes, for the signed-in account and the device the request comes from (its browser):
 * - `GET`: `PushDevice`: the VAPID public key while the Relay sends pushes, and this device's subscription when it has one;
 * - `POST`: `PushSubscriptionRequest`: keeps this device's subscription (400 for a request that is no subscription or an endpoint that is
 *   no browser push service, 503 `push_unavailable` while the Relay sends no pushes);
 * - `DELETE`: forgets this device's subscription.
 * A request whose device the Relay cannot tell apart (a session with no browser identity) is refused with 409 `push_device_unknown`.
 * A key pair that cannot sign leaves push off and is reported once through `onProblem`.
 */
import type { PushDevice, WindowGroup } from '@orchardworks/agent-remote-protocol';
import type { RelayState } from '../state.js';
import type { PushConfiguration } from './push-config.js';
import { createPushReminders, type ReminderState } from './push-reminders.js';
import { createPushSender } from './push-sender.js';
import { createPushSubscriptions, deviceSubscription, PushSubscriptionsError } from './push-subscriptions.js';
import { createSessionPresence, type PresenceSession } from './session-presence.js';
import { importVapidKeys } from './web-push.js';

export interface RelayPushOptions {
  readonly state: RelayState;
  readonly configuration?: PushConfiguration;
  /** The session states an account may see now. */
  states(subject: string): Iterable<ReminderState>;
  /** The account's groups. */
  groups(subject: string): readonly WindowGroup[];
  /** Whether a device still holds a session of the account. */
  signedIn(subject: string, device: string): boolean;
  readonly now?: () => number;
  onProblem?(problem: string): void;
}

export interface PushAnswer { readonly status: number; readonly body: unknown }

export type RelayPush = ReturnType<typeof createRelayPush>;

export function createRelayPush(options: RelayPushOptions) {
  const now = options.now ?? Date.now;
  const configuration = options.configuration;
  const presence = createSessionPresence();
  const sender = configuration && createPushSender({ vapid: configuration.vapid, post: configuration.post ?? (request => fetch(request)), now,
    forget: endpoint => subscriptions.forgetEndpoint(endpoint), ...(configuration.endpoints ? { endpoints: configuration.endpoints } : {}) });
  const subscriptions = createPushSubscriptions(options.state, { now, accepts: endpoint => !!sender?.accepts(endpoint) });
  let ready = false;
  const keys = configuration ? importVapidKeys(configuration.vapid).then(() => { ready = true; },
    (error: Error) => { options.onProblem?.(`The VAPID key pair cannot sign (${error.message}); push notifications are off.`); }) : Promise.resolve();
  const reminders = sender && createPushReminders({ sender, subscriptions, presence, states: options.states, groups: options.groups, signedIn: options.signedIn, now });
  const described = (subject: string, device: string): PushDevice => {
    const saved = subscriptions.device(subject, device);
    return { ...(ready && configuration ? { publicKey: configuration.vapid.publicKey } : {}), ...(saved ? { device: deviceSubscription(saved) } : {}) };
  };
  return {
    presence,
    /** Looks at the session states after a change and pushes the reminders they are worth. */
    observe(): void { if (ready) reminders?.observe(); },
    /** Reminds the account that a session needs it, once per identity, unless a page shows it (a chain past a threshold, bots design 7). */
    remind(subject: string, session: PresenceSession, identity: string): void { if (ready) reminders?.remind(subject, session, identity); },
    async request(method: string, subject: string, device: string | undefined, body: () => Promise<unknown>): Promise<PushAnswer> {
      await keys;
      if (!device) return { status: 409, body: { code: 'push_device_unknown', error: 'This sign-in has no device the Relay can keep a subscription for.' } };
      try {
        if (method === 'GET') return { status: 200, body: described(subject, device) };
        if (method === 'POST') {
          if (!ready) return { status: 503, body: { code: 'push_unavailable', error: 'Push notifications are not available on this server.' } };
          await subscriptions.save(subject, device, await body());
          // The account's states as they are now are its first sight, so the next change is compared with them.
          reminders?.observe();
          return { status: 200, body: described(subject, device) };
        }
        if (method === 'DELETE') { await subscriptions.remove(subject, device); return { status: 200, body: described(subject, device) }; }
        return { status: 405, body: { error: 'Method is not allowed.' } };
      } catch (error) {
        if (error instanceof PushSubscriptionsError) return { status: error.status, body: { code: error.code, error: error.message } };
        throw error;
      }
    },
    /** Forgets the account's subscriptions on devices that signed out or were revoked, or on all of them. */
    forgetDevices: (subject: string, devices?: readonly string[]) => subscriptions.forgetDevices(subject, devices),
    /** Resolves when every push under way has its outcome. */
    settled: async () => { await reminders?.settled(); },
  };
}
