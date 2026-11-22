import type { PushDecision, PushDecisionInput } from './push-decision.js';

/** The account's one phone, signed in with its switch on, and the base case every row changes one thing of. */
const PHONE = { id: 'phone', signedIn: true };
const GROUP = { bots: { rank: 'm', members: {} } };
const BASE: PushDecisionInput = { before: 'running', state: 'waiting', assistant: { group: GROUP, details: {} }, shown: false, sent: false, devices: [PHONE] };
const row = (name: string, change: Partial<PushDecisionInput>, decision: PushDecision) => ({ name, input: { ...BASE, ...change }, decision });

/** Whether the Relay pushes, and to whom: one row per rule of `decidePush`, read by `push-decision.test.ts`. */
export const PUSH_DECISION_VECTORS: readonly { readonly name: string; readonly input: PushDecisionInput; readonly decision: PushDecision }[] = [
  row('an assistant that starts waiting needs you', {}, { send: 'needs_you', devices: ['phone'] }),
  row('one that finishes working finished', { before: 'running', state: 'idle' }, { send: 'finished', devices: ['phone'] }),
  row('waiting after an idle session started needs you too', { before: 'idle', state: 'waiting' }, { send: 'needs_you', devices: ['phone'] }),
  row('the first state seen is no news', { before: undefined }, { skip: 'no_change' }),
  row('a session that starts running sends nothing', { before: 'idle', state: 'running' }, { skip: 'no_change' }),
  row('a turn that failed sends nothing', { before: 'running', state: 'failed' }, { skip: 'no_change' }),
  row('an answered approval sends nothing', { before: 'waiting', state: 'running' }, { skip: 'no_change' }),
  row('the same state again sends nothing', { before: 'waiting', state: 'waiting' }, { skip: 'no_change' }),
  row('a session in none of the account\'s groups has no name to remind of', { assistant: undefined }, { skip: 'no_assistant' }),
  row('a muted chat sends nothing', { assistant: { group: GROUP, details: { muted: true } } }, { skip: 'muted' }),
  row('a chat in a muted group sends nothing', { assistant: { group: { bots: { ...GROUP.bots, muted: true } }, details: {} } }, { skip: 'muted' }),
  row('a group that asks only for needs you sends it', { assistant: { group: { bots: { ...GROUP.bots, notifications: 'needs_you' } } } }, { send: 'needs_you', devices: ['phone'] }),
  row('and not finished', { state: 'idle', assistant: { group: { bots: { ...GROUP.bots, notifications: 'needs_you' } } } }, { skip: 'not_wanted' }),
  row('a group that asks for all sends finished', { state: 'idle', assistant: { group: { bots: { ...GROUP.bots, notifications: 'all' } } } }, { send: 'finished', devices: ['phone'] }),
  row('nothing while a visible page of the account shows the session', { shown: true }, { skip: 'shown' }),
  row('one push per session and state', { sent: true }, { skip: 'sent' }),
  row('every device of the account that wants it', { devices: [PHONE, { id: 'desk', signedIn: true }] }, { send: 'needs_you', devices: ['phone', 'desk'] }),
  row('not a device whose own switch is off', { devices: [PHONE, { id: 'desk', signedIn: true, paused: true }] }, { send: 'needs_you', devices: ['phone'] }),
  row('not a device that signed out', { devices: [{ id: 'phone', signedIn: false }, { id: 'desk', signedIn: true }] }, { send: 'needs_you', devices: ['desk'] }),
  row('no device left is no push', { devices: [{ id: 'phone', signedIn: false }, { id: 'desk', signedIn: true, paused: true }] }, { skip: 'no_device' }),
  row('an account with no device subscribed', { devices: [] }, { skip: 'no_device' }),
  row('mute comes before a page showing it', { shown: true, assistant: { group: GROUP, details: { muted: true } } }, { skip: 'muted' }),
];
