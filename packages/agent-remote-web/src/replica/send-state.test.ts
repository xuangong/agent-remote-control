import { describe as suite, expect, it } from 'vitest';

import { awaitsEcho, canSettle, describe, retriesSameOperation, SEND_STATES, transition, type SendEvent, type SendState, type SendStep } from './send-state.js';

const NEW_ATTEMPT = 'This message may not have arrived. If it is not in the conversation, Retry sends it again.';
const UNCERTAIN = 'Delivery is not confirmed. Check the conversation before sending again.';
const HISTORY = 'Conversation history changed before delivery could be confirmed.';
const RESTORED = 'Delivery was not confirmed before this page closed. Check the conversation before retrying.';

const rows: Array<{ name: string; from: SendState; event: SendEvent; step: SendStep }> = [
  // acknowledged
  { name: 'a sending message that is acknowledged waits for its echo and clears its error', from: 'sending', event: { type: 'acknowledged', handled: false }, step: { state: 'awaiting_echo', error: null } },
  { name: 'a message already waiting stays waiting when acknowledged again', from: 'awaiting_echo', event: { type: 'acknowledged', handled: false }, step: { state: 'awaiting_echo', error: null } },
  { name: 'an unconfirmed message stays unconfirmed when acknowledged, and only its echo settles it', from: 'unconfirmed', event: { type: 'acknowledged', handled: false }, step: { state: 'unconfirmed' } },
  { name: 'a failed message is not changed by an acknowledgement', from: 'failed', event: { type: 'acknowledged', handled: false }, step: { state: 'failed' } },
  { name: 'a command the Host handled leaves the list at once, whatever its state', from: 'sending', event: { type: 'acknowledged', handled: true }, step: { state: 'delivered' } },
  { name: 'a handled command leaves the list from unconfirmed too', from: 'unconfirmed', event: { type: 'acknowledged', handled: true }, step: { state: 'delivered' } },
  // send_failed
  { name: 'a refused send fails with the Host\'s words', from: 'sending', event: { type: 'send_failed', uncertain: false, newAttempt: false, reason: 'No access.' }, step: { state: 'failed', error: 'No access.', retryRequiresNewOperation: false } },
  { name: 'an uncertain send is unconfirmed and says to check the conversation', from: 'sending', event: { type: 'send_failed', uncertain: true, newAttempt: false, reason: 'timeout' }, step: { state: 'unconfirmed', error: UNCERTAIN, retryRequiresNewOperation: false } },
  { name: 'an uncertain send the Host will not run again needs a new attempt and says what Retry does', from: 'sending', event: { type: 'send_failed', uncertain: true, newAttempt: true, reason: 'x' }, step: { state: 'unconfirmed', error: NEW_ATTEMPT, retryRequiresNewOperation: true } },
  { name: 'a send that fails after it was accepted can still become unconfirmed', from: 'awaiting_echo', event: { type: 'send_failed', uncertain: true, newAttempt: false, reason: 'x' }, step: { state: 'unconfirmed', error: UNCERTAIN, retryRequiresNewOperation: false } },
  { name: 'a retry that is refused fails again', from: 'unconfirmed', event: { type: 'send_failed', uncertain: false, newAttempt: false, reason: 'Still no access.' }, step: { state: 'failed', error: 'Still no access.', retryRequiresNewOperation: false } },
  // echoed
  { name: 'an echo settles a sending message', from: 'sending', event: { type: 'echoed' }, step: { state: 'delivered' } },
  { name: 'an echo settles a waiting message', from: 'awaiting_echo', event: { type: 'echoed' }, step: { state: 'delivered' } },
  { name: 'an echo settles an unconfirmed message', from: 'unconfirmed', event: { type: 'echoed' }, step: { state: 'delivered' } },
  { name: 'an echo never settles a failed message', from: 'failed', event: { type: 'echoed' }, step: { state: 'failed' } },
  // history_changed
  { name: 'a rewritten history makes a sending message unconfirmed', from: 'sending', event: { type: 'history_changed' }, step: { state: 'unconfirmed', error: HISTORY } },
  { name: 'a rewritten history makes a waiting message unconfirmed', from: 'awaiting_echo', event: { type: 'history_changed' }, step: { state: 'unconfirmed', error: HISTORY } },
  { name: 'a rewritten history leaves an unconfirmed message and its words as they are', from: 'unconfirmed', event: { type: 'history_changed' }, step: { state: 'unconfirmed' } },
  { name: 'a rewritten history leaves a failed message as it is', from: 'failed', event: { type: 'history_changed' }, step: { state: 'failed' } },
  // restored
  { name: 'a sending message loaded after a reload is unconfirmed with the reload words', from: 'sending', event: { type: 'restored' }, step: { state: 'unconfirmed', error: RESTORED } },
  { name: 'a waiting message loaded after a reload is unconfirmed', from: 'awaiting_echo', event: { type: 'restored' }, step: { state: 'unconfirmed', error: RESTORED } },
  { name: 'an unconfirmed message keeps the words it was saved with', from: 'unconfirmed', event: { type: 'restored', error: 'Saved words.' }, step: { state: 'unconfirmed', error: 'Saved words.' } },
  { name: 'a failed message stays failed after a reload and keeps its words', from: 'failed', event: { type: 'restored', error: 'No access.' }, step: { state: 'failed', error: 'No access.' } },
  // retry
  { name: 'a failed message is retried as sending, with no error and no new attempt owed', from: 'failed', event: { type: 'retry' }, step: { state: 'sending', error: null, retryRequiresNewOperation: false } },
  { name: 'an unconfirmed message is retried as sending', from: 'unconfirmed', event: { type: 'retry' }, step: { state: 'sending', error: null, retryRequiresNewOperation: false } },
  { name: 'a sending message cannot be retried', from: 'sending', event: { type: 'retry' }, step: { state: 'sending' } },
  { name: 'a waiting message cannot be retried', from: 'awaiting_echo', event: { type: 'retry' }, step: { state: 'awaiting_echo' } },
];

suite('the send state table', () => {
  it.each(rows.map(row => [row.name, row] as const))('%s', (_name, { from, event, step }) => {
    expect(transition(from, event)).toEqual(step);
  });

  it('has a row for every state and every event', () => {
    for (const state of SEND_STATES) expect(new Set(rows.filter(row => row.from === state).map(row => row.event.type)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(rows.map(row => row.event.type))).toEqual(new Set(['acknowledged', 'send_failed', 'echoed', 'history_changed', 'restored', 'retry']));
  });
});

suite('who may retry or delete, and what Retry repeats', () => {
  it('lets only a failed or an unconfirmed message be retried or deleted', () => {
    expect(SEND_STATES.filter(canSettle)).toEqual(['unconfirmed', 'failed']);
  });

  it('looks for an echo only for a message that waits for one', () => {
    expect(SEND_STATES.filter(awaitsEcho)).toEqual(['awaiting_echo']);
  });

  it.each([
    ['an unconfirmed message whose place is held and that has an operation', { state: 'unconfirmed' as const, placeHeld: true, hasOperation: true }, true],
    ['one that owes a new attempt', { state: 'unconfirmed' as const, retryRequiresNewOperation: true, placeHeld: true, hasOperation: true }, false],
    ['one whose place in the conversation is gone', { state: 'unconfirmed' as const, placeHeld: false, hasOperation: true }, false],
    ['one with no operation to repeat', { state: 'unconfirmed' as const, placeHeld: true, hasOperation: false }, false],
    ['a failed message', { state: 'failed' as const, placeHeld: true, hasOperation: true }, false],
  ])('%s: same operation is %s', (_name, message, same) => {
    expect(retriesSameOperation(message)).toBe(same);
  });
});

suite('the words a reader sees', () => {
  it.each([
    ['sending', undefined, 'Sending…', false, 'pending'],
    ['awaiting_echo', undefined, 'Sent — waiting for conversation…', false, 'pending'],
    ['awaiting_echo', 'immediate', 'Sent — waiting for conversation…', false, 'pending'],
    ['awaiting_echo', 'next_turn', 'Queued — waiting for conversation…', false, 'pending'],
    ['sending', 'next_turn', 'Sending…', false, 'pending'],
    ['unconfirmed', undefined, 'Delivery not confirmed', true, 'unconfirmed'],
    ['failed', undefined, 'Send failed', true, 'failed'],
  ] as const)('%s with %s delivery reads "%s"', (state, delivery, label, settled, deliveryState) => {
    expect(describe(state, delivery)).toEqual({ label, settled, deliveryState });
  });
});
