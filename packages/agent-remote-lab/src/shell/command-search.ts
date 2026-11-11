export type CommandKind = 'action' | 'window' | 'bot' | 'session';
export type CommandItem = { id: string; kind: CommandKind; title: string; subtitle?: string; keywords?: readonly string[]; shortcut?: string; run(): void };

/** The order kinds are listed and grouped in: actions, Windows, Bots, sessions. */
export const commandKinds: readonly CommandKind[] = ['action', 'window', 'bot', 'session'];
const kindOrder: Record<CommandKind, number> = { action: 0, window: 1, bot: 2, session: 3 };
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** How well one query word matches a title: 3 title prefix, 2 word prefix, 1 substring, 0 none. */
function wordScore(title: string, word: string): number {
  if (title.startsWith(word)) return 3;
  if (title.split(/[^\p{L}\p{N}]+/u).some(part => part.startsWith(word))) return 2;
  return title.includes(word) ? 1 : 0;
}

/**
 * The palette's results for a query: every query word must appear in the title, subtitle or keywords. Results rank by how
 * the words meet the title (title prefix, then word prefix, then substring; a word found only in the subtitle or keywords
 * adds nothing), then by kind (actions, Windows, Bots, sessions), then by the order given, so equal matches never reorder.
 * Each kind keeps at most `perKind` results. An empty query returns the items in kind order, so the caller's order
 * (for example recent use) holds within each kind.
 */
export function searchCommands(items: readonly CommandItem[], query: string, { perKind = 8 }: { perKind?: number } = {}): CommandItem[] {
  const words = fold(query).trim().split(/\s+/).filter(Boolean);
  const ranked = items.map((item, index) => {
    const title = fold(item.title), rest = fold([item.subtitle ?? '', ...(item.keywords ?? [])].join(' '));
    let score = 0;
    for (const word of words) {
      const inTitle = wordScore(title, word);
      if (!inTitle && !rest.includes(word)) return undefined;
      score += inTitle;
    }
    return { item, index, score };
  }).filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => b.score - a.score || kindOrder[a.item.kind] - kindOrder[b.item.kind] || a.index - b.index);
  const counts = new Map<CommandKind, number>();
  return ranked.filter(({ item }) => { const count = counts.get(item.kind) ?? 0; counts.set(item.kind, count + 1); return count < perKind; }).map(entry => entry.item);
}
