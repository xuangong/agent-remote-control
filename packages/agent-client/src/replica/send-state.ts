/**
 * The send state of one pending message: what the client knows about a message it sent, until its echo settles it. A pure
 * transition table over four states and `describe` for the plain words a reader sees. It holds no clock, storage or
 * transport; the caller applies the step it returns.
 *
 * Contract (seam S6, `docs/current/agent-remote/seams.md`):
 * - `sending`: the message left the composer and the Relay has not answered. Shown as "Sending…". With a next-turn delivery
 *   the words change once it is acknowledged ("Queued").
 * - `awaiting_echo`: the Host accepted it; the conversation has not shown it yet. It is settled (`delivered`, the pending
 *   message is removed) by its echo in the timeline, or at once when the Host handled it as a command.
 * - `unconfirmed`: delivery is uncertain (a timeout, a dropped connection, a stop, an outcome the Host cannot report, a
 *   history rewrite, or a reload before the echo). The reader checks the conversation, then retries or deletes. An
 *   acknowledgement never lifts it: only an echo settles it.
 * - `failed`: the Host refused it. The reader retries or deletes.
 * - Only `failed` and `unconfirmed` may be retried or deleted. A retry sends the same operation again when the first attempt is
 *   uncertain, its place in the conversation is still held and the Host can run it again; otherwise it is a new operation.
 * - `failed` is never changed by an acknowledgement, an echo or a history rewrite (an echo of a failed message is not matched).
 */
import { translator, type Translate } from '../presentation/messages.js';
export type SendState = 'sending' | 'awaiting_echo' | 'unconfirmed' | 'failed';

export const SEND_STATES: readonly SendState[] = ['sending', 'awaiting_echo', 'unconfirmed', 'failed'];

export type SendEvent =
  /** The Host accepted the send; `handled` is true when it ran it as a command, so no echo will come. */
  | { type: 'acknowledged'; handled: boolean }
  /** The send ended without an acknowledgement. `uncertain`: the message may have arrived; `newAttempt`: the Host will not run this operation again. */
  | { type: 'send_failed'; uncertain: boolean; newAttempt: boolean; reason: string }
  /** The message's echo is in the timeline. */
  | { type: 'echoed' }
  /** The row the message was sent after is gone from the replica's timeline. */
  | { type: 'history_changed' }
  /** The page loaded the message back from storage. */
  | { type: 'restored'; error?: string }
  /** The reader retries it. */
  | { type: 'retry' };

export interface SendStep {
  /** The next state, or `delivered` when the message leaves the pending list. */
  readonly state: SendState | 'delivered';
  /** The words to keep with the message: a text to set, `null` to clear, absent to keep what it has. */
  readonly error?: string | null;
  /** Whether a retry must be a new operation: a value to set, absent to keep. */
  readonly retryRequiresNewOperation?: boolean;
}

const HISTORY_CHANGED = 'Conversation history changed before delivery could be confirmed.';
const RESTORED = 'Delivery was not confirmed before this page closed. Check the conversation before retrying.';
const NEW_ATTEMPT = 'This message may not have arrived. If it is not in the conversation, Retry sends it again.';
const UNCERTAIN = 'Delivery is not confirmed. Check the conversation before sending again.';

export function transition(state: SendState, event: SendEvent): SendStep {
  switch (event.type) {
    case 'acknowledged':
      if (event.handled) return { state: 'delivered' };
      if (state === 'failed') return { state };
      return state === 'unconfirmed' ? { state } : { state: 'awaiting_echo', error: null };
    case 'send_failed':
      return {
        state: event.uncertain ? 'unconfirmed' : 'failed',
        error: event.newAttempt ? NEW_ATTEMPT : event.uncertain ? UNCERTAIN : event.reason,
        retryRequiresNewOperation: event.newAttempt,
      };
    case 'echoed':
      return state === 'failed' ? { state } : { state: 'delivered' };
    case 'history_changed':
      return state === 'failed' || state === 'unconfirmed' ? { state } : { state: 'unconfirmed', error: HISTORY_CHANGED };
    case 'restored':
      return { state: state === 'failed' ? 'failed' : 'unconfirmed', error: event.error ?? RESTORED };
    case 'retry':
      return canSettle(state) ? { state: 'sending', error: null, retryRequiresNewOperation: false } : { state };
  }
}

/** Whether the reader may retry or delete the message. */
export function canSettle(state: SendState): boolean {
  return state === 'failed' || state === 'unconfirmed';
}

/** Whether the message waits for its echo and may be looked for in the history. */
export function awaitsEcho(state: SendState): boolean {
  return state === 'awaiting_echo';
}

/**
 * A retry sends the same operation again only when the first attempt is uncertain, did not need a new attempt, still has its
 * place in the conversation, and has an operation to repeat; every other retry is a new operation.
 */
export function retriesSameOperation(message: { state: SendState; retryRequiresNewOperation?: boolean; placeHeld: boolean; hasOperation: boolean }): boolean {
  return message.state === 'unconfirmed' && !message.retryRequiresNewOperation && message.placeHeld && message.hasOperation;
}

export interface SendWords {
  /** The one line the reader sees next to the message. */
  readonly label: string;
  /** Delivery ended or is in doubt: the reader sees the error and the Retry and Delete actions. */
  readonly settled: boolean;
  /** The state a page exposes for styling and tests: the settled state itself, or `pending`. */
  readonly deliveryState: SendState | 'pending';
}

export function describe(state: SendState, delivery?: 'immediate' | 'next_turn', t: Translate = translator('en')): SendWords {
  const settled = canSettle(state);
  const label = t(state === 'failed' ? 'client.send.failed'
    : state === 'unconfirmed' ? 'client.send.unconfirmed'
    : state === 'sending' ? 'client.send.sending'
    : delivery === 'next_turn' ? 'client.send.queued' : 'client.send.sent');
  return { label, settled, deliveryState: settled ? state : 'pending' };
}
