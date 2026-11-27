/**
 * What a view knows about a list it shows, and what it may say about it. A list is `unknown` until the device restores what it stored or the
 * Relay answers; `stored` after the device's copy was restored; `confirmed` once a load finished. Only a confirmed list may be called empty:
 * an unknown or stored-but-not-yet-confirmed list shows its last content, or a quiet shell, and never a sentence that says nothing is there.
 */
export type Knowledge = 'unknown' | 'stored' | 'confirmed';
export type KnowledgeEvent = 'restored' | 'confirmed' | 'failed';
/** What the list's place on screen shows: its items, the reserved quiet shell, or the empty-state words. */
export type ListPresentation = 'items' | 'quiet' | 'empty';

export function advanceKnowledge(knowledge: Knowledge, event: KnowledgeEvent): Knowledge {
  if (event === 'confirmed') return 'confirmed';
  // A restored copy never replaces a confirmed answer, and a failed load teaches nothing.
  if (event === 'restored') return knowledge === 'unknown' ? 'stored' : knowledge;
  return knowledge;
}

export function listPresentation(count: number, knowledge: Knowledge): ListPresentation {
  if (count > 0) return 'items';
  return knowledge === 'confirmed' ? 'empty' : 'quiet';
}
