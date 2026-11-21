import { describe, expect, it } from 'vitest';
import { canSettle, SEND_STATES, transition, type SendEvent, type SendState } from './send-state.js';

// Every order of up to four events that can reach one pending message, from the moment it leaves the composer, checked against the
// contract of the send state after every step. A broken order prints its exact sequence.

const events: Record<string, SendEvent> = {
  ack: { type: 'acknowledged', handled: false },
  'ack-handled': { type: 'acknowledged', handled: true },
  'dropped-maybe-arrived': { type: 'send_failed', uncertain: true, newAttempt: false, reason: 'Connection lost' },
  'dropped-new-attempt': { type: 'send_failed', uncertain: true, newAttempt: true, reason: 'Controller stopped' },
  refused: { type: 'send_failed', uncertain: false, newAttempt: false, reason: 'A terminal holds this session.' },
  echo: { type: 'echoed' },
  'history-rewritten': { type: 'history_changed' },
  'page-reloaded': { type: 'restored' },
  retry: { type: 'retry' },
};

/** The clauses of the send state (header of send-state.ts) one step must keep; empty when it kept them all. */
function broken(before: SendState, name: string, after: SendState | 'delivered'): string[] {
  const event = events[name]!;
  const problems: string[] = [];
  if (after !== 'delivered' && !SEND_STATES.includes(after)) problems.push('a step lands in a known state');
  if (before === 'failed' && ['ack', 'echo', 'history-rewritten'].includes(name) && after !== 'failed') problems.push('failed is never changed by an acknowledgement, an echo or a history rewrite');
  if (before === 'unconfirmed' && name === 'ack' && after !== 'unconfirmed') problems.push('an acknowledgement never lifts unconfirmed: only an echo settles it');
  if (after === 'delivered' && !(name === 'echo' && before !== 'failed') && !(event.type === 'acknowledged' && event.handled)) problems.push('only an echo or a command the Host handled delivers a message');
  if (name === 'retry' && (canSettle(before) ? after !== 'sending' : after !== before)) problems.push('only failed and unconfirmed may be retried, and a retry sends again');
  if (name === 'refused' && after !== 'failed') problems.push('a refusal fails the message');
  return problems;
}

function* orders(length: number): Generator<string[]> {
  if (length === 0) { yield []; return; }
  for (const head of Object.keys(events)) for (const tail of orders(length - 1)) yield [head, ...tail];
}

describe('one pending message, in every order of four events', () => {
  it('keeps the send-state contract after every step', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const order of orders(4)) {
      checked += 1;
      let state: SendState = 'sending';
      for (const [at, name] of order.entries()) {
        const step = transition(state, events[name]!);
        for (const problem of broken(state, name, step.state)) failures.push(`${order.slice(0, at + 1).join(' > ')}: ${problem}`);
        if (step.state === 'delivered') break;
        state = step.state;
      }
    }
    expect(checked).toBe(Object.keys(events).length ** 4);
    expect(failures.slice(0, 5)).toEqual([]);
  });
  it('lets the reader settle every message that is neither delivered nor on its way: retry or delete', () => {
    const stuck: string[] = [];
    for (const order of orders(3)) {
      let state: SendState | 'delivered' = 'sending';
      for (const name of order) { if (state === 'delivered') break; state = transition(state, events[name]!).state; }
      // A message that waits for nothing the Host will still send must be in the reader's hands.
      if (state !== 'delivered' && state !== 'sending' && state !== 'awaiting_echo' && !canSettle(state)) stuck.push(`${order.join(' > ')}: ${state}`);
    }
    expect(stuck).toEqual([]);
  });
});
