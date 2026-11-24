/**
 * The Relay's push reminders: at each change of the session states it shares, it pushes the reminders `decidePush` asks for to the
 * devices each account subscribed.
 *
 * Contract. `observe()` reads, for every account with a subscribed device, the session states it may see, compares each with the last
 * one it knew for that account (the first sight of a session, or of an account, is no news; a session that is no longer reported keeps
 * its last known state), and for each change worth a reminder asks `decidePush` with the account's assistant for the session, whether a
 * visible page of the account shows it, whether this reminder of this state (the Relay's time of the change) went out, and the
 * account's devices. Each push
 * carries the assistant's name in the device's language and the reminder's kind, never conversation text, with the conversation's
 * address, the session's tag (also its `Topic`) and the time of the decision. It returns the decisions it sent and sends them without
 * waiting; `settled()` waits for the pushes under way. A push service's 404 or 410 forgets the subscription through the sender's port.
 */
import { accountAssistants, assistantAddress, assistantNamesIn, botViews, encodePushReminder, hasBotAppearance, PUSH_REMINDER_TTL_SECONDS, PUSH_REMINDER_URGENCY,
  pushTag, sessionReminder, viewAssistantKey, type PushLocale, type PushReminderKind, type SessionActivityState, type WindowBotDetails, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { decidePush } from '../domain/push-reminders/push-decision.js';
import type { PushSender } from './push-sender.js';
import type { PushSubscriptions } from './push-subscriptions.js';
import type { PresenceSession, SessionPresence } from './session-presence.js';

/** A session's state as the Relay shares it with an account; `changedAt` is when the Relay saw it change, which names this state. */
export interface ReminderState extends PresenceSession { readonly state: SessionActivityState; readonly changedAt: number }
/** A push the Relay sent, for its own diagnostics and tests. */
export interface SentReminder { readonly subject: string; readonly session: PresenceSession; readonly kind: PushReminderKind; readonly devices: readonly string[] }

export interface PushRemindersPorts {
  readonly sender: Pick<PushSender, 'deliver'>;
  readonly subscriptions: Pick<PushSubscriptions, 'subjects' | 'list'>;
  readonly presence: Pick<SessionPresence, 'shows'>;
  /** The session states an account may see now. */
  states(subject: string): Iterable<ReminderState>;
  /** The account's groups. */
  groups(subject: string): readonly WindowGroup[];
  /** Whether a device still holds a session of the account. */
  signedIn(subject: string, device: string): boolean;
  readonly now: () => number;
}

/** How many sent reminders the Relay remembers, so a state seen twice is pushed once. */
const SENT_LIMIT = 4096;
const sessionKey = (session: PresenceSession) => JSON.stringify([session.hostId, session.providerId, session.nativeSessionId]);

interface Assistant { readonly group: WindowGroup; readonly viewId: string; readonly session: PresenceSession; readonly details?: WindowBotDetails }
/** The assistant each session is in the account: its bot view in a group shown in Bot mode first, else in any group, in catalog order. */
function assistantsOf(groups: readonly WindowGroup[]): Map<string, Assistant> {
  const found = new Map<string, Assistant>();
  for (const group of [...groups.filter(hasBotAppearance), ...groups.filter(group => !hasBotAppearance(group))]) {
    for (const view of botViews(group)) {
      const key = sessionKey(view.binding);
      if (!found.has(key)) found.set(key, { group, viewId: view.id, session: { hostId: view.binding.hostId, providerId: view.binding.providerId, nativeSessionId: view.binding.nativeSessionId }, ...(group.bots?.members[view.id] ? { details: group.bots.members[view.id] } : {}) });
    }
  }
  return found;
}

/** The assistant of a bot's record, by `botId`, when it is among the account's assistants. */
const assistantOfBot = (assistants: Iterable<Assistant>, botId: string) => [...assistants].find(item => item.details?.botId === botId);

export type PushReminders = ReturnType<typeof createPushReminders>;

export function createPushReminders(ports: PushRemindersPorts) {
  const known = new Map<string, Map<string, SessionActivityState>>();
  const sent = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  const remember = (identity: string) => {
    sent.add(identity);
    if (sent.size > SENT_LIMIT) sent.delete(sent.values().next().value!);
  };

  function push(subject: string, state: ReminderState, kind: PushReminderKind, assistant: Assistant, devices: readonly string[], groups: readonly WindowGroup[]) {
    const names = new Map<PushLocale, Map<string, string>>();
    const nameIn = (locale: PushLocale, of: Assistant) => {
      let called = names.get(locale);
      if (!called) names.set(locale, called = assistantNamesIn(accountAssistants(groups), locale));
      return called.get(viewAssistantKey(of.group.window.id, of.viewId)) ?? of.viewId;
    };
    // A staff bot's need collapses under its chief: the chief's tag, the chief named with the bot in it, the click opening the bot's chat.
    // A bot whose chief is the person, a chief that is no assistant of the account, and a finished turn remind on their own.
    const chief = kind === 'needs_you' && assistant.details?.chief ? assistantOfBot(assistantsOf(groups).values(), assistant.details.chief) : undefined;
    const tag = pushTag(chief ? chief.session : state), at = ports.now();
    for (const subscription of ports.subscriptions.list(subject)) {
      if (!devices.includes(subscription.device)) continue;
      const payload = encodePushReminder({ v: 1, kind, name: nameIn(subscription.locale, chief ?? assistant), ...(chief ? { member: nameIn(subscription.locale, assistant) } : {}), locale: subscription.locale,
        url: assistantAddress(assistant.group.window.id, assistant.viewId), tag, at });
      const delivery = ports.sender.deliver(subscription, { payload, topic: tag, ttlSeconds: PUSH_REMINDER_TTL_SECONDS[kind], urgency: PUSH_REMINDER_URGENCY[kind] })
        .finally(() => { pending.delete(delivery); });
      pending.add(delivery);
    }
  }

  return {
    observe(): SentReminder[] {
      const reminders: SentReminder[] = [];
      const subjects = new Set(ports.subscriptions.subjects());
      for (const subject of known.keys()) if (!subjects.has(subject)) known.delete(subject);
      for (const subject of subjects) {
        const previous = known.get(subject);
        const next = new Map(previous ?? []);
        let assistants: Map<string, Assistant> | undefined, groups: readonly WindowGroup[] | undefined;
        for (const state of ports.states(subject)) {
          const key = sessionKey(state), before = previous?.get(key);
          next.set(key, state.state);
          const reminder = sessionReminder(before, state.state);
          if (!reminder) continue;
          groups ??= ports.groups(subject);
          assistants ??= assistantsOf(groups);
          const assistant = assistants.get(key);
          // One push per state: a second need in the same turn is a new state, a report of the same change seen again is not.
          const identity = JSON.stringify([subject, key, reminder, state.changedAt]);
          const devices = ports.subscriptions.list(subject).map(subscription => ({ id: subscription.device, ...(subscription.paused ? { paused: true } : {}), signedIn: ports.signedIn(subject, subscription.device) }));
          const decision = decidePush({ ...(before ? { before } : {}), state: state.state, ...(assistant ? { assistant: { group: assistant.group, ...(assistant.details ? { details: assistant.details } : {}) } } : {}),
            shown: ports.presence.shows(subject, state), sent: sent.has(identity), devices });
          if (!('send' in decision)) continue;
          remember(identity);
          push(subject, state, decision.send, assistant!, decision.devices, groups);
          reminders.push({ subject, session: { hostId: state.hostId, providerId: state.providerId, nativeSessionId: state.nativeSessionId }, kind: decision.send, devices: decision.devices });
        }
        known.set(subject, next);
      }
      return reminders;
    },
    /**
     * Reminds the account that a session needs it, outside a change of its state: once per identity, to its devices that are signed
     * in and not paused, and not while a visible page shows the session.
     */
    remind(subject: string, session: PresenceSession, identity: string): SentReminder | undefined {
      const key = JSON.stringify([subject, identity]);
      if (sent.has(key) || ports.presence.shows(subject, session)) return undefined;
      const groups = ports.groups(subject), assistant = assistantsOf(groups).get(sessionKey(session));
      const devices = ports.subscriptions.list(subject).filter(item => !item.paused && ports.signedIn(subject, item.device)).map(item => item.device);
      if (!assistant || !devices.length) return undefined;
      remember(key);
      push(subject, { ...session, state: 'waiting', changedAt: ports.now() }, 'needs_you', assistant, devices, groups);
      return { subject, session, kind: 'needs_you', devices };
    },
    /** Resolves when every push under way has its outcome. */
    async settled(): Promise<void> { while (pending.size) await Promise.all([...pending]); },
  };
}
