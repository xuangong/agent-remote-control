// The per-session connection words that target T5 forbids on the page (IM session service design, T5; I1 plan, section 4.3).
// One list for every consumer: the E9 flow, the smoke invariant, the local runners and the component specs.
// Matching ignores case, so a sentence such as "Native runtime is reconnecting" counts as well.

export const SESSION_CONNECTION_WORDS = Object.freeze([
  'Opening session',
  'Checking access',
  'Synchronizing',
  'Reconnecting',
  'Restoring',
  'Awaiting Agent',
  'Start with a Provider',
  'Loading conversation',
]);

const escape = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const SESSION_CONNECTION_PATTERN = new RegExp(`\\b(?:${SESSION_CONNECTION_WORDS.map(escape).join('|')})\\b`, 'i');

/** The words of the list that a text contains, in list order. */
export function sessionConnectionWordsIn(text) {
  const lower = String(text).toLowerCase();
  return SESSION_CONNECTION_WORDS.filter(word => new RegExp(`\\b${escape(word.toLowerCase())}\\b`).test(lower));
}
