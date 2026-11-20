import type { AssistantFacts, AssistantState, AssistantMood } from './assistant-status.js';

/**
 * The precedence of an assistant's status as named rows: facts in, state, English sentence and mood out. Read by
 * `assistant-status.test.ts`. Every pairwise conflict between neighbouring states has a row.
 */
export interface AssistantStatusVector {
  readonly name: string;
  readonly facts: Partial<AssistantFacts>;
  readonly state: AssistantState;
  readonly sentence: string;
  readonly mood: AssistantMood;
}

const HOST_OFFLINE = 'Mac mini is offline. Messages go when it is back';
const HOST_UNNAMED = 'The Host is offline. Messages go when it is back';

export const ASSISTANT_STATUS_VECTORS: readonly AssistantStatusVector[] = [
  { name: 'waiting asks the person', facts: { activity: 'waiting' }, state: 'needs_you', sentence: 'Wants to ask you something', mood: 'needs_you' },
  { name: 'needs you beats an offline Host', facts: { activity: 'waiting', host: { online: false, name: 'Mac mini' }, notice: { kind: 'host_offline', hostName: 'Mac mini' } }, state: 'needs_you', sentence: 'Wants to ask you something', mood: 'needs_you' },
  { name: 'needs you beats resting', facts: { activity: 'waiting', asleep: true }, state: 'needs_you', sentence: 'Wants to ask you something', mood: 'needs_you' },
  { name: 'needs you beats a failure notice', facts: { activity: 'waiting', notice: { kind: 'failed', message: 'x' } }, state: 'needs_you', sentence: 'Wants to ask you something', mood: 'needs_you' },
  { name: 'a named Host offline by its notice', facts: { activity: 'idle', notice: { kind: 'host_offline', hostName: 'Mac mini' } }, state: 'host_offline', sentence: HOST_OFFLINE, mood: 'idle' },
  { name: 'a named Host offline by the Host fact', facts: { activity: 'running', host: { online: false, name: 'Mac mini' } }, state: 'host_offline', sentence: HOST_OFFLINE, mood: 'idle' },
  { name: 'the notice names the Host before the Host fact', facts: { activity: 'idle', host: { online: false, name: 'Studio' }, notice: { kind: 'host_offline', hostName: 'Mac mini' } }, state: 'host_offline', sentence: HOST_OFFLINE, mood: 'idle' },
  { name: 'an unnamed Host offline', facts: { activity: 'idle', host: { online: false } }, state: 'host_offline', sentence: HOST_UNNAMED, mood: 'idle' },
  { name: 'an offline activity is an offline Host', facts: { activity: 'offline' }, state: 'host_offline', sentence: HOST_UNNAMED, mood: 'idle' },
  { name: 'a notice without a name falls back to the Host fact', facts: { activity: 'idle', host: { online: false, name: 'Mac mini' }, notice: { kind: 'host_offline' } }, state: 'host_offline', sentence: HOST_OFFLINE, mood: 'idle' },
  { name: 'an offline Host beats failed', facts: { activity: 'failed', host: { online: false, name: 'Mac mini' } }, state: 'host_offline', sentence: HOST_OFFLINE, mood: 'idle' },
  { name: 'an offline Host beats resting', facts: { activity: 'idle', asleep: true, host: { online: false } }, state: 'host_offline', sentence: HOST_UNNAMED, mood: 'idle' },
  { name: 'an offline Host beats working', facts: { activity: 'running', host: { online: false } }, state: 'host_offline', sentence: HOST_UNNAMED, mood: 'idle' },
  { name: 'an online Host changes nothing', facts: { activity: 'idle', host: { online: true, name: 'Mac mini' } }, state: 'idle', sentence: 'Ready when you are', mood: 'idle' },
  { name: 'a failed activity', facts: { activity: 'failed' }, state: 'failed', sentence: 'Something went wrong', mood: 'idle' },
  { name: 'a failed notice', facts: { activity: 'idle', notice: { kind: 'failed', message: 'boom' } }, state: 'failed', sentence: 'Something went wrong', mood: 'idle' },
  { name: 'an unavailable notice', facts: { activity: 'idle', notice: { kind: 'unavailable', message: 'gone' } }, state: 'failed', sentence: 'Something went wrong', mood: 'idle' },
  { name: 'failed beats resting', facts: { activity: 'failed', asleep: true }, state: 'failed', sentence: 'Something went wrong', mood: 'idle' },
  { name: 'failed beats ended', facts: { activity: 'closed', notice: { kind: 'failed', message: 'x' } }, state: 'failed', sentence: 'Something went wrong', mood: 'idle' },
  { name: 'a closed activity', facts: { activity: 'closed' }, state: 'ended', sentence: 'This conversation has ended', mood: 'idle' },
  { name: 'an ended notice', facts: { activity: 'idle', notice: { kind: 'ended' } }, state: 'ended', sentence: 'This conversation has ended', mood: 'idle' },
  { name: 'ended beats resting', facts: { activity: 'closed', asleep: true }, state: 'ended', sentence: 'This conversation has ended', mood: 'idle' },
  { name: 'ended beats waiting to send', facts: { activity: 'closed', waitingToSend: true }, state: 'ended', sentence: 'This conversation has ended', mood: 'idle' },
  { name: 'asleep and idle rests', facts: { activity: 'idle', asleep: true }, state: 'resting', sentence: 'Resting. Wakes when you need it', mood: 'resting' },
  { name: 'asleep beats running', facts: { activity: 'running', asleep: true }, state: 'resting', sentence: 'Resting. Wakes when you need it', mood: 'resting' },
  { name: 'asleep beats waiting to send', facts: { activity: 'idle', asleep: true, waitingToSend: true }, state: 'resting', sentence: 'Resting. Wakes when you need it', mood: 'resting' },
  { name: 'running works', facts: { activity: 'running' }, state: 'working', sentence: 'Working on it', mood: 'working' },
  { name: 'starting works', facts: { activity: 'starting' }, state: 'working', sentence: 'Working on it', mood: 'working' },
  { name: 'working beats waiting to send', facts: { activity: 'running', waitingToSend: true }, state: 'working', sentence: 'Working on it', mood: 'working' },
  { name: 'working beats the reply preview', facts: { activity: 'running', replyPreview: 'Done' }, state: 'working', sentence: 'Working on it', mood: 'working' },
  { name: 'an outbox entry waits', facts: { activity: 'idle', waitingToSend: true }, state: 'waiting_to_send', sentence: 'Will send when it is ready', mood: 'idle' },
  { name: 'waiting to send beats the reply preview', facts: { activity: 'idle', waitingToSend: true, replyPreview: 'Done' }, state: 'waiting_to_send', sentence: 'Will send when it is ready', mood: 'idle' },
  { name: 'waiting to send with an unknown activity', facts: { activity: 'unknown', waitingToSend: true }, state: 'waiting_to_send', sentence: 'Will send when it is ready', mood: 'idle' },
  { name: 'idle says the last reply, tidied', facts: { activity: 'idle', replyPreview: '  Notes are\n  in notes.md  ' }, state: 'idle', sentence: 'Notes are in notes.md', mood: 'idle' },
  { name: 'idle without a reply is ready', facts: { activity: 'idle' }, state: 'idle', sentence: 'Ready when you are', mood: 'idle' },
  { name: 'idle with a blank reply is ready', facts: { activity: 'idle', replyPreview: ' \n ' }, state: 'idle', sentence: 'Ready when you are', mood: 'idle' },
  { name: 'unknown says the last reply', facts: { activity: 'unknown', replyPreview: 'Notes are in notes.md' }, state: 'unknown', sentence: 'Notes are in notes.md', mood: 'idle' },
  { name: 'unknown without a reply says nothing', facts: { activity: 'unknown' }, state: 'unknown', sentence: '', mood: 'idle' },
  { name: 'a terminal in control does not change idle', facts: { activity: 'idle', notice: { kind: 'terminal_in_control' } }, state: 'idle', sentence: 'Ready when you are', mood: 'idle' },
  { name: 'another controller does not change working', facts: { activity: 'running', notice: { kind: 'other_controller' } }, state: 'working', sentence: 'Working on it', mood: 'working' },
  { name: 'read only does not change idle', facts: { activity: 'idle', replyPreview: 'Hi', notice: { kind: 'read_only' } }, state: 'idle', sentence: 'Hi', mood: 'idle' },
  { name: 'an unavailable agent does not change unknown', facts: { activity: 'unknown', notice: { kind: 'agent_unavailable', message: 'x' } }, state: 'unknown', sentence: '', mood: 'idle' },
];
