export interface ReturnKeyFacts {
  /** The primary pointer is a finger: Return is a line break and the send button sends. */
  coarsePointer: boolean;
  shift: boolean;
  /** An input method is composing text; its Return confirms a candidate. */
  composing: boolean;
  /** Command or Control is held; a hardware keyboard on a touch device sends with it. */
  modifier: boolean;
}

export type ReturnKeyAction = 'send' | 'newline' | 'ignore';

export function returnKeyAction(facts: ReturnKeyFacts): ReturnKeyAction {
  if (facts.composing) return 'ignore';
  if (facts.coarsePointer) return facts.modifier ? 'send' : 'newline';
  return facts.shift ? 'newline' : 'send';
}

/** Read when a key arrives, so a keyboard attached to a tablet is honoured as soon as it is used. */
export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
}
