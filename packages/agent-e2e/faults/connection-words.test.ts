import { describe, expect, it } from 'vitest';
import { SESSION_CONNECTION_PATTERN, SESSION_CONNECTION_WORDS, sessionConnectionWordsIn } from './connection-words.mjs';

const BUSINESS_LABELS = ['Ready', 'Working', 'Waiting for response', 'Starting', 'Closed', 'Agent failed', 'Host offline', 'Mac mini is offline. Messages will be delivered when it is back.', 'Sending', 'Native CLI has control', 'Taking control…'];

describe('the T5 connection words', () => {
  it('lists the nine per-session connection words once each', () => {
    expect(SESSION_CONNECTION_WORDS).toEqual(['Opening session', 'Checking access', 'Synchronizing', 'Reconnecting', 'Reconnect', 'Restoring', 'Awaiting Agent', 'Start with a Provider', 'Loading conversation']);
  });

  it.each(SESSION_CONNECTION_WORDS)('the pattern matches "%s" alone, inside a sentence and in lower case', word => {
    expect(SESSION_CONNECTION_PATTERN.test(word)).toBe(true);
    expect(SESSION_CONNECTION_PATTERN.test(`Status: ${word}…`)).toBe(true);
    expect(SESSION_CONNECTION_PATTERN.test(`native runtime is ${word.toLowerCase()}`)).toBe(true);
    expect(sessionConnectionWordsIn(`x ${word} y`)).toContain(word);
  });

  it.each(BUSINESS_LABELS)('the pattern does not match the business label "%s"', label => {
    expect(SESSION_CONNECTION_PATTERN.test(label)).toBe(false);
    expect(sessionConnectionWordsIn(label)).toEqual([]);
  });

  it('catches the imperative "Reconnect" as well as "Reconnecting"', () => {
    expect(SESSION_CONNECTION_PATTERN.test('Reconnect to take control.')).toBe(true);
    expect(sessionConnectionWordsIn('Reconnecting')).toEqual(['Reconnecting']);
  });

  it('does not match a word that only contains a listed word', () => {
    expect(SESSION_CONNECTION_PATTERN.test('Unrestoring')).toBe(false);
  });
});
