/** One entry of a conversation page, as far as telling turns apart needs: the turn it belongs to, else its type. */
interface TurnEntry { type?: string; turnId?: string }

/**
 * The entries of the last `turns` turns of a page, in the order they came. A turn is the entries that share a turn id; where entries
 * carry none, a turn starts at each message the person or another session wrote. At least one turn is kept.
 */
export function lastTurns<T extends TurnEntry>(entries: readonly T[], turns: number): T[] {
  const keep = Math.max(1, Math.floor(turns));
  let turn = 0, previous: string | undefined;
  const numbered = entries.map(entry => {
    const starts = entry.turnId === undefined ? entry.type === 'user_message' : entry.turnId !== previous;
    previous = entry.turnId ?? previous;
    if (starts || turn === 0) turn++;
    return { entry, turn };
  });
  const first = turn - keep + 1;
  return numbered.filter(item => item.turn >= first).map(item => item.entry);
}
