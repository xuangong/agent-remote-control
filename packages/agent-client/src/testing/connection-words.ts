/**
 * The per-session connection words that target T5 forbids on the page (I1 plan, section 4.3): the one list. agent-e2e's
 * `faults/connection-words.mjs` re-exports it for the runners, the smoke invariant and the browser specs. Matching ignores
 * case and needs whole words, so "Native runtime is reconnecting" and "Reconnect to take control" both count.
 */
export const SESSION_CONNECTION_WORDS: readonly string[] = Object.freeze([
  'Opening session', 'Checking access', 'Synchronizing', 'Reconnecting', 'Reconnect', 'Restoring', 'Awaiting Agent', 'Start with a Provider', 'Loading conversation',
]);

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const SESSION_CONNECTION_PATTERN = new RegExp(`\\b(?:${SESSION_CONNECTION_WORDS.map(escape).join('|')})\\b`, 'i');

/** The words of the list that a text contains, in list order. */
export function sessionConnectionWordsIn(text: string): string[] {
  return SESSION_CONNECTION_WORDS.filter(word => new RegExp(`\\b${escape(word)}\\b`, 'i').test(text));
}
