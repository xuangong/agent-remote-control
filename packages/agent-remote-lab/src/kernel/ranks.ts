/** Ranks are fractional indexes: lowercase letters and digits that compare as strings and never end in 0 (the protocol's `rank`). */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const RANK_LIMIT = 64;
/** A rank strictly between two others (fractional indexing over [0-9a-z], never ending in 0); `after` absent means the end. */
function midpoint(before: string, after: string | undefined): string {
  if (after !== undefined) {
    let shared = 0;
    while ((before[shared] ?? '0') === after[shared]) shared++;
    if (shared > 0) return after.slice(0, shared) + midpoint(before.slice(shared), after.slice(shared));
  }
  const low = before ? DIGITS.indexOf(before[0]!) : 0, high = after !== undefined ? DIGITS.indexOf(after[0]!) : DIGITS.length;
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;
  if (after !== undefined && after.length > 1) return after.slice(0, 1);
  return DIGITS[low]! + midpoint(before.slice(1), undefined);
}
/** A rank between `before` (absent: the start) and `after` (absent: the end), or undefined when the two leave no room. */
export function rankBetween(before: string | undefined, after: string | undefined): string | undefined {
  if (before !== undefined && after !== undefined && before >= after) return undefined;
  const rank = midpoint(before ?? '', after);
  return rank.length <= RANK_LIMIT && /^[0-9a-z]*[1-9a-z]$/.test(rank) ? rank : undefined;
}
