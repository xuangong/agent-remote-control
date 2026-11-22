/**
 * Whether the Relay pushes a reminder, and to which devices: a pure rule with one vector table (`push-decision.vectors.ts`).
 *
 * At each change of a session's state the Relay asks, for every account that may see the session:
 * 1. Is the change worth a reminder? Only the two the pages show (`sessionReminder`): it starts waiting for the person (needs you), or
 *    it finishes working (finished). Anything else is `no_change`.
 * 2. Is the session an assistant of the account? A session in none of its groups has no name to remind of (`no_assistant`).
 * 3. Does the assistant send this reminder? None while the chat or its group is muted (`muted`); only needs you when its group asks for
 *    that (`not_wanted`): the protocol's `assistantReminders`, as on every page.
 * 4. Does a visible page of the account show the session? Then the person sees it there, and no push goes out (`shown`).
 * 5. Did this reminder of this session and state go out already? One push per session and state (`sent`).
 * 6. Which devices? Those still signed in to the account whose own notification switch is on; none is `no_device`.
 * Steps 1 to 5 are the account's, so every device of the account gets the same answer.
 */
import { assistantReminders, pushReminderKind, sessionReminder, type PushReminderKind, type SessionActivityState, type WindowBotDetails, type WindowGroup } from '@orchardworks/agent-remote-protocol';

/** A device the account subscribed to push. */
export interface ReminderDevice {
  readonly id: string;
  /** The device's own switch (Settings > Assistants, Notifications) is off. */
  readonly paused?: boolean;
  /** The device still holds a session of the account; a device that signed out or was revoked gets nothing. */
  readonly signedIn: boolean;
}

export interface PushDecisionInput {
  /** The session's last known state, and the state it reports now. */
  readonly before?: SessionActivityState;
  readonly state?: SessionActivityState;
  /** The assistant the session is in the account: its group and its chat's details. Absent when the session is in no group. */
  readonly assistant?: { readonly group: Pick<WindowGroup, 'bots'>; readonly details?: WindowBotDetails };
  /** A visible page of the account shows the session's conversation. */
  readonly shown: boolean;
  /** This reminder of this session and state went out before. */
  readonly sent: boolean;
  readonly devices: readonly ReminderDevice[];
}

export type PushSkip = 'no_change' | 'no_assistant' | 'muted' | 'not_wanted' | 'shown' | 'sent' | 'no_device';
export type PushDecision = { readonly send: PushReminderKind; readonly devices: readonly string[] } | { readonly skip: PushSkip };

export function decidePush(input: PushDecisionInput): PushDecision {
  const reminder = sessionReminder(input.before, input.state);
  if (!reminder) return { skip: 'no_change' };
  if (!input.assistant) return { skip: 'no_assistant' };
  const wanted = assistantReminders(input.assistant.group, input.assistant.details);
  if (!wanted.length) return { skip: 'muted' };
  if (!wanted.includes(reminder)) return { skip: 'not_wanted' };
  if (input.shown) return { skip: 'shown' };
  if (input.sent) return { skip: 'sent' };
  const devices = input.devices.filter(device => device.signedIn && !device.paused).map(device => device.id);
  return devices.length ? { send: pushReminderKind(reminder), devices } : { skip: 'no_device' };
}
