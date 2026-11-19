export const SESSION_CONNECTION_WORDS: readonly string[];
export const SESSION_CONNECTION_PATTERN: RegExp;
/** The words of the list that a text contains, in list order. */
export function sessionConnectionWordsIn(text: string): string[];
