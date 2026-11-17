// A small seeded generator (mulberry32), so a fault schedule and the loss pattern of a run replay from its seed.
export function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    /** A number in [0, 1). */
    next,
    /** An integer in [low, high]. */
    int: (low, high) => low + Math.floor(next() * (high - low + 1)),
    /** A member of the list. */
    pick: list => list[Math.floor(next() * list.length)],
  };
}
